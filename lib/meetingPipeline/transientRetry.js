/**
 * lib/meetingPipeline/transientRetry.js — Pure helpers for the boot-time
 * auto-requeue of jobs that failed with TRANSIENT (network/transport) errors.
 *
 * Motivation (2026-10-17 incident): the LiteLLM gateway went unreachable
 * mid-job (ECONNREFUSED), the job was marked failed, and it sat there until a
 * manual retry — even though the audio/ASR result was preserved and a retry
 * would succeed the moment the gateway came back. Boot recovery now requeues
 * such jobs automatically.
 *
 * Strict scope: only transport-level failures are auto-retried. Model-level
 * failures (empty content / finish_reason quirks, 4xx from the provider,
 * validation errors, timeouts waiting on an ASR task queue) are deliberately
 * NOT matched — retrying those unattended can flip-flop forever and each
 * failure class needs a human eye (see llm.test.js: musespark-1.3 empty
 * content recurs; auto-retrying it would just fail again).
 *
 * The token set mirrors RETRYABLE_FETCH_CODES in ./llm.js and ./asr.js plus
 * the retryable HTTP statuses those files already treat as transient.
 */

// Transport error tokens as they appear inside persisted error strings, e.g.
// "fetch failed (ECONNREFUSED)" / "TypeError: fetch failed: ETIMEDOUT".
const TRANSIENT_TOKENS =
  /(?:\b(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET)\b|socket hang up|fetch failed(?=\s*[:(]|$))/i;

// Retryable upstream HTTP statuses (mirrors RETRYABLE_HTTP_STATUSES in
// asr.js). Only matches the pipeline's own labeled HTTP errors so a provider
// error body mentioning "503" in prose can't trigger a match.
const TRANSIENT_HTTP = /\b(?:ASR|LLM) HTTP (?:429|50[0-4])\b/;

export const AUTO_RETRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function isTransientPipelineError(error) {
  if (!error || typeof error !== 'string') return false;
  return TRANSIENT_TOKENS.test(error) || TRANSIENT_HTTP.test(error);
}

/** A job is requeueable only when its audio (or a persisted pass1) survives. */
export function hasRetryableJobPayload(job) {
  if (!job || typeof job !== 'object') return false;
  return Boolean(
    job.audioKey ||
    job.pass1Json ||
    (Array.isArray(job.audioFiles) && job.audioFiles.length > 0),
  );
}

/**
 * Pick failed jobs worth auto-retrying at boot: transient error + retryable
 * payload + failure recent enough that retrying is still meaningful. Older
 * failures stay failed for a human (the orphan sweeper still protects their
 * audio for 24h regardless).
 */
export function selectAutoRetryFailedJobs(
  jobs,
  { now = Date.now(), maxAgeMs = AUTO_RETRY_MAX_AGE_MS } = {},
) {
  if (!Array.isArray(jobs)) return [];
  return jobs.filter((job) => {
    if (!job || job.status !== 'failed') return false;
    if (!isTransientPipelineError(job.error)) return false;
    if (!hasRetryableJobPayload(job)) return false;
    const finishedMs = job.finishedAt
      ? new Date(job.finishedAt).getTime()
      : job.updatedAt
        ? new Date(job.updatedAt).getTime()
        : NaN;
    if (!Number.isFinite(finishedMs)) return false;
    return now - finishedMs <= maxAgeMs;
  });
}
