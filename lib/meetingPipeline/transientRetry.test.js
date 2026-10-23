import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Pure tests for the boot-time auto-requeue classifier
// (lib/meetingPipeline/transientRetry.js). No DB, no network.

import {
  AUTO_RETRY_MAX_AGE_MS,
  isTransientPipelineError,
  hasRetryableJobPayload,
  selectAutoRetryFailedJobs,
} from './transientRetry.js';

// Errors observed verbatim in production logs.
const ECONNREFUSED_JOB =
  'chunk 2/5: LLM fetch failed for zai/musespark-1.3 after 4 attempts: fetch failed (ECONNREFUSED)';
const UND_ERR_SOCKET =
  'metadata extraction: LLM fetch failed for zai/musespark-1.3 after 4 attempts: TypeError: fetch failed: UND_ERR_SOCKET';

describe('isTransientPipelineError', () => {
  it('matches real transient failures from the 2026-10-17 incident', () => {
    assert.equal(isTransientPipelineError(ECONNREFUSED_JOB), true);
    assert.equal(isTransientPipelineError(UND_ERR_SOCKET), true);
  });

  it('matches transport tokens in any position', () => {
    for (const error of [
      'fetch failed (ETIMEDOUT)',
      'fetch failed (EAI_AGAIN)',
      'fetch failed (ECONNRESET)',
      'fetch failed (ENOTFOUND)',
      'fetch failed (UND_ERR_CONNECT_TIMEOUT)',
      'fetch failed (UND_ERR_HEADERS_TIMEOUT)',
      'socket hang up',
      'TypeError: fetch failed',
    ]) {
      assert.equal(isTransientPipelineError(error), true, error);
    }
  });

  it('matches retryable upstream HTTP statuses on labeled pipeline errors', () => {
    assert.equal(isTransientPipelineError('ASR HTTP 502: upstream bad'), true);
    assert.equal(isTransientPipelineError('LLM HTTP 503: gateway down'), true);
    assert.equal(isTransientPipelineError('ASR HTTP 429: slow down'), true);
  });

  it('does NOT match model-level or validation failures', () => {
    for (const error of [
      // The recurring musespark-1.3 empty-content failure — needs a human.
      'chunk 2/5: LLM fetch failed for zai/musespark-1.3 after 4 attempts: LLM response missing message content (finish_reason=stop)',
      'LLM response missing message content (finish_reason=length)',
      'Container restarted mid-job',
      'ASR task failed: 400 bad request',
      'ASR submit response missing task_id: {}',
      'Timed out waiting for ASR task abc-123',
      'Meeting job missing audio',
      'metadata extraction: Missing API key for meeting LLM provider: zai',
      'ASR result contained no transcript text',
      'chunk 1/3: LLM HTTP 400: invalid model',
      null,
      undefined,
      '',
      42,
    ]) {
      assert.equal(isTransientPipelineError(error), false, String(error));
    }
  });

  it('does NOT match HTTP statuses buried in prose or non-retryable codes', () => {
    assert.equal(
      isTransientPipelineError('provider body said "503 unavailable"'),
      false,
    );
    assert.equal(isTransientPipelineError('ASR HTTP 400: bad input'), false);
    assert.equal(isTransientPipelineError('LLM HTTP 401: bad key'), false);
    // Token boundaries: ECONNREFUSEDXYZ is not ECONNREFUSED.
    assert.equal(isTransientPipelineError('code ECONNREFUSEDXYZ'), false);
  });
});

describe('hasRetryableJobPayload', () => {
  it('accepts jobs with audio or a persisted pass1', () => {
    assert.equal(hasRetryableJobPayload({ audioKey: 'k' }), true);
    assert.equal(hasRetryableJobPayload({ audioFiles: [{ key: 'k' }] }), true);
    assert.equal(hasRetryableJobPayload({ pass1Json: '{}' }), true);
  });

  it('rejects jobs with nothing to resume from', () => {
    for (const job of [
      null,
      {},
      { audioFiles: [] },
      { audioKey: null, pass1Json: null, audioFiles: null },
    ]) {
      assert.equal(hasRetryableJobPayload(job), false, JSON.stringify(job));
    }
  });
});

describe('selectAutoRetryFailedJobs', () => {
  const NOW = Date.parse('2026-10-17T12:00:00Z');

  function failedJob(overrides = {}) {
    return {
      id: 'job-1',
      status: 'failed',
      error: ECONNREFUSED_JOB,
      audioFiles: [{ key: 'k' }],
      pass1Json: null,
      audioKey: null,
      finishedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
      ...overrides,
    };
  }

  it('selects recent transient-failed jobs with payload', () => {
    const jobs = [
      failedJob(),
      failedJob({
        id: 'model-level',
        error: 'LLM response missing message content (finish_reason=stop)',
      }),
      failedJob({
        id: 'old',
        finishedAt: new Date(NOW - 10 * 24 * 3600 * 1000).toISOString(),
      }),
      failedJob({ id: 'no-payload', audioFiles: [], error: ECONNREFUSED_JOB }),
      failedJob({ id: 'not-failed', status: 'cancelled' }),
      failedJob({ id: 'no-error', error: null }),
    ];
    const picked = selectAutoRetryFailedJobs(jobs, { now: NOW });
    assert.deepEqual(
      picked.map((j) => j.id),
      ['job-1'],
    );
  });

  it('falls back to updatedAt when finishedAt is null', () => {
    const job = failedJob({
      finishedAt: null,
      updatedAt: new Date(NOW - 60 * 1000).toISOString(),
    });
    assert.deepEqual(selectAutoRetryFailedJobs([job], { now: NOW }), [job]);
  });

  it('rejects unparseable timestamps and non-array input', () => {
    assert.deepEqual(
      selectAutoRetryFailedJobs([failedJob({ finishedAt: 'garbage' })], {
        now: NOW,
      }),
      [],
    );
    assert.deepEqual(selectAutoRetryFailedJobs(null), []);
    assert.equal(AUTO_RETRY_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000);
  });
});
