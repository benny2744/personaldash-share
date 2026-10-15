import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  epochToMs,
  SECONDS_TO_MS_THRESHOLD,
} from './time.js';

describe('epochToMs', () => {
  it('scales Unix seconds to milliseconds', () => {
    assert.equal(epochToMs(1791472512), 1791472512000);
  });

  it('scales fractional seconds from the live dashboard wire format', () => {
    // Real sample from GET /api/sessions (2026-10-13).
    assert.equal(epochToMs(1791903097.3463526), 1791903097346.3526);
    // Lands in 2026, not 1970.
    assert.equal(new Date(epochToMs(1791903097.3463526)).getUTCFullYear(), 2026);
  });

  it('passes milliseconds through unchanged', () => {
    assert.equal(epochToMs(1791903097346.3526), 1791903097346.3526);
    assert.equal(epochToMs(Date.now()), Date.now());
  });

  it('treats exactly 1e12 as already-milliseconds', () => {
    assert.equal(epochToMs(SECONDS_TO_MS_THRESHOLD), SECONDS_TO_MS_THRESHOLD);
  });

  it('parses ISO strings like before', () => {
    assert.equal(
      epochToMs('2026-10-13T12:31:37.346Z'),
      Date.parse('2026-10-13T12:31:37.346Z'),
    );
    const iso = new Date().toISOString();
    assert.equal(epochToMs(iso), Date.parse(iso));
  });

  it('returns null for unusable input', () => {
    assert.equal(epochToMs(null), null);
    assert.equal(epochToMs(undefined), null);
    assert.equal(epochToMs(''), null);
    assert.equal(epochToMs(0), null);
    assert.equal(epochToMs(-42), null);
    assert.equal(epochToMs(-1791472512), null);
    assert.equal(epochToMs(Number.NaN), null);
    assert.equal(epochToMs(Number.POSITIVE_INFINITY), null);
    assert.equal(epochToMs('not a date'), null);
  });
});
