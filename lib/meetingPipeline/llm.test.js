import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Resilience tests for the meeting LLM fetch layer (lib/meetingPipeline/llm.js).
// Providers occasionally return HTTP 200 with empty content (reasoning-only
// output the adapter does not surface — observed with musespark-1.3 on
// 2026-09-13 and 2026-09-15, killing whole meeting jobs). These tests verify
// the retry/fallback behavior with a stubbed fetch; nothing hits a real LLM.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://stub';
process.env.VAULT_PATH = process.env.VAULT_PATH || '/tmp/vault';
process.env.MEETING_S3_ENDPOINT =
  process.env.MEETING_S3_ENDPOINT || 'http://localhost:9000';
process.env.MEETING_S3_PUBLIC_BASE =
  process.env.MEETING_S3_PUBLIC_BASE || 'http://localhost:9000';
process.env.QWEN_FILETRANS_BASE_URL =
  process.env.QWEN_FILETRANS_BASE_URL || 'http://localhost';
process.env.MEETING_LLM_API_KEY =
  process.env.MEETING_LLM_API_KEY || 'test-key';

const { complete } = await import('./llm.js');
const { isRetryableCleanError } = await import('./passes.js');

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('complete() empty-content resilience', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('retries a 200 with empty content and returns the next valid response', async () => {
    let attempt = 0;
    globalThis.fetch = async () => {
      attempt += 1;
      if (attempt === 1) {
        // The pathology under test: 200 OK, finish_reason=stop, no content.
        return jsonResponse({
          choices: [{ message: { content: '' }, finish_reason: 'stop' }],
        });
      }
      return jsonResponse({
        choices: [
          { message: { content: 'cleaned chunk' }, finish_reason: 'stop' },
        ],
      });
    };

    const text = await complete({
      system: 's',
      user: 'u',
      provider: 'openai',
      model: 'm',
      maxTokens: 10,
    });

    assert.equal(text, 'cleaned chunk');
    assert.equal(attempt, 2);
  });

  it('exhausts retries and preserves the missing-content diagnosis', async () => {
    let attempt = 0;
    globalThis.fetch = async () => {
      attempt += 1;
      return jsonResponse({
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      });
    };

    await assert.rejects(
      () =>
        complete({
          system: 's',
          user: 'u',
          provider: 'openai',
          model: 'm',
          maxTokens: 10,
        }),
      /missing message content/,
    );
    assert.equal(attempt, 4);
  });
});

describe('isRetryableCleanError', () => {
  it('treats empty-content responses as retryable so the fallback ladder engages', () => {
    assert.equal(
      isRetryableCleanError(
        new Error(
          'chunk 1/3: LLM response missing message content (finish_reason=stop)',
        ),
      ),
      true,
    );
  });

  it('still treats ordinary output errors as non-retryable', () => {
    assert.equal(
      isRetryableCleanError(new Error('chunk 1/3: some other failure')),
      false,
    );
  });
});
