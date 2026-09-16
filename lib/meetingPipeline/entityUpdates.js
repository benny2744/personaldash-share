/**
 * lib/meetingPipeline/entityUpdates.js — applies meeting_analysis_v1
 * entity_updates to people/project/area notes.
 *
 * Identity model (locked design):
 *   effect_id = sha256(analysis_id + entity_update_id) — unique row in
 *     meeting_entity_effects; retries skip already-applied effects. Boring by
 *     design: already applied? skip. Not applied? apply.
 *   fact dedupe — meeting-scoped secondary defense (job_id + entity_filepath
 *     + normalized-fact hash), soft check with a log line; catches equivalent
 *     facts across regenerated analyses. Never the effect identity, never
 *     cross-meeting.
 *
 * Routing:
 *   update_type log     → auto-append a dated bullet under '## Meeting Log' in
 *                         the entity note (additive, heading created if absent)
 *   update_type profile → Link Review inbox (EntitySuggestion
 *                         suggestedType='profile_update:<kind>'); a human
 *                         approves the append via the 'apply' action
 *   resolution unresolved → never auto-applies (logged and skipped)
 *
 * Modes (MEETING_ENTITY_UPDATES_MODE): off (default) | dry_run (logs intents,
 * no writes) | apply.
 */
import prisma from '@/lib/db';
import config from '@/lib/config';
import { readNote, writeNote } from '@/lib/vault';
import { toDateStr } from '@/lib/dates';
import { triggerGbrainSync } from '@/lib/gbrainSync';
import { ANALYSIS_SCHEMA_VERSION, effectIdFor, factHashFor } from './analysis';

const MEETING_LOG_HEADING = '## Meeting Log';
const SWEEP_LIMIT = 25;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const SWEEP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

let workerStarted = false;

function meetingBasenameFor(job) {
  return job?.outputPath
    ? job.outputPath.split('/').pop().replace(/\.md$/, '')
    : null;
}

/** Dated, meeting-linked bullet appended to an entity's Meeting Log. */
export function buildLogBullet(analysis, update, meetingBasename) {
  const date = analysis?.meeting?.date || toDateStr(new Date());
  return `- ${date}: ${update.fact} ([[${meetingBasename}]])`;
}

/**
 * Append a bullet under '## Meeting Log', creating the heading when absent.
 * File-level idempotency: an identical existing bullet is a no-op (the DB
 * effect row remains the primary guard).
 */
export function appendMeetingLogBullet(markdown, bullet) {
  if (markdown.includes(bullet)) return { markdown, added: false };
  const headingRe = /^## Meeting Log\s*$/m;
  if (!headingRe.test(markdown)) {
    const base = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
    return {
      markdown: `${base}\n${MEETING_LOG_HEADING}\n${bullet}\n`,
      added: true,
    };
  }
  const lines = markdown.split('\n');
  const headingIdx = lines.findIndex((line) =>
    /^## Meeting Log\s*$/.test(line),
  );
  let insertIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) {
      insertIdx = i;
      break;
    }
  }
  while (insertIdx - 1 > headingIdx && lines[insertIdx - 1].trim() === '') {
    insertIdx -= 1;
  }
  lines.splice(insertIdx, 0, bullet, '');
  return { markdown: lines.join('\n'), added: true };
}

/** profile updates queue for human review; dedupes against pending rows. */
async function persistProfileSuggestion(job, update, bullet) {
  const suggestedType = `profile_update:${update.kind}`;
  const existing = await prisma.entitySuggestion.findFirst({
    where: {
      filepath: job.outputPath,
      status: 'pending',
      suggestedType,
      mention: update.observed_name,
    },
    select: { id: true },
  });
  if (existing) return false;
  await prisma.entitySuggestion.create({
    data: {
      filepath: job.outputPath,
      mention: String(update.observed_name).slice(0, 200),
      suggestedType,
      evidence: bullet.replace(/^- /, '').slice(0, 500),
      suggestedExistingNote: update.entity_id
        .split('/')
        .pop()
        .replace(/\.md$/, ''),
      status: 'pending',
    },
  });
  return true;
}

/**
 * Apply (or in dry_run, log) every pending entity update from a job's
 * persisted analysis. Stateless and retry-safe: pending = resolved updates
 * whose effect row does not yet exist.
 */
export async function processJobEntityUpdates(
  job,
  { mode = config.meetingEntityUpdatesMode } = {},
) {
  const none = { processed: 0, mode };
  if (mode === 'off' || !job?.analysisJson || !job?.outputPath) return none;

  let analysis;
  try {
    analysis = JSON.parse(job.analysisJson);
  } catch {
    return { ...none, error: 'unparseable analysis_json' };
  }
  if (analysis?.schema_version !== ANALYSIS_SCHEMA_VERSION) return none;
  const updates = Array.isArray(analysis.entity_updates)
    ? analysis.entity_updates
    : [];
  if (!updates.length) return none;

  const meetingBasename = meetingBasenameFor(job);
  if (!meetingBasename) return { ...none, error: 'no outputPath' };

  const existing = await prisma.meetingEntityEffect.findMany({
    where: { jobId: job.id },
    select: { effectId: true, entityFilepath: true, factHash: true },
  });
  const appliedIds = new Set(existing.map((row) => row.effectId));
  const factsSeen = new Set(
    existing.map((row) => `${row.entityFilepath} ${row.factHash}`),
  );

  let processed = 0;
  for (const update of updates) {
    if (!update.entity_id || update.resolution_status !== 'resolved') {
      if (update.entity_update_id) {
        console.log('[entity-updates] skipping unresolved update', {
          jobId: job.id,
          update: update.entity_update_id,
          entity: update.observed_name,
        });
      }
      continue;
    }
    const effectId = effectIdFor(analysis.analysis_id, update.entity_update_id);
    if (appliedIds.has(effectId)) continue;

    const factHash = factHashFor(update.entity_id, update.fact);
    if (factsSeen.has(`${update.entity_id} ${factHash}`)) {
      console.log(
        '[entity-updates] skipping equivalent fact already recorded for this meeting',
        {
          jobId: job.id,
          entity: update.entity_id,
          update: update.entity_update_id,
        },
      );
      continue;
    }

    const bullet = buildLogBullet(analysis, update, meetingBasename);
    if (mode === 'dry_run') {
      console.log(
        `[entity-updates] DRY RUN would apply ${update.update_type} → ${update.entity_id}: ${bullet}`,
      );
      processed += 1;
      continue;
    }

    try {
      if (update.update_type === 'log') {
        const current = await readNote(update.entity_id);
        const { markdown, added } = appendMeetingLogBullet(current, bullet);
        if (added) {
          await writeNote(update.entity_id, markdown);
          triggerGbrainSync('entity-update');
        }
      } else {
        await persistProfileSuggestion(job, update, bullet);
      }
      await prisma.meetingEntityEffect.create({
        data: {
          effectId,
          jobId: job.id,
          analysisId: analysis.analysis_id,
          entityUpdateId: update.entity_update_id,
          entityFilepath: update.entity_id,
          factHash,
          kind: update.update_type,
          payload: {
            fact: update.fact,
            category: update.category,
            confidence: update.confidence,
            evidence: update.evidence,
          },
        },
      });
      appliedIds.add(effectId);
      factsSeen.add(`${update.entity_id} ${factHash}`);
      processed += 1;
    } catch (error) {
      // A unique-key race on effect_id means a concurrent run applied it — fine.
      console.error(
        '[entity-updates] apply failed',
        job.id,
        update.entity_update_id,
        error?.message || error,
      );
    }
  }
  return { processed, mode };
}

/** Best-effort enqueue right after a meeting note is written. */
export function enqueueEntityUpdates(jobLike) {
  if (config.meetingEntityUpdatesMode === 'off') return;
  processJobEntityUpdates(jobLike).catch((error) => {
    console.error('[entity-updates] enqueue processing failed', error);
  });
}

/** Backup sweep over recent done jobs with an analysis (retry safety net). */
export async function runEntityUpdateSweep(limit = SWEEP_LIMIT) {
  if (config.meetingEntityUpdatesMode === 'off') return 0;
  const jobs = await prisma.meetingJob.findMany({
    where: {
      status: 'done',
      analysisJson: { not: null },
      outputPath: { not: null },
      createdAt: { gte: new Date(Date.now() - SWEEP_WINDOW_MS) },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  let processed = 0;
  for (const job of jobs) {
    const result = await processJobEntityUpdates(job);
    processed += result.processed;
  }
  return processed;
}

export function startEntityUpdateWorker() {
  if (workerStarted) return;
  workerStarted = true;
  if (config.meetingEntityUpdatesMode === 'off') {
    console.log(
      '[entity-updates] worker idle (MEETING_ENTITY_UPDATES_MODE=off)',
    );
    return;
  }
  console.log(
    `[entity-updates] worker started (mode=${config.meetingEntityUpdatesMode})`,
  );
  const timer = setInterval(() => {
    runEntityUpdateSweep().catch((error) => {
      console.error('[entity-updates] sweep failed', error);
    });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  const kickoff = setTimeout(() => {
    runEntityUpdateSweep().catch((error) => {
      console.error('[entity-updates] sweep failed', error);
    });
  }, 45_000);
  kickoff.unref?.();
}
