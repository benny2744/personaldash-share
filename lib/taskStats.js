/**
 * lib/taskStats.js — Shared task status normalization and counting.
 *
 * Single source of truth for how task statuses are bucketed across the app
 * (homepage cards, dashboard cards, and the kanban board). Keeping this in
 * one place prevents the three views from drifting out of sync.
 *
 * Canonical rule: a task with a null/empty status is treated as 'archived',
 * so it is excluded from the four board columns (proposed/todo/doing/done)
 * everywhere.
 */

/** Statuses that appear as kanban columns / card counts. */
export const BOARD_STATUSES = ['proposed', 'todo', 'doing', 'done'];

/**
 * Normalize a raw task status to a canonical lowercase bucket key.
 * Null/empty/whitespace-only values collapse to 'archived'.
 * @param {string | null | undefined} status
 * @returns {string}
 */
export function normalizeStatus(status) {
  const normalized = (status || '').trim().toLowerCase();
  return normalized === '' ? 'archived' : normalized;
}

/**
 * Count tasks per board-status bucket. Tasks whose normalized status is not
 * one of BOARD_STATUSES (e.g. 'archived' or any unknown value) roll into the
 * `other` tally so callers can still see the total.
 *
 * @param {Array<{ status?: string | null }>} tasks
 * @returns {{ proposed: number, todo: number, doing: number, done: number, archived: number, other: number, total: number }}
 */
export function computeTaskStats(tasks) {
  const counts = {
    proposed: 0,
    todo: 0,
    doing: 0,
    done: 0,
    archived: 0,
    other: 0,
    total: tasks.length,
  };
  for (const task of tasks) {
    const status = normalizeStatus(task?.status);
    if (BOARD_STATUSES.includes(status)) {
      counts[status] += 1;
    } else if (status === 'archived') {
      counts.archived += 1;
    } else {
      counts.other += 1;
    }
  }
  return counts;
}
