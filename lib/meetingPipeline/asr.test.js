import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Pure-helper tests for the ASR fetch retry logic in asr.js. Nothing here
// touches DashScope, S3, or the database; env vars are stubbed so module load
// doesn't throw.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://stub';
process.env.VAULT_PATH = process.env.VAULT_PATH || '/tmp/vault';
process.env.MEETING_S3_ENDPOINT =
  process.env.MEETING_S3_ENDPOINT || 'http://localhost:9000';
process.env.MEETING_S3_PUBLIC_BASE =
  process.env.MEETING_S3_PUBLIC_BASE || 'http://localhost:9000';
process.env.QWEN_FILETRANS_BASE_URL =
  process.env.QWEN_FILETRANS_BASE_URL || 'http://localhost';

const { isRetryableAsrFetchError, asrRetryDelayMs } = await import('./asr.js');
const config = (await import('@/lib/config')).default;

describe('qwenAsrTimeoutForSize (duration-aware budget)', () => {
  it('scales with duration at the assumed bitrate, not raw MB', () => {
    // 4 MB at 32 kbps = exactly 1000 s of audio → 600 + 1000 × 1.4 = 2000 s.
    assert.equal(
      config.qwenAsrTimeoutForSize(4_000_000, { bitrateKbps: 32 }),
      2000,
    );
    // Same bytes at the 128 kbps original assumption = 250 s → 600 + 350 = 950.
    assert.equal(config.qwenAsrTimeoutForSize(4_000_000), 950);
  });

  it('gives a multi-hour transcoded meeting enough budget', () => {
    // 34.1 MB @ 32 kbps ≈ 2.37 h of audio (observed 2026-08-20 failure):
    // 600 + 8528 × 1.4 ≈ 12.5k s — comfortably above the old 2552 s budget.
    const budget = config.qwenAsrTimeoutForSize(34_110_477, {
      bitrateKbps: 32,
    });
    assert.ok(budget > 12000, `budget ${budget} should exceed 12000s`);
    assert.ok(budget <= 14400);
  });

  it('is capped at qwenAsrMaxTimeoutSec', () => {
    assert.equal(
      config.qwenAsrTimeoutForSize(10_000_000_000, { bitrateKbps: 128 }),
      config.qwenAsrMaxTimeoutSec,
    );
    assert.ok(config.qwenAsrMaxTimeoutSec >= 14400);
  });

  it('handles zero/unknown size with the base timeout', () => {
    assert.equal(config.qwenAsrTimeoutForSize(0), config.qwenAsrBaseTimeoutSec);
  });
});

describe('isRetryableAsrFetchError', () => {
  it('retries transient HTTP statuses flagged on the error', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      const error = Object.assign(new Error(`ASR HTTP ${status}`), {
        retryableHttp: true,
        status,
      });
      assert.equal(isRetryableAsrFetchError(error), true, `status ${status}`);
    }
  });

  it('retries transient transport error codes', () => {
    for (const code of [
      'EAI_AGAIN',
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_SOCKET',
    ]) {
      const error = Object.assign(new Error('fetch failed'), {
        cause: { code },
      });
      assert.equal(isRetryableAsrFetchError(error), true, `code ${code}`);
    }
    assert.equal(
      isRetryableAsrFetchError(
        Object.assign(new Error('t'), { name: 'TimeoutError' }),
      ),
      true,
    );
  });

  it('does not retry permanent errors', () => {
    assert.equal(
      isRetryableAsrFetchError(new Error('ASR HTTP 400: bad')),
      false,
    );
    assert.equal(
      isRetryableAsrFetchError(new Error('ASR HTTP 401: auth')),
      false,
    );
    assert.equal(isRetryableAsrFetchError(new Error('plain failure')), false);
  });
});

describe('asrRetryDelayMs', () => {
  it('uses exponential backoff capped at 15s', () => {
    assert.equal(asrRetryDelayMs(new Error('x'), 1), 1000);
    assert.equal(asrRetryDelayMs(new Error('x'), 2), 2000);
    assert.equal(asrRetryDelayMs(new Error('x'), 3), 4000);
    assert.equal(asrRetryDelayMs(new Error('x'), 4), 8000);
    assert.equal(asrRetryDelayMs(new Error('x'), 10), 15000);
  });

  it('honors Retry-After when present', () => {
    const error = Object.assign(new Error('x'), { retryAfter: '5' });
    assert.equal(asrRetryDelayMs(error, 1), 5000);
    const httpDate = Object.assign(new Error('x'), {
      retryAfter: new Date(Date.now() + 3000).toUTCString(),
    });
    const ms = asrRetryDelayMs(httpDate, 1);
    assert.ok(ms >= 0 && ms <= 3500, `retry-after date within range: ${ms}`);
  });
});
