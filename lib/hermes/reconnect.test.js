import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCloseDiagnostic,
  reconnectDelayMs,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
} from './reconnect.js';

describe('reconnectDelayMs', () => {
  it('grows exponentially and caps at max', () => {
    assert.equal(reconnectDelayMs(0), RECONNECT_BASE_MS);
    assert.equal(reconnectDelayMs(1), RECONNECT_BASE_MS * 2);
    assert.equal(reconnectDelayMs(2), RECONNECT_BASE_MS * 4);
    assert.equal(reconnectDelayMs(10), RECONNECT_MAX_MS);
  });

  it('treats invalid attempts as zero', () => {
    assert.equal(reconnectDelayMs(-3), RECONNECT_BASE_MS);
    assert.equal(reconnectDelayMs(Number.NaN), RECONNECT_BASE_MS);
  });
});

describe('formatCloseDiagnostic', () => {
  it('formats code and reason', () => {
    assert.equal(formatCloseDiagnostic(null), '');
    assert.equal(formatCloseDiagnostic({ code: 4403 }), '4403');
    assert.equal(
      formatCloseDiagnostic({ code: 4403, reason: 'origin_mismatch' }),
      '4403: origin_mismatch',
    );
  });
});
