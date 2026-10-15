// Timestamp normalization for Hermes wire data.
//
// The hermes-dashboard serializes session-row timestamps (last_active,
// started_at, last_activity_at) as Unix SECONDS with fractional precision,
// while JS `new Date(number)` interprets numbers as MILLISECONDS. A raw
// seconds value therefore renders ~20 days after the epoch — permanently
// stuck at "Jan 22, 1970", advancing 1 ms per real second (2026-10-13
// diagnosis; the sidebar never rendered this correctly).

export const SECONDS_TO_MS_THRESHOLD = 1e12;

/**
 * Normalize a wire timestamp to epoch milliseconds (or null).
 *
 * Heuristic: any finite number below 1e12 (Sep 2001 in ms — far above any
 * plausible seconds value, ~1.8e9 today) is treated as seconds and scaled;
 * anything at or above is already milliseconds. Strings go through
 * Date.parse as before (ISO timestamps parse correctly). Non-finite, zero,
 * negative, and empty inputs become null so callers can fall back.
 *
 * @param {number|string|null|undefined} value
 * @returns {number|null} epoch milliseconds, or null when unusable
 */
export function epochToMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < SECONDS_TO_MS_THRESHOLD
      ? value * 1000
      : value;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}
