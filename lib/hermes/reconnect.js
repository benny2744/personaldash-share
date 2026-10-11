/**
 * Bounded exponential backoff for Hermes chat reconnects.
 */

export const RECONNECT_BASE_MS = 1_500;
export const RECONNECT_MAX_MS = 30_000;

/**
 * @param {number} attempt zero-based failed-attempt count
 * @param {{ baseMs?: number, maxMs?: number }} [options]
 */
export function reconnectDelayMs(attempt, options = {}) {
  const baseMs = options.baseMs ?? RECONNECT_BASE_MS;
  const maxMs = options.maxMs ?? RECONNECT_MAX_MS;
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const delay = baseMs * 2 ** safeAttempt;
  return Math.min(maxMs, delay);
}

/**
 * Format a close code/reason for UI diagnostics without dumping secrets.
 * @param {{ code?: number | null, reason?: string } | null | undefined} close
 */
export function formatCloseDiagnostic(close) {
  if (!close || close.code == null) return '';
  const reason = String(close.reason || '').trim();
  return reason ? `${close.code}: ${reason}` : String(close.code);
}
