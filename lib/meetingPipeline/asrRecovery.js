/**
 * lib/meetingPipeline/asrRecovery.js — Recovery ladder for DashScope ASR
 * CONTENT_LENGTH_CHECK_FAILED (CLCF) failures.
 *
 * CLCF means DashScope's download of the presigned audio URL came up short —
 * usually a transient truncation on the public (tunneled) route rather than a
 * problem with the object itself. The ladder is bounded (MAX_CLCF_RECOVERIES)
 * and escalates from "cheap retry" to "smaller file":
 *
 *   attempt 1 — plain key  → transcode to low-bitrate MP3 (config bitrate)
 *              asr-* key   → plain resubmit (fresh presigned URL)
 *   attempt 2 — (re-)transcode at reduced bitrate to a fresh -r2 object,
 *              sourcing the retained original when known
 *   attempt 3 — plain resubmit (fresh presigned URL)
 *   attempt >3 — give up (caller rethrows)
 *
 * Kept pure so the decision tree is unit-testable without the storage/LLM
 * stack that job.js pulls in.
 */

export const CLCF_ERROR_CODE = 'CONTENT_LENGTH_CHECK_FAILED';
export const MAX_CLCF_RECOVERIES = 3;
export const MIN_RECOVERY_BITRATE = 16;

/** True for the constant-bitrate MP3 objects our transcode steps produce. */
export function isTranscodedKey(jobId, key) {
  return String(key || '').startsWith(`${jobId}/asr-`);
}

export function isClcfError(error) {
  return String(error?.message || error || '').includes(CLCF_ERROR_CODE);
}

/**
 * Decide the next CLCF recovery action.
 *
 * @param {object} params
 * @param {number} params.attempt - 1-based recovery attempt number
 * @param {string} params.jobId
 * @param {number|string} params.index - audio file index within the job
 * @param {string} params.key - S3 key of the file that just failed
 * @param {string|null} params.originalKey - pre-transcode original, if tracked
 * @param {number} params.baseBitrate - config.meetingAsrTranscodeBitrate
 * @returns {{ type:'resubmit' } | { type:'transcode', sourceKey:string, destKey:string, bitrate:number } | null}
 */
export function nextClcfRecovery({
  attempt,
  jobId,
  index,
  key,
  originalKey,
  baseBitrate,
}) {
  if (attempt > MAX_CLCF_RECOVERIES) return null;
  const transcoded = isTranscodedKey(jobId, key);

  if (attempt === 1 && !transcoded) {
    // First failure of an original upload: produce the standard low-bitrate MP3.
    return {
      type: 'transcode',
      sourceKey: key,
      destKey: `${jobId}/asr-${index}.mp3`,
      bitrate: baseBitrate,
    };
  }

  if (attempt === 2) {
    // Still truncated: smallest viable file from the best available source
    // (the retained original beats re-compressing an already-compressed MP3).
    return {
      type: 'transcode',
      sourceKey: originalKey || key,
      destKey: `${jobId}/asr-${index}-r2.mp3`,
      bitrate: Math.max(MIN_RECOVERY_BITRATE, Math.floor(baseBitrate / 2)),
    };
  }

  // Attempt 1 on an already-transcoded key, or attempt 3: truncation is
  // often transient — resubmit the same object with a fresh presigned URL.
  return { type: 'resubmit' };
}
