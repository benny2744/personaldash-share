/**
 * Client-safe draft helpers for Hermes chat composer.
 */

/**
 * Append transcript into an existing composer draft.
 * @param {string} draft
 * @param {string} transcript
 */
export function insertTranscriptIntoDraft(draft, transcript) {
  const existing = String(draft || '');
  const next = String(transcript || '').trim();
  if (!next) return existing;
  if (!existing.trim()) return next;
  const needsSpace = !/\s$/.test(existing) && !/^[.,!?;:]/.test(next);
  return `${existing}${needsSpace ? ' ' : ''}${next}`;
}

/**
 * Replace the live voice suffix on a frozen pre-recording draft.
 * Cumulative ASR hypotheses should call this with the same baseDraft so
 * partials replace each other instead of stacking.
 * @param {string} baseDraft
 * @param {string} transcript
 */
export function applyLiveVoiceTranscript(baseDraft, transcript) {
  return insertTranscriptIntoDraft(baseDraft, transcript);
}
