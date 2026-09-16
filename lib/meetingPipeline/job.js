import path from 'path';
import { writeNote } from '@/lib/vault';
import { triggerGbrainSync } from '@/lib/gbrainSync';
import config from '@/lib/config';
import { runAsr, runAsrFromTask } from './asr';
import { isClcfError, nextClcfRecovery } from './asrRecovery';
import {
  deleteObjects,
  listAudioKeys,
  presignObject,
  abortMultipartUpload,
  reconcileUpload,
  completeMultipartUpload,
  listParts,
  transcodeAudioToMp3,
} from './storage';
import {
  buildMeetingContext,
  contractActionItemsToTaskInputs,
  parseActionItems,
  runPass1Clean,
  runPass3En,
  runPass4Assemble,
  runPassTranslateZh,
} from './passes';
import {
  loadReusableAnalysis,
  contractFromAnalysis,
  upconvertV0Contract,
} from './analysis';
import {
  runFormatAgent,
  createSession,
  abortSession,
  opencodeTimeoutSignal,
  formatSessionTitle,
} from './formatAgent';
import { share, runAgent } from './opencodeClient';
import { uniqueMeetingPath } from './filename';
import {
  claimQueuedMeetingJob,
  findMeetingJob,
  listOrphanedAudioJobs,
  listStaleUploadJobs,
  updateMeetingJob,
  updateMeetingUpload,
} from './jobsDb';
import {
  loadMeetingVaultContext,
  expandParticipantsText,
} from './vaultContext';
import { createProposedTaskNotes, generateProposedTasks } from './tasks';
import { enqueueMeetingLintByFilepath } from './linker';
import { enqueueEntityUpdates } from './entityUpdates';

let workerStarted = false;
let isDraining = false;

async function throwIfCancelled(jobId) {
  const job = await findMeetingJob(jobId);
  if (job?.status === 'cancelled') {
    throw Object.assign(new Error('Job cancelled'), { cancelled: true });
  }
}

/**
 * Build an AbortSignal for an opencode call that:
 *  - times out after config.opencodeTimeoutSec, and
 *  - aborts if the meeting job is cancelled mid-call (polled).
 * Returns the signal plus a cleanup fn that must run in a finally block.
 */
function createCancellableSignal(jobId) {
  const controller = new AbortController();
  const timeoutSignal = opencodeTimeoutSignal();
  const combined = AbortSignal.any([controller.signal, timeoutSignal]);
  const timer = setInterval(async () => {
    try {
      const job = await findMeetingJob(jobId);
      if (job?.status === 'cancelled') controller.abort();
    } catch {
      /* polling best-effort */
    }
  }, 3000);
  const cleanup = () => clearInterval(timer);
  return { signal: combined, cleanup, controller };
}

async function updateJob(id, data) {
  return updateMeetingJob(id, data);
}

async function setStep(id, step, extra = {}) {
  return updateJob(id, {
    status: 'processing',
    step,
    ...extra,
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function safeUpdateJob(id, data) {
  try {
    return await updateJob(id, data);
  } catch (error) {
    console.error('[meeting-pipeline] failed to update job', id, error);
    return null;
  }
}

function isMultiAudioJob(job) {
  return Array.isArray(job?.audioFiles) && job.audioFiles.length > 0;
}

function totalAudioSize(job) {
  if (isMultiAudioJob(job)) {
    return job.audioFiles.reduce((sum, file) => sum + (file?.size || 0), 0);
  }
  return job.audioSize || 0;
}

function audioStorageKeys(job) {
  const keys = [];
  if (job?.audioKey) keys.push(job.audioKey);
  if (isMultiAudioJob(job)) {
    for (const file of job.audioFiles) {
      if (file?.key) keys.push(file.key);
    }
  }
  return keys;
}

function supplementaryStorageKeys(job) {
  const keys = [];
  if (Array.isArray(job?.supplementaryFiles)) {
    for (const file of job.supplementaryFiles) {
      if (file?.key) keys.push(file.key);
    }
  }
  return keys;
}

function allStorageKeys(job) {
  return [...audioStorageKeys(job), ...supplementaryStorageKeys(job)];
}

/**
 * Transcode audio files exceeding the configured threshold to low-bitrate mono
 * MP3 before ASR submission. Returns { files, originalKeys } where files is the
 * possibly-updated audioFiles array and originalKeys are keys that should be
 * deleted AFTER ASR succeeds (kept until then so a transcode failure can retry).
 * Returns null if no transcoding was needed.
 */
async function transcodeForAsr(job, jobId, setStep) {
  const threshold = config.meetingAsrTranscodeThreshold;
  const bitrate = config.meetingAsrTranscodeBitrate;
  if (threshold <= 0) return null;

  // Collect the audio files to check.
  let files = [];
  if (isMultiAudioJob(job)) {
    files = job.audioFiles.map((f) => ({ ...f }));
  } else if (job.audioKey) {
    files = [
      {
        key: job.audioKey,
        name: job.audioName,
        size: job.audioSize,
        type: 'audio/unknown',
        index: 0,
      },
    ];
  }

  const needsTranscode = files.filter((f) => f.size > threshold);
  if (!needsTranscode.length) return null;

  await setStep('transcode', {});
  const originalKeys = [];
  const transcoded = [];
  for (const file of needsTranscode) {
    const destKey = `${jobId}/asr-${file.index}.mp3`;
    console.log('[meeting-pipeline] transcoding for ASR', {
      jobId,
      sourceKey: file.key,
      destKey,
      sourceSize: file.size,
      bitrate,
    });
    const result = await transcodeAudioToMp3({
      sourceKey: file.key,
      destKey,
      bitrate,
    });
    originalKeys.push(file.key);
    transcoded.push({
      originalKey: file.key,
      newKey: result.key,
      newSize: result.size,
      index: file.index,
    });
    console.log('[meeting-pipeline] transcode complete', {
      jobId,
      destKey,
      originalMB: (file.size / 1024 / 1024).toFixed(1),
      transcodedMB: (result.size / 1024 / 1024).toFixed(1),
    });
  }

  // Build the replacement files array, swapping transcoded files.
  const transcodeMap = new Map(transcoded.map((t) => [t.index, t]));
  const updatedFiles = files.map((f) => {
    const t = transcodeMap.get(f.index);
    if (!t) return f;
    return {
      ...f,
      key: t.newKey,
      size: t.newSize,
      type: 'audio/mpeg',
    };
  });
  return { files: updatedFiles, originalKeys };
}

async function safeDeleteStorageKeys(keys, jobId) {
  try {
    await deleteObjects(keys);
  } catch (error) {
    console.error(
      '[meeting-pipeline] failed to delete job storage',
      jobId,
      error,
    );
  }
}

async function safeDeleteJobStorage(job, jobId) {
  await safeDeleteStorageKeys(allStorageKeys(job), jobId);
}

async function safeDeleteAudioStorage(job, jobId) {
  await safeDeleteStorageKeys(audioStorageKeys(job), jobId);
}

async function safeDeleteSupplementaryStorage(job, jobId) {
  await safeDeleteStorageKeys(supplementaryStorageKeys(job), jobId);
}

async function submitAsrFresh(jobId, file, onTaskId) {
  const presignedUrl = await presignObject(file.key);
  await throwIfCancelled(jobId);
  return runAsr(presignedUrl, {
    audioSize: file.size,
    // Transcoded objects are constant-bitrate mono MP3s — an exact bitrate
    // makes the duration-based wait budget accurate for long meetings.
    bitrateKbps: isTranscodedKey(jobId, file.key)
      ? config.meetingAsrTranscodeBitrate
      : undefined,
    onTaskId,
    onPoll: ({ status, elapsedSec, timeoutSec }) =>
      updateJob(jobId, {
        updatedAt: new Date(),
        step: `asr_poll_${status}_${elapsedSec}s/${timeoutSec}s`,
      }),
    throwIfCancelled: () => throwIfCancelled(jobId),
  });
}

/** True for the constant-bitrate MP3 objects our transcode step produces. */
function isTranscodedKey(jobId, key) {
  return String(key || '').startsWith(`${jobId}/asr-`);
}

/**
 * Run ASR for one audio file:
 *  1. resume polling a previously submitted async task when available
 *     (retry after poll timeout / restart);
 *  2. fresh submit otherwise;
 *  3. on CONTENT_LENGTH_CHECK_FAILED (DashScope's download of the public URL
 *     was truncated), escalate through the bounded recovery ladder in
 *     asrRecovery.js: transcode → fresh-URL resubmit → reduced-bitrate
 *     transcode → final resubmit.
 *
 * @returns {Promise<{ text:string, effectiveFile:Object, originalKeys:string[] }>}
 */
async function runAsrWithResume(jobId, { resumeTaskId, file, onTaskId }) {
  const pollOpts = {
    audioSize: file.size,
    bitrateKbps: isTranscodedKey(jobId, file.key)
      ? config.meetingAsrTranscodeBitrate
      : undefined,
    onPoll: ({ status, elapsedSec, timeoutSec }) =>
      updateJob(jobId, {
        updatedAt: new Date(),
        step: `asr_poll_${status}_${elapsedSec}s/${timeoutSec}s`,
      }),
    throwIfCancelled: () => throwIfCancelled(jobId),
  };

  if (resumeTaskId) {
    try {
      const result = await runAsrFromTask(resumeTaskId, pollOpts);
      return { ...result, effectiveFile: file, originalKeys: [] };
    } catch (error) {
      if (error.cancelled) throw error;
      console.warn('[meeting-pipeline] ASR resume failed, resubmitting', {
        jobId,
        resumeTaskId,
        error: errorMessage(error),
      });
    }
  }

  let currentFile = file;
  let originalKeys = [];
  let attempt = 0;
  for (;;) {
    try {
      const result = await submitAsrFresh(
        jobId,
        currentFile,
        // Tasks are recorded against the key actually submitted so a later
        // retry resumes polling even after a CLCF recovery replaced the file.
        (taskId) => onTaskId?.(taskId, currentFile.key),
      );
      return { ...result, effectiveFile: currentFile, originalKeys };
    } catch (error) {
      if (error.cancelled) throw error;
      if (!isClcfError(error)) throw error;
      const recovery = nextClcfRecovery({
        attempt: attempt + 1,
        jobId,
        index: currentFile.index,
        key: currentFile.key,
        originalKey: originalKeys[0] || null,
        baseBitrate: config.meetingAsrTranscodeBitrate,
      });
      if (!recovery) throw error;
      attempt += 1;
      console.warn(
        '[meeting-pipeline] ASR remote download truncated (CONTENT_LENGTH_CHECK_FAILED); recovering',
        { jobId, attempt, key: currentFile.key, action: recovery.type },
      );
      if (recovery.type === 'transcode') {
        await setStep(jobId, 'transcode', {});
        const transcoded = await transcodeAudioToMp3(recovery);
        if (!originalKeys.length) originalKeys.push(currentFile.key);
        currentFile = {
          ...currentFile,
          key: transcoded.key,
          size: transcoded.size,
          type: 'audio/mpeg',
        };
      }
    }
  }
}

async function runAsrForFile(jobId, file, { asrTaskIds, resumeTaskId }) {
  return runAsrWithResume(jobId, {
    resumeTaskId,
    file,
    // Persist the submitted task id immediately (not just in memory) so a
    // later retry can resume polling it instead of re-submitting. `key` is
    // the key actually submitted (may differ from `file.key` after a CLCF
    // recovery transcode).
    onTaskId: async (taskId, key = file.key) => {
      const existing = asrTaskIds.findIndex((t) => t.key === key);
      if (existing >= 0) {
        asrTaskIds[existing] = { key, taskId };
      } else {
        asrTaskIds.push({ key, taskId });
      }
      await safeUpdateJob(jobId, { asrTaskIds });
    },
  });
}

async function transcribeAudioFiles(
  jobId,
  audioFiles,
  { priorTaskIds = [] } = {},
) {
  const priorTaskIdsByKey = new Map(
    priorTaskIds
      .filter((t) => t?.key && t.taskId)
      .map((t) => [t.key, t.taskId]),
  );
  const asrTaskIds = priorTaskIds.map((t) => ({ ...t }));
  const effectiveFiles = audioFiles.map((f) => ({ ...f }));
  const originalKeys = [];
  const texts = [];
  for (let index = 0; index < audioFiles.length; index += 1) {
    const file = audioFiles[index];
    await setStep(jobId, `asr_part_${index + 1}_of_${audioFiles.length}`, {
      asrTaskIds,
    });
    const result = await runAsrForFile(jobId, file, {
      asrTaskIds,
      resumeTaskId: priorTaskIdsByKey.get(file.key) || null,
    });
    if (result.originalKeys.length) {
      // A file was transcoded for the CONTENT_LENGTH fallback; reflect the
      // replacement on the job row so cleanup and retries use the new key.
      originalKeys.push(...result.originalKeys);
      effectiveFiles[index] = result.effectiveFile;
      await safeUpdateJob(jobId, { audioFiles: effectiveFiles });
    }
    texts.push(`--- Part ${index + 1}: ${file.name} ---\n\n${result.text}`);
  }
  await updateJob(jobId, { asrTaskIds });
  return { text: texts.join('\n\n'), effectiveFiles, originalKeys };
}

function buildSupplementaryContext(extracted) {
  if (!extracted?.length) return '';
  const blocks = extracted
    .filter((item) => item?.text?.trim())
    .map((item) => `--- ${item.name} ---\n\n${item.text.trim()}`);
  if (!blocks.length) return '';
  return `\n\n${blocks.join('\n\n')}`;
}

function buildParticipantsContext(text, vaultContext) {
  const { resolvedPeople, unresolvedTokens, groupExpansions } =
    expandParticipantsText(text, vaultContext);
  if (!text?.trim()) return '';

  const lines = ['Organizer-provided participants/groups hint:'];
  if (resolvedPeople.length) {
    lines.push(`- Known attendees: ${resolvedPeople.join(', ')}`);
  }
  for (const [teamName, members] of Object.entries(groupExpansions)) {
    lines.push(
      `- Group "${teamName}": ${members.length ? members.join(', ') : '(no resolved members)'}`,
    );
  }
  if (unresolvedTokens.length) {
    lines.push(
      `- Unrecognized tokens (do not invent notes for these): ${unresolvedTokens.join(', ')}`,
    );
  }
  return lines.join('\n');
}

async function parseSupplementaryFile(jobId, file, sessionID, signal) {
  const presignedUrl = await presignObject(file.key);
  const contentType = file.type || 'application/octet-stream';
  const { text } = await runAgent({
    agent: 'meeting-document-parser',
    title: `Parse document: ${file.name}`,
    prompt: `Extract the raw text from the supplementary document below. Return only the extracted text, no summary.

Document filename: ${file.name}
Content type: ${contentType}
Presigned download URL:
${presignedUrl}

Use the URL to fetch the file. For PDF or Office documents, call POST http://localhost:8083/convert with body {"url":"<presigned URL>"} when direct reading fails.`,
    sessionID,
    signal,
    model: config.opencodeParserModel,
  });
  return { name: file.name, text };
}

async function parseSupplementaryFiles(jobId, supplementaryFiles) {
  if (!supplementaryFiles?.length) return [];

  await setStep(jobId, 'parse_supplementary');
  const sessionID = (
    await createSession(
      `Parse supplementary for job ${jobId}`,
      config.opencodeParserModel,
    )
  ).sessionID;
  const { signal, cleanup, controller } = createCancellableSignal(jobId);

  try {
    const results = [];
    for (const file of supplementaryFiles) {
      try {
        await throwIfCancelled(jobId);
        const extracted = await parseSupplementaryFile(
          jobId,
          file,
          sessionID,
          signal,
        );
        results.push(extracted);
      } catch (error) {
        if (error.cancelled) throw error;
        console.error(
          '[meeting-pipeline] supplementary parse failed, skipping',
          jobId,
          file.name,
          error,
        );
      }
    }
    return results;
  } finally {
    cleanup();
    if (signal.aborted || controller.signal.aborted) {
      await abortSession(sessionID);
    }
  }
}

export async function runMeetingJob(jobId) {
  let job = await findMeetingJob(jobId);
  if (!job) throw new Error(`Meeting job not found: ${jobId}`);
  let priorPass1 = null;
  if (job.pass1Json) {
    try {
      priorPass1 = JSON.parse(job.pass1Json);
    } catch {
      priorPass1 = null;
    }
  }
  if (
    !priorPass1?.cleanedTranscript &&
    !job.audioKey &&
    !isMultiAudioJob(job)
  ) {
    throw new Error(`Meeting job ${jobId} is missing audio`);
  }

  let outputPath = null;
  let currentStep = 'queued';
  const setCurrentStep = (step, extra = {}) => {
    currentStep = step;
    return setStep(jobId, step, extra);
  };

  try {
    const vaultContext = await loadMeetingVaultContext();
    let rawTranscript;
    let sourceName;
    let pass1;
    // Original (pre-transcode) storage keys, deleted only after the note is
    // written successfully — a job that fails post-ASR must stay retryable.
    let transcodeOriginalKeys = [];

    if (priorPass1?.cleanedTranscript) {
      // Retry after a restart/requeue with the clean pass already persisted:
      // skip transcode + ASR + clean entirely and go straight to formatting.
      pass1 = priorPass1;
      sourceName = priorPass1.sourceName || job.audioName;
      currentStep = 'format';
      await updateJob(jobId, {
        status: 'processing',
        step: 'format',
        startedAt: job.startedAt || new Date(),
        error: null,
      });
      console.log('[meeting-pipeline] reusing persisted pass1 (skipping ASR)', {
        jobId,
        transcriptChars: pass1.cleanedTranscript.length,
      });
    } else {
      // Transcode large audio to low-bitrate MP3 for more reliable ASR.
      // Originals are kept in storage until after ASR succeeds.
      const transcodeResult = await transcodeForAsr(job, jobId, setCurrentStep);
      if (transcodeResult) {
        job = { ...job, audioFiles: transcodeResult.files, audioKey: null };
        transcodeOriginalKeys = transcodeResult.originalKeys;
        // Persist the replacement keys so a retry skips re-transcoding and
        // the orphan sweeper tracks the objects actually in use.
        await safeUpdateJob(jobId, {
          audioFiles: transcodeResult.files,
          audioKey: null,
        });
      }

      // Storage keys of already-submitted async ASR tasks — resume polling
      // them instead of re-submitting (retry after poll timeout / restart).
      const priorTaskIds = Array.isArray(job.asrTaskIds) ? job.asrTaskIds : [];

      if (isMultiAudioJob(job)) {
        currentStep = 'asr';
        await updateJob(jobId, {
          status: 'processing',
          step: 'asr',
          startedAt: job.startedAt || new Date(),
          error: null,
        });
        const multi = await transcribeAudioFiles(jobId, job.audioFiles, {
          priorTaskIds,
        });
        rawTranscript = multi.text;
        sourceName = job.audioFiles.map((f) => f.name).join(', ');
        if (multi.originalKeys.length) {
          transcodeOriginalKeys.push(...multi.originalKeys);
          job = { ...job, audioFiles: multi.effectiveFiles };
        }
      } else {
        currentStep = 'asr';
        await updateJob(jobId, {
          status: 'processing',
          step: 'asr',
          startedAt: job.startedAt || new Date(),
          error: null,
        });
        const asrResult = await runAsrWithResume(jobId, {
          resumeTaskId: job.asrTaskId || null,
          file: {
            key: job.audioKey,
            name: job.audioName,
            size: totalAudioSize(job),
            type: 'audio/unknown',
            index: 0,
          },
          onTaskId: (taskId) => safeUpdateJob(jobId, { asrTaskId: taskId }),
        });
        rawTranscript = asrResult.text;
        sourceName = job.audioName;
        if (asrResult.originalKeys.length) {
          transcodeOriginalKeys.push(...asrResult.originalKeys);
          job = {
            ...job,
            audioKey: asrResult.effectiveFile.key,
            audioSize: asrResult.effectiveFile.size,
          };
        }
      }

      // Audio is intentionally KEPT after ASR: every later pass (clean,
      // summarize, format) can still fail, and without audio a failed job is
      // unrecoverable. Deletion happens only after the note is written
      // (see the status:'done' branch below); failed/cancelled jobs fall back
      // to the 24h orphan sweeper.

      await throwIfCancelled(jobId);
      // Retain the raw ASR output for provenance and later clean-pass experiments.
      await safeUpdateJob(jobId, { rawTranscript });
      await setCurrentStep('clean', {
        asrChars: rawTranscript.length,
      });
      pass1 = await runPass1Clean(rawTranscript, sourceName, {
        uploadDate: job.createdAt,
        vaultContext,
        onProgress: async (step) => {
          await throwIfCancelled(jobId);
          await setCurrentStep(step);
        },
        participantsContext: buildParticipantsContext(
          job.participantsText,
          vaultContext,
        ),
      });

      // Persist the clean-pass output so any later retry skips ASR + clean.
      await safeUpdateJob(jobId, {
        pass1Json: JSON.stringify({
          metadata: pass1.metadata,
          cleanedTranscript: pass1.cleanedTranscript,
          sourceName,
        }),
      });
    }

    const supplementaryExtracted = await parseSupplementaryFiles(
      jobId,
      job.supplementaryFiles,
    );
    const supplementaryContext = buildSupplementaryContext(
      supplementaryExtracted,
    );
    const participantsContext = buildParticipantsContext(
      job.participantsText,
      vaultContext,
    );

    await throwIfCancelled(jobId);

    // Reuse invariant: a persisted analysis is authoritative iff the schema is
    // supported and the cleaned transcript it analyzed is unchanged. Otherwise
    // mint a deliberate new generation below.
    let analysis = loadReusableAnalysis(
      job.analysisJson,
      pass1.cleanedTranscript,
    );
    if (analysis) {
      console.log('[meeting-pipeline] reusing authoritative analysis', {
        jobId,
        analysisId: analysis.analysis_id,
      });
    } else if (job.analysisJson) {
      console.log(
        '[meeting-pipeline] persisted analysis stale or unsupported; minting a new generation',
        { jobId },
      );
    }

    // Branch the summarize/format stage. 'opencode' routes to a per-type agent
    // over HTTP; any failure falls back to the deterministic code passes so a
    // meeting never fails to produce a note.
    let formatResult = null;
    if (!analysis && config.meetingFormatter === 'opencode') {
      await setCurrentStep('format');
      let sessionID = null;
      try {
        sessionID = (
          await createSession(
            formatSessionTitle(pass1),
            config.opencodeFormatterModel,
          )
        ).sessionID;
        await safeUpdateJob(jobId, { opencodeSessionId: sessionID });
        const { signal, cleanup, controller } = createCancellableSignal(jobId);
        try {
          formatResult = await runFormatAgent({
            pass1,
            vaultContext,
            sessionID,
            signal,
            supplementaryContext,
            participantsContext,
          });
        } finally {
          cleanup();
          if (signal.aborted || controller.signal.aborted) {
            await abortSession(sessionID);
          }
        }
        if (formatResult?.sessionID && formatResult.sessionID !== sessionID) {
          sessionID = formatResult.sessionID;
          await safeUpdateJob(jobId, { opencodeSessionId: sessionID });
        }
        const shareUrl = await share(formatResult.sessionID).catch(() => null);
        if (shareUrl)
          await safeUpdateJob(jobId, { opencodeShareUrl: shareUrl });
        // Persist the validated authoritative analysis — the semantic source
        // of truth for everything downstream (summaries, tasks, entity updates).
        analysis = formatResult.analysis;
        await safeUpdateJob(jobId, {
          analysisJson: JSON.stringify(analysis),
        });
      } catch (error) {
        if (error.cancelled) throw error;
        console.error(
          '[meeting-pipeline] opencode format failed, falling back to code',
          jobId,
          error,
        );
        formatResult = null;
      }
    }

    // Code summary passes: always when formatter=code, or as the opencode
    // fallback. English is canonical (strong tier); Chinese is a light-tier
    // translation of it.
    let summaryZh = null;
    let summaryEn = null;
    let contract = formatResult ? formatResult.contract : null;
    if (!analysis) {
      await throwIfCancelled(jobId);
      await setCurrentStep('summary_en');
      summaryEn = await runPass3En(pass1.cleanedTranscript, {
        supplementaryContext,
        participantsContext,
        onProgress: async (step) => {
          await throwIfCancelled(jobId);
          await setCurrentStep(step);
        },
      });

      await throwIfCancelled(jobId);
      await setCurrentStep('summary_zh');
      summaryZh = await runPassTranslateZh(summaryEn);

      // Uniform downstream interface: persist a v1-shaped analysis up-converted
      // from the code-path summaries (no transcript-wide semantic fields).
      analysis = upconvertV0Contract(
        {
          summary_en: summaryEn,
          summary_zh: summaryZh,
          action_items: parseActionItems(summaryEn).map((title) => ({
            title,
            owner: '',
            due: null,
          })),
          decisions: [],
          frontmatter_extra: {},
        },
        {
          vaultContext,
          cleanedTranscript: pass1.cleanedTranscript,
          metadata: pass1.metadata,
          model: `${config.meetingLlmProvider}/${config.meetingLlmModel}`,
          rawTranscript: job.rawTranscript || null,
        },
      );
      await safeUpdateJob(jobId, { analysisJson: JSON.stringify(analysis) });
    } else if (!contract || !contract.summary_zh) {
      // v1 analyses carry only the canonical English summary; the Chinese
      // rendering is a light-tier translation of it (never semantic source).
      await throwIfCancelled(jobId);
      await setCurrentStep('summary_zh');
      summaryZh = await runPassTranslateZh(analysis.summary_en);
      contract = contractFromAnalysis(analysis, { summaryZh });
    }

    await throwIfCancelled(jobId);
    outputPath = await uniqueMeetingPath(pass1.metadata.filename);
    const meetingBasename = path.basename(outputPath, '.md');
    const meetingContext = buildMeetingContext({
      metadata: pass1.metadata,
      cleanedTranscript: pass1.cleanedTranscript,
      summaryEn: contract ? contract.summary_en : summaryEn,
      vaultContext,
      analysis,
    });

    let taskLinks = null;
    await setCurrentStep('tasks');
    try {
      let taskInputs;
      if (contract) {
        // Agent/analysis already produced structured action items; resolve
        // owners against the vault and build Task inputs directly (no extra
        // LLM call).
        taskInputs = contractActionItemsToTaskInputs(
          contract.action_items,
          vaultContext,
        );
      } else {
        const actionItems = parseActionItems(summaryEn);
        taskInputs = await generateProposedTasks({
          actionItems,
          meetingTitle: meetingContext.title,
          meetingDate: pass1.metadata.date,
          attendees: meetingContext.attendees,
          vaultContext,
        });
      }
      await throwIfCancelled(jobId);
      taskLinks = await createProposedTaskNotes({
        tasks: taskInputs,
        meetingBasename,
        project: meetingContext.project,
        area: meetingContext.area,
      });
    } catch (error) {
      if (error.cancelled) throw error;
      console.error('[meeting-pipeline] task creation failed', jobId, error);
      taskLinks = null;
    }

    await throwIfCancelled(jobId);
    await setCurrentStep('assemble');
    const markdown = runPass4Assemble({
      metadata: pass1.metadata,
      cleanedTranscript: pass1.cleanedTranscript,
      summaryZh,
      summaryEn,
      vaultContext,
      taskLinks,
      contract: contract || undefined,
      analysis,
    });

    await throwIfCancelled(jobId);
    await setCurrentStep('write');
    await writeNote(outputPath, markdown);
    triggerGbrainSync('meeting-note');

    await updateJob(jobId, {
      status: 'done',
      step: 'done',
      outputPath,
      finishedAt: new Date(),
    });

    // Note is on disk: audio (transcoded + originals) is no longer needed.
    await safeDeleteAudioStorage(job, jobId);
    if (transcodeOriginalKeys.length) {
      await safeDeleteStorageKeys(transcodeOriginalKeys, jobId);
    }

    // Enqueue a link-lint pass once the note is written + indexed. Best-effort:
    // never let a lint failure affect the completed job.
    enqueueMeetingLintByFilepath(outputPath).catch((error) => {
      console.error(
        '[meeting-pipeline] link-lint enqueue failed',
        jobId,
        error,
      );
    });

    // Apply meeting_analysis_v1 entity updates (mode-gated; off by default).
    enqueueEntityUpdates({
      id: jobId,
      analysisJson: JSON.stringify(analysis),
      outputPath,
    });

    return { outputPath };
  } catch (error) {
    if (error.cancelled) {
      await safeUpdateJob(jobId, {
        status: 'cancelled',
        step: currentStep,
        error: 'Cancelled by user',
        finishedAt: new Date(),
      });
    } else {
      const isAsrTimeout =
        currentStep === 'asr' &&
        errorMessage(error).includes('Timed out waiting for ASR task');
      const errorNote = isAsrTimeout
        ? `${errorMessage(error)} (audio left in storage for async ASR; orphan sweeper will clean up after 24h)`
        : errorMessage(error);
      await safeUpdateJob(jobId, {
        status: 'failed',
        step: 'failed',
        error: `${currentStep}: ${errorNote}`,
        finishedAt: new Date(),
      });
    }
    throw error;
  } finally {
    // Audio deletion only happens on success (see above). Failed/cancelled
    // jobs keep their audio so they stay requeue-able; the orphan sweeper
    // deletes it after 24h. Supplementary files are always safe to delete at
    // the end.
    await safeDeleteSupplementaryStorage(job, jobId);
  }
}

async function drainQueuedMeetingJobs() {
  if (isDraining) return;
  isDraining = true;
  try {
    while (true) {
      const job = await claimQueuedMeetingJob();
      if (!job) return;
      try {
        await runMeetingJob(job.id);
      } catch (error) {
        console.error('[meeting-pipeline] queued job failed', job.id, error);
      }
    }
  } finally {
    isDraining = false;
  }
}

export function startMeetingJobWorker() {
  if (workerStarted) return;
  workerStarted = true;
  setInterval(() => {
    drainQueuedMeetingJobs().catch((error) => {
      console.error('[meeting-pipeline] queue drain failed', error);
    });
  }, 10000).unref?.();
  enqueueMeetingJob();
}

export function enqueueMeetingJob() {
  setImmediate(() => {
    drainQueuedMeetingJobs().catch((error) => {
      console.error('[meeting-pipeline] queue drain failed', error);
    });
  });
}

/**
 * Delete audio objects for failed/cancelled jobs older than the cutoff.
 * Idempotent: if the object is already gone, the delete call is a no-op.
 * Best-effort: never throws; logs failures for later cleanup.
 */
export async function sweepOrphanedMeetingAudio(
  olderThanMs = 24 * 60 * 60 * 1000,
) {
  try {
    const jobs = await listOrphanedAudioJobs(olderThanMs);
    if (!jobs.length) return { deleted: 0, errors: 0 };

    let deleted = 0;
    let errors = 0;
    for (const job of jobs) {
      try {
        await safeDeleteAudioStorage(job, job.id);
        deleted += 1;
      } catch (error) {
        errors += 1;
        console.error(
          '[meeting-pipeline] orphan sweep failed to delete audio',
          job.id,
          error,
        );
      }
    }
    console.log(
      `[meeting-pipeline] orphan audio sweep complete: ${deleted} deleted, ${errors} errors, ${jobs.length} jobs inspected`,
    );
    return { deleted, errors };
  } catch (error) {
    console.error('[meeting-pipeline] orphan audio sweep failed', error);
    return { deleted: 0, errors: 1 };
  }
}

export function startOrphanAudioSweeper(intervalMs = 24 * 60 * 60 * 1000) {
  setInterval(() => {
    sweepOrphanedMeetingAudio().catch((error) => {
      console.error('[meeting-pipeline] scheduled orphan sweep failed', error);
    });
  }, intervalMs).unref?.();
  // Run once at startup after a short delay.
  setTimeout(() => {
    sweepOrphanedMeetingAudio().catch((error) => {
      console.error('[meeting-pipeline] startup orphan sweep failed', error);
    });
  }, 60 * 1000).unref?.();
}

/**
 * Recover jobs stuck in `uploading`/`completing` past the inactivity TTL.
 *
 * - `completing` jobs: reconcile each upload against S3. If all parts exist,
 *   complete the multipart session and enqueue. If the final object already
 *   exists, mark uploaded. Otherwise leave for more parts (or fail if past TTL).
 * - `uploading` jobs: the browser is presumed gone. Abort every live multipart
 *   session and mark the job failed.
 *
 * This does NOT abort healthy uploads — only those with no activity for > TTL.
 */
export async function recoverStaleUploadJobs() {
  const ttlMs = config.meetingUploadTtlMs;
  let staleJobs;
  try {
    staleJobs = await listStaleUploadJobs(ttlMs);
  } catch (error) {
    console.error('[meeting-upload] stale upload lookup failed', error);
    return { recovered: 0, aborted: 0, errors: 1 };
  }

  if (!staleJobs.length) return { recovered: 0, aborted: 0, errors: 0 };

  let recovered = 0;
  let aborted = 0;
  let errors = 0;

  for (const job of staleJobs) {
    try {
      if (job.status === 'completing') {
        // Try to finish completion: reconcile each upload against S3.
        let allUploaded = true;
        for (const upload of job.uploads) {
          if (upload.status === 'uploaded') continue;
          const verdict = await reconcileUpload(upload);
          if (verdict.status === 'uploaded') {
            await updateMeetingUpload(upload.id, { status: 'uploaded' });
          } else if (verdict.status === 'completing' && verdict.parts?.length) {
            // All parts present — finish the CompleteMultipartUpload.
            await completeMultipartUpload({
              key: upload.s3Key,
              uploadId: upload.multipartUploadId,
              parts: verdict.parts.map((p) => ({
                partNumber: p.partNumber,
                etag: p.etag,
              })),
            });
            await updateMeetingUpload(upload.id, { status: 'uploaded' });
          } else {
            allUploaded = false;
            break;
          }
        }

        if (allUploaded) {
          await updateMeetingJob(job.id, {
            status: 'queued',
            step: 'queued',
            error: null,
          });
          enqueueMeetingJob();
          recovered += 1;
          console.log('[meeting-upload] recovered completing job', {
            jobId: job.id,
          });
        } else {
          // Completion can't finish — abort and fail.
          await abortJobUploads(job);
          await updateMeetingJob(job.id, {
            status: 'failed',
            step: 'failed',
            error: 'Upload stalled during completion',
            finishedAt: new Date(),
          });
          aborted += 1;
        }
      } else {
        // `uploading` past TTL → browser presumed gone. Abort and fail.
        await abortJobUploads(job);
        await updateMeetingJob(job.id, {
          status: 'failed',
          step: 'failed',
          error: 'Upload timed out (inactive past TTL)',
          finishedAt: new Date(),
        });
        aborted += 1;
      }
    } catch (error) {
      errors += 1;
      console.error('[meeting-upload] stale job recovery failed', {
        jobId: job.id,
        error: error.message,
      });
    }
  }

  console.log('[meeting-upload] stale upload sweep complete', {
    inspected: staleJobs.length,
    recovered,
    aborted,
    errors,
  });
  return { recovered, aborted, errors };
}

async function abortJobUploads(job) {
  await Promise.all(
    (job.uploads || [])
      .filter((u) => u.mode === 'multipart' && u.multipartUploadId && u.s3Key)
      .map((u) =>
        abortMultipartUpload({
          key: u.s3Key,
          uploadId: u.multipartUploadId,
        }).catch((err) => {
          if (
            err?.name === 'NoSuchUpload' ||
            err?.$metadata?.httpStatusCode === 404
          ) {
            return;
          }
          console.error('[meeting-upload] abort failed during recovery', {
            jobId: job.id,
            meetingUploadId: u.id,
            error: err.message,
          });
        }),
      ),
  );
}

export function startStaleUploadSweeper(intervalMs = 10 * 60 * 1000) {
  setInterval(() => {
    recoverStaleUploadJobs().catch((error) => {
      console.error(
        '[meeting-upload] scheduled stale upload sweep failed',
        error,
      );
    });
  }, intervalMs).unref?.();
  // Run once at startup after a short delay.
  setTimeout(() => {
    recoverStaleUploadJobs().catch((error) => {
      console.error(
        '[meeting-upload] startup stale upload sweep failed',
        error,
      );
    });
  }, 90 * 1000).unref?.();
}
