/**
 * lib/meetingPipeline/recover.js — Salvage meeting jobs whose container died
 * mid-format while the opencode host session kept running (and usually
 * finished) the format stage.
 *
 * Two entry points:
 *  - buildRecoveryFromSession(job): derive {contract, pass1} from the job's
 *    persisted opencode session (prefers the job's persisted pass1Json for
 *    transcript/metadata; falls back to parsing the session prompt).
 *  - replayPostFormat(...): run the deterministic post-format steps (task
 *    notes, assemble, vault write, share URL). No DB writes here — callers
 *    own job-state transitions.
 *
 * Used by startup recovery (see startup.js) and by
 * scripts/recover-meeting-job.mjs for manual recovery.
 */

import path from 'path';
import fs from 'node:fs/promises';
import { writeNote } from '@/lib/vault';
import { triggerGbrainSync } from '@/lib/gbrainSync';
import config from '@/lib/config';
import {
  extractMetadataOnly,
  parsePass1Output,
  buildMeetingContext,
  contractActionItemsToTaskInputs,
  runPass4Assemble,
  runPassTranslateZh,
} from './passes';
import { parseAnalysisContract, isParseableContract } from './formatAgent';
import {
  runAgent,
  share,
  getSessionInfo,
  listSessionMessages,
} from './opencodeClient';
import { uniqueMeetingPath } from './filename';
import { createProposedTaskNotes } from './tasks';
import { loadMeetingVaultContext } from './vaultContext';

const PROMPT_TRANSCRIPT_MARKER = 'Cleaned transcript:';

/** Extract assistant/user text from an opencode message object. */
export function messageText(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

/** The last user prompt in a session (text + agent name), or null. */
export function lastUserPromptOf(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.info?.role !== 'user') continue;
    const text = messageText(m);
    if (text) return { text, agent: String(m.info.agent || '') };
  }
  return null;
}

/** The last non-empty assistant text in a session, or ''. */
export function lastAssistantTextOf(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.info?.role !== 'assistant') continue;
    const text = messageText(m);
    if (text) return text;
  }
  return '';
}

/**
 * Parse the "Meeting date:/Meeting type:/Topic:" headers the format-stage
 * prompt begins with (see formatAgent.buildPrompt).
 */
export function parsePromptHeaders(prompt) {
  const get = (key) => {
    const m = String(prompt || '').match(new RegExp(`^${key}:\\s*(.+)$`, 'mi'));
    return m ? m[1].trim() : '';
  };
  return {
    date: get('Meeting date'),
    type: get('Meeting type'),
    topic: get('Topic'),
  };
}

/** Slice the cleaned transcript out of a format-stage prompt. */
export function extractCleanedTranscript(prompt) {
  const text = String(prompt || '');
  const idx = text.lastIndexOf(PROMPT_TRANSCRIPT_MARKER);
  if (idx < 0) return '';
  return text.slice(idx + PROMPT_TRANSCRIPT_MARKER.length).trim();
}

/** Parse a persisted pass1Json value; null when absent or malformed. */
export function parsePersistedPass1(pass1Json) {
  if (!pass1Json) return null;
  try {
    const parsed = JSON.parse(pass1Json);
    return parsed?.cleanedTranscript ? parsed : null;
  } catch {
    return null;
  }
}

function parseMetaBlockText(metaText) {
  const m = String(metaText || '').match(
    /<!--\s*meeting-meta\s*([\s\S]*?)\s*-->/i,
  );
  if (!m) return {};
  try {
    return JSON.parse(m[1].trim());
  } catch {
    return {};
  }
}

/**
 * Rebuild a pass1 ({metadata, cleanedTranscript}) for a job whose format
 * prompt is embedded in its opencode session. Metadata beyond date/type/topic
 * (attendees/project/area/tags) is re-derived with one metadata-LLM call;
 * failures degrade to prompt headers only.
 */
export async function buildPass1FromPrompt({
  cleanedTranscript,
  headers,
  sourceName,
  uploadDate,
  vaultContext,
}) {
  let metaFromLlm = {};
  try {
    metaFromLlm = parseMetaBlockText(
      await extractMetadataOnly(cleanedTranscript, sourceName, {
        uploadDate,
        vaultContext,
      }),
    );
  } catch (error) {
    console.warn(
      '[meeting-recover] metadata re-derivation failed, using prompt headers only:',
      error.message,
    );
  }

  const rawMeta = {
    type: headers.type || metaFromLlm.type || '',
    topic: headers.topic || metaFromLlm.topic || '',
    attendees: metaFromLlm.attendees,
    project: metaFromLlm.project,
    area: metaFromLlm.area,
    tags: metaFromLlm.tags,
  };
  const syntheticPass1 = `<!-- meeting-meta\n${JSON.stringify(rawMeta)}\n-->\n\n${cleanedTranscript}`;
  return parsePass1Output(syntheticPass1, sourceName, uploadDate);
}

/**
 * Derive the recovery inputs for a job from its opencode session.
 *
 * @param {Object} job - Meeting job row (needs opencodeSessionId; pass1Json
 *   and audioName/createdAt used when present).
 * @param {Object} options
 * @param {AbortSignal} [options.signal] - aborts polling/re-prompt.
 * @param {number} [options.waitMs=0] - how long to wait for the host-side
 *   agent to finish generating before giving up (startup recovery passes a
 *   bounded window; manual recovery passes 0 and only reads what is there).
 * @param {boolean} [options.rePrompt=true] - when the last assistant reply
 *   does not parse as a contract, re-prompt the same session once.
 * @returns {Promise<{contract:Object, pass1:Object, sessionTitle:string, sessionID:string, agent:string}>}
 * @throws when the session cannot be salvaged.
 */
export async function buildRecoveryFromSession(job, options = {}) {
  const { signal, waitMs = 0, rePrompt = true } = options;
  const sessionID = job?.opencodeSessionId;
  if (!sessionID) throw new Error('job has no opencode session id');

  const { title, agent } = await getSessionInfo(sessionID);
  const messages = await listSessionMessages(sessionID, { signal });
  const promptMsg = lastUserPromptOf(messages);
  if (!promptMsg) throw new Error('no user prompt found in the session');

  let contractText = lastAssistantTextOf(messages);
  let parseable = false;
  const deadline = Date.now() + waitMs;
  while (!parseable) {
    if (isParseableContract(contractText)) {
      parseable = true;
    } else {
      if (Date.now() >= deadline) break;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(signal.reason || new Error('Aborted'));
          },
          { once: true },
        );
      });
      const fresh = await listSessionMessages(sessionID, { signal });
      const text = lastAssistantTextOf(fresh);
      if (text && text !== contractText) contractText = text;
    }
  }

  if (!parseable && rePrompt) {
    console.warn(
      '[meeting-recover] stored reply does not parse; re-prompting session',
      sessionID,
    );
    const { text } = await runAgent({
      agent: agent || promptMsg.agent || 'meeting-default',
      title: title || `Recovery: ${job.id}`,
      prompt: promptMsg.text,
      model: config.opencodeFormatterModel,
      sessionID,
      signal,
    });
    contractText = text;
    parseable = isParseableContract(text);
  }

  if (!parseable) {
    throw new Error('session has no parseable format contract');
  }

  const vaultContext = await loadMeetingVaultContext();

  const persisted = parsePersistedPass1(job.pass1Json);
  let pass1;
  if (persisted) {
    pass1 = persisted;
  } else {
    const cleanedTranscript = extractCleanedTranscript(promptMsg.text);
    if (!cleanedTranscript || cleanedTranscript.length < 500) {
      throw new Error(
        `could not extract cleaned transcript from session prompt (len=${cleanedTranscript.length})`,
      );
    }
    pass1 = await buildPass1FromPrompt({
      cleanedTranscript,
      headers: parsePromptHeaders(promptMsg.text),
      sourceName: job.audioName,
      uploadDate: job.createdAt,
      vaultContext,
    });
  }

  // Full validation runs only now that pass1 + vault context exist: entity
  // references resolve against the vault and evidence quotes locate against
  // the persisted cleaned transcript.
  const { analysis, contract } = parseAnalysisContract(contractText, {
    vaultContext,
    cleanedTranscript: pass1.cleanedTranscript,
    metadata: pass1.metadata,
    model: config.opencodeFormatterModel,
  });

  return {
    contract,
    analysis,
    pass1,
    vaultContext,
    sessionTitle: title,
    sessionID,
    agent,
  };
}

/**
 * Run the deterministic post-format steps for a recovered contract:
 * unique path → task notes → assemble → vault write → gbrain sync → share.
 *
 * With dryRun=true nothing is written to the vault / DB / opencode: the
 * assembled markdown goes to a preview file and task titles are returned.
 *
 * @returns {Promise<{ outputPath:string, shareUrl:string|null, taskLinks:Array, previewPath?:string, taskTitles?:string[] }>}
 */
export async function replayPostFormat({
  jobId,
  contract,
  analysis,
  pass1,
  vaultContext,
  sessionID,
  onStep,
  dryRun = false,
  previewDir = '/tmp',
}) {
  const outputPath = await uniqueMeetingPath(pass1.metadata.filename);
  const meetingBasename = path.basename(outputPath, '.md');
  const meetingContext = buildMeetingContext({
    metadata: pass1.metadata,
    cleanedTranscript: pass1.cleanedTranscript,
    summaryEn: contract.summary_en,
    vaultContext,
    analysis,
  });
  const taskInputs = contractActionItemsToTaskInputs(
    contract.action_items,
    vaultContext,
  );

  if (dryRun) {
    const markdown = runPass4Assemble({
      metadata: pass1.metadata,
      cleanedTranscript: pass1.cleanedTranscript,
      summaryZh: null,
      summaryEn: null,
      vaultContext,
      taskLinks: null,
      contract,
      analysis,
    });
    const previewPath = path.join(previewDir, `recover-${jobId}.md`);
    await fs.mkdir(path.dirname(previewPath), { recursive: true });
    await fs.writeFile(previewPath, markdown, 'utf8');
    return {
      outputPath,
      previewPath,
      taskTitles: taskInputs.map((t) => t.title),
    };
  }

  // Recovered v1 contracts carry no Chinese summary; translate on the light tier.
  const summaryZh = contract.summary_zh
    ? contract.summary_zh
    : await runPassTranslateZh(contract.summary_en);

  await onStep?.('tasks');
  let taskLinks = null;
  try {
    taskLinks = await createProposedTaskNotes({
      tasks: taskInputs,
      meetingBasename,
      project: meetingContext.project,
      area: meetingContext.area,
    });
  } catch (error) {
    console.error('[meeting-recover] task creation failed', jobId, error);
    taskLinks = null;
  }

  await onStep?.('assemble');
  const markdown = runPass4Assemble({
    metadata: pass1.metadata,
    cleanedTranscript: pass1.cleanedTranscript,
    summaryZh,
    summaryEn: null,
    vaultContext,
    taskLinks,
    contract,
    analysis,
  });

  await onStep?.('write');
  await writeNote(outputPath, markdown);
  triggerGbrainSync('meeting-note');

  const shareUrl = sessionID ? await share(sessionID).catch(() => null) : null;
  return { outputPath, shareUrl, taskLinks };
}

/**
 * Startup salvage: for each 'processing' job found after a container restart
 * that has an opencode session, wait (bounded) for the host-side agent to
 * finish, then replay the post-format steps and mark the job done.
 *
 * Non-blocking: each salvage runs in the background so container startup is
 * not delayed. Jobs that cannot be salvaged are left to the existing
 * markStaleJobsFailed path (they stay retryable; the persisted pass1 makes a
 * retry skip ASR).
 *
 * DB helpers are injected because this module is also imported by the
 * host-side recovery script, which must not pull in prisma.
 */
export async function recoverProcessingMeetingJobs({
  listProcessingMeetingJobs,
  findMeetingJob,
  updateMeetingJob,
  waitMs,
} = {}) {
  if (typeof listProcessingMeetingJobs !== 'function') return;
  if (
    typeof findMeetingJob !== 'function' ||
    typeof updateMeetingJob !== 'function'
  ) {
    console.error(
      '[meeting-recover] recoverProcessingMeetingJobs requires DB helpers',
    );
    return;
  }

  let jobs = [];
  try {
    jobs = await listProcessingMeetingJobs();
  } catch (error) {
    console.error('[meeting-recover] could not list processing jobs', error);
    return;
  }

  const candidates = jobs.filter((job) => job?.opencodeSessionId);
  for (const job of candidates) {
    salvageProcessingJob(job, {
      findMeetingJob,
      updateMeetingJob,
      waitMs,
    }).catch((error) => {
      console.error('[meeting-recover] salvage crashed', job.id, error);
    });
  }
  if (candidates.length > 0) {
    console.log(
      `[meeting-recover] attempting background salvage for ${candidates.length} interrupted job(s)`,
    );
  }
}

async function salvageProcessingJob(
  job,
  { findMeetingJob, updateMeetingJob, waitMs },
) {
  try {
    const { contract, analysis, pass1, vaultContext, sessionID } =
      await buildRecoveryFromSession(job, {
        waitMs: waitMs ?? config.opencodeTimeoutSec * 1000,
        rePrompt: false,
      });

    // Bail if the job moved on (requeued, cancelled, already done) while we
    // were waiting for the agent. A narrow check-then-write race with a
    // concurrent requeue remains possible but only costs a duplicate note.
    const current = await findMeetingJob(job.id);
    if (!['processing', 'failed'].includes(current?.status)) {
      console.log(
        '[meeting-recover] job state changed, skipping salvage',
        job.id,
        current?.status,
      );
      return;
    }

    await updateMeetingJob(job.id, {
      step: 'recover',
      updatedAt: new Date(),
      analysisJson: JSON.stringify(analysis),
    }).catch(() => {});

    const { outputPath, shareUrl } = await replayPostFormat({
      jobId: job.id,
      contract,
      analysis,
      pass1,
      vaultContext,
      sessionID,
      onStep: (step) =>
        updateMeetingJob(job.id, { step, updatedAt: new Date() }).catch(
          () => {},
        ),
    });

    await updateMeetingJob(job.id, {
      status: 'done',
      step: 'done',
      outputPath,
      error: null,
      finishedAt: new Date(),
      ...(shareUrl ? { opencodeShareUrl: shareUrl } : {}),
    });
    console.log('[meeting-recover] salvaged job', job.id, '→', outputPath);

    const { enqueueMeetingLintByFilepath } = await import('./linker');
    await enqueueMeetingLintByFilepath(outputPath).catch(() => {});

    const { enqueueEntityUpdates } = await import('./entityUpdates');
    enqueueEntityUpdates({
      id: job.id,
      analysisJson: JSON.stringify(analysis),
      outputPath,
    });
  } catch (error) {
    console.error(
      '[meeting-recover] salvage attempt failed (job stays failed; retry reuses pass1)',
      job.id,
      error,
    );
  }
}
