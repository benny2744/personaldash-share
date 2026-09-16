import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  getVoiceLeaseConfig,
  issueVoiceLease,
  verifyVoiceLease,
} from './voiceLease.js';

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe('voiceLease', () => {
  it('issues and verifies asr/tts leases', () => {
    process.env.VOICE_LEASE_SECRET = 'unit-test-secret';
    const asr = issueVoiceLease('asr', { now: 1_700_000_000, jti: 'a1' });
    assert.equal(asr.mode, 'asr');
    assert.equal(asr.provider, 'qwen');
    assert.match(asr.wsPath, /^\/api\/hermes\/voice\/ws\?token=/);
    const payload = verifyVoiceLease(asr.token, {
      expectedMode: 'asr',
      now: 1_700_000_010,
    });
    assert.equal(payload.jti, 'a1');

    const tts = issueVoiceLease('tts', { now: 1_700_000_000, jti: 't1' });
    assert.equal(tts.voice, 'Cherry');
    assert.equal(
      verifyVoiceLease(tts.token, { expectedMode: 'tts', now: 1_700_000_010 })
        .mode,
      'tts',
    );
  });

  it('rejects forged or expired tokens', () => {
    process.env.VOICE_LEASE_SECRET = 'unit-test-secret';
    const lease = issueVoiceLease('asr', { now: 100, ttlSeconds: 1, jti: 'x' });
    assert.throws(() => verifyVoiceLease(`${lease.token}x`, { now: 100 }));
    assert.throws(() => verifyVoiceLease(lease.token, { now: 102 }));
    delete process.env.VOICE_LEASE_SECRET;
    assert.equal(getVoiceLeaseConfig().configured, false);
  });
});
