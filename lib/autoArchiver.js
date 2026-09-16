/**
 * lib/autoArchiver.js — Automatically archives stale tasks.
 *
 * A task is considered stale when its `updatedAt` (last modified) is older
 * than STALE_DAYS AND its status is one of ELIGIBLE_STATUSES. 'Doing' is
 * never auto-archived — it represents active work. Null/empty statuses are
 * also archived (consistent with the normalizeStatus rule in lib/taskStats).
 *
 * Archiving flows through the existing write-back path (enqueueWriteBack) so
 * the vault Markdown frontmatter `Status` stays in sync with the database.
 *
 * Runs both as a one-off (via scripts/archive-stale-tasks.mjs) and as a
 * recurring background worker registered in instrumentation.js.
 */

import prisma from './db.js';
import { enqueueWriteBack } from './syncWorker.js';

/** Tasks older than this (by updatedAt) are candidates for archiving. */
export const STALE_DAYS = 30;

/** Lowercased statuses eligible for auto-archive. 'doing' is deliberately excluded. */
export const ELIGIBLE_STATUSES = ['done', 'proposed', 'todo'];

/** Worker cadence. Daily is plenty for a 30-day threshold. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Find tasks that should be archived. Mirrors the normalizeStatus rule:
 * null/empty status is treated as a stale candidate too (bucketed as 'todo'
 * for eligibility so it gets cleaned up rather than lingering uncounted).
 *
 * @param {Object} [options]
 * @param {number} [options.limit] - Cap on candidates returned per call.
 * @param {Date} [options.now] - Override "now" for testing.
 * @returns {Promise<Array<Object>>}
 */
async function findStaleTasks({ limit, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - STALE_DAYS * 24 * 60 * 60 * 1000);

  // Status is free-text and historically stored with mixed case; match both
  // canonical cases. The schema default ('Todo') guarantees no null/empty rows,
  // and a stale defaulted task is already 'Todo' (in ELIGIBLE_STATUSES).
  const statusCases = [];
  for (const status of ELIGIBLE_STATUSES) {
    statusCases.push(status, status.charAt(0).toUpperCase() + status.slice(1));
  }

  return prisma.task.findMany({
    where: {
      note: { deletedAt: null },
      updatedAt: { lt: cutoff },
      status: { in: statusCases },
    },
    include: { note: { select: { id: true, filepath: true } } },
    orderBy: { updatedAt: 'asc' },
    ...(limit ? { take: limit } : {}),
  });
}

/**
 * Archive a single stale task: write back frontmatter, update DB, and record
 * an audit event. Mirrors the transaction shape in app/api/tasks/[id]/route.js.
 *
 * @param {Object} task - Task row with included `note`.
 * @returns {Promise<{ ok: boolean, conflict: boolean, error?: string }>}
 */
async function archiveTask(task) {
  const previousStatus = task.status || '';

  const syncResult = await enqueueWriteBack({
    noteId: task.note.id,
    fields: { status: 'Archived' },
    source: 'auto-archive',
  });
  if (!syncResult?.success) {
    return {
      ok: false,
      conflict: Boolean(syncResult?.conflict),
      error: syncResult?.error,
    };
  }

  await prisma.$transaction([
    prisma.task.update({
      where: { id: task.id },
      data: { status: 'Archived' },
    }),
    prisma.taskEvent.create({
      data: {
        taskId: task.id,
        eventType: 'status_change',
        field: 'status',
        oldValue: previousStatus,
        newValue: 'Archived',
        source: 'auto-archive',
      },
    }),
  ]);

  return { ok: true, conflict: false };
}

/**
 * Archive every currently-stale task.
 *
 * @param {Object} [options]
 * @param {boolean} [options.dryRun] - When true, report candidates without mutating.
 * @param {number} [options.limit] - Cap candidates processed per call (keeps the
 *   write-back queue from being flooded in a single run).
 * @param {Date} [options.now] - Override "now" for testing.
 * @returns {Promise<{ archived: number, conflicts: number, failed: number, skipped: number, filepaths: string[] }>}
 */
export async function archiveStaleTasks({ dryRun = false, limit, now } = {}) {
  const candidates = await findStaleTasks({ limit, now });

  if (dryRun) {
    return {
      archived: 0,
      conflicts: 0,
      failed: 0,
      skipped: candidates.length,
      filepaths: candidates.map((task) => task.note.filepath),
    };
  }

  let archived = 0;
  let conflicts = 0;
  let failed = 0;
  const filepaths = [];

  for (const task of candidates) {
    try {
      const result = await archiveTask(task);
      if (result.ok) {
        archived += 1;
        filepaths.push(task.note.filepath);
      } else if (result.conflict) {
        conflicts += 1;
      } else {
        failed += 1;
      }
    } catch (err) {
      console.error(
        '[auto-archive] Error archiving task',
        task.id,
        err.message,
      );
      failed += 1;
    }
  }

  return { archived, conflicts, failed, skipped: 0, filepaths };
}

let intervalId = null;

async function runCycle() {
  try {
    const result = await archiveStaleTasks({ limit: 200 });
    if (result.archived > 0 || result.conflicts > 0 || result.failed > 0) {
      console.log(
        `[auto-archive] archived=${result.archived} conflicts=${result.conflicts} failed=${result.failed}`,
      );
    }
  } catch (err) {
    console.error('[auto-archive] Cycle failed:', err.message);
  }
}

/**
 * Start the recurring background worker. Idempotent.
 */
export function startAutoArchiver() {
  if (intervalId) return;
  console.log('[auto-archive] Starting stale-task archiver worker');
  setTimeout(runCycle, 30_000);
  intervalId = setInterval(runCycle, CHECK_INTERVAL_MS);
}

/**
 * Stop the recurring background worker. Idempotent.
 */
export function stopAutoArchiver() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[auto-archive] Stopped stale-task archiver worker');
  }
}
