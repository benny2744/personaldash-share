/**
 * lib/indexerGuard.js — Safety valves that make a vault-index wipe
 * self-limiting. Extracted from lib/indexer.js as pure logic so it can be
 * unit-tested without Prisma/chokidar imports.
 *
 * Background (2026-10-06 incident): a standalone server was booted with
 * VAULT_PATH pointing at a container-only path, `listMarkdownFiles()`
 * returned 0 files, and `reconcileMissingFiles` soft-deleted every live note
 * plus all derived typed records. Canonical vault files were untouched and
 * a rescan restored everything, but the wipe must not be repeatable.
 */

/**
 * Decide whether reconcile (soft-deleting notes whose files vanished) is
 * safe to run for this scan. Refuses when the vault listing is empty or
 * suspiciously small relative to what the DB still tracks — the signature
 * of a wrong/unmounted VAULT_PATH, not of the user deleting files.
 * @param {number} fileCount - Markdown files found in the vault
 * @param {number} liveNoteCount - Non-deleted notes currently in the DB
 * @returns {boolean}
 */
export function shouldRunReconcile(fileCount, liveNoteCount) {
  if (liveNoteCount === 0) return true;
  if (fileCount === 0) return false;
  if (fileCount < liveNoteCount * 0.5) return false;
  return true;
}

/**
 * Circuit breaker for per-file soft-deletes. When a vault mount vanishes,
 * chokidar fires unlink for every watched file within seconds; a legitimate
 * manual cleanup never approaches this rate. Once tripped, deletions are
 * refused until the window drains.
 * @param {{ limit?: number, windowMs?: number, now?: () => number }} [options]
 * @returns {{ record: () => { allowed: boolean, trippedCount: number }, reset: () => void }}
 */
export function createDeletionBreaker({
  limit = 250,
  windowMs = 5 * 60_000,
  now = () => Date.now(),
} = {}) {
  let stamps = [];
  let refused = 0;

  return {
    /**
     * Record one deletion attempt.
     * @returns {{ allowed: boolean, trippedCount: number }} trippedCount is
     * the number of consecutive refusals in the current window (0 when allowed).
     */
    record() {
      const t = now();
      stamps = stamps.filter((s) => t - s < windowMs);
      if (stamps.length >= limit) {
        refused += 1;
        return { allowed: false, trippedCount: refused };
      }
      stamps.push(t);
      refused = 0;
      return { allowed: true, trippedCount: 0 };
    },
    reset() {
      stamps = [];
      refused = 0;
    },
  };
}
