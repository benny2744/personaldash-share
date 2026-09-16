import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Tests for lib/meetingPipeline/asrRecovery.js — the pure CONTENT_LENGTH_CHECK_FAILED
// recovery ladder used by runAsrWithResume (job.js). No env/db dependencies.

const {
  CLCF_ERROR_CODE,
  MAX_CLCF_RECOVERIES,
  MIN_RECOVERY_BITRATE,
  isTranscodedKey,
  isClcfError,
  nextClcfRecovery,
} = await import('./asrRecovery.js');

const BASE = { jobId: 'job1', index: 0, baseBitrate: 32 };

describe('asrRecovery', () => {
  describe('isTranscodedKey', () => {
    it('matches asr- prefixed keys only for the same job', () => {
      assert.equal(isTranscodedKey('job1', 'job1/asr-0.mp3'), true);
      assert.equal(isTranscodedKey('job1', 'job1/asr-0-r2.mp3'), true);
      assert.equal(isTranscodedKey('job1', 'job1/audio-0.mp3'), false);
      assert.equal(isTranscodedKey('job1', 'job2/asr-0.mp3'), false);
      assert.equal(isTranscodedKey('job1', null), false);
    });
  });

  describe('isClcfError', () => {
    it('matches the code inside ASR task failure messages', () => {
      assert.equal(
        isClcfError(
          new Error(
            'ASR task failed: CONTENT_LENGTH_CHECK_FAILED CONTENT_LENGTH_CHECK_FAILED',
          ),
        ),
        true,
      );
      assert.equal(
        isClcfError(new Error('ASR task failed: NETWORK_ERROR')),
        false,
      );
      assert.equal(isClcfError(null), false);
    });
  });

  describe('nextClcfRecovery', () => {
    it('attempt 1 on a plain key transcodes to the standard low-bitrate MP3', () => {
      const action = nextClcfRecovery({
        ...BASE,
        attempt: 1,
        key: 'job1/audio-0.mp3',
        originalKey: null,
      });
      assert.deepEqual(action, {
        type: 'transcode',
        sourceKey: 'job1/audio-0.mp3',
        destKey: 'job1/asr-0.mp3',
        bitrate: 32,
      });
    });

    it('attempt 1 on an already-transcoded key resubmits instead of giving up', () => {
      const action = nextClcfRecovery({
        ...BASE,
        attempt: 1,
        key: 'job1/asr-0.mp3',
        originalKey: null,
      });
      assert.deepEqual(action, { type: 'resubmit' });
    });

    it('attempt 2 re-transcodes at reduced bitrate from the retained original', () => {
      const action = nextClcfRecovery({
        ...BASE,
        attempt: 2,
        key: 'job1/asr-0.mp3',
        originalKey: 'job1/audio-0.mp3',
      });
      assert.deepEqual(action, {
        type: 'transcode',
        sourceKey: 'job1/audio-0.mp3',
        destKey: 'job1/asr-0-r2.mp3',
        bitrate: 16,
      });
    });

    it('attempt 2 falls back to the current key when no original is tracked', () => {
      const action = nextClcfRecovery({
        ...BASE,
        attempt: 2,
        key: 'job1/asr-0.mp3',
        originalKey: null,
      });
      assert.deepEqual(action, {
        type: 'transcode',
        sourceKey: 'job1/asr-0.mp3',
        destKey: 'job1/asr-0-r2.mp3',
        bitrate: 16,
      });
    });

    it('reduced bitrate floors at the configured minimum', () => {
      const action = nextClcfRecovery({
        ...BASE,
        baseBitrate: 24,
        attempt: 2,
        key: 'job1/asr-0.mp3',
        originalKey: null,
      });
      assert.equal(action.bitrate, MIN_RECOVERY_BITRATE);
    });

    it('attempt 3 is a final fresh-URL resubmit', () => {
      const action = nextClcfRecovery({
        ...BASE,
        attempt: 3,
        key: 'job1/asr-0-r2.mp3',
        originalKey: 'job1/audio-0.mp3',
      });
      assert.deepEqual(action, { type: 'resubmit' });
    });

    it(`returns null past the attempt cap (${MAX_CLCF_RECOVERIES})`, () => {
      const action = nextClcfRecovery({
        ...BASE,
        attempt: MAX_CLCF_RECOVERIES + 1,
        key: 'job1/asr-0.mp3',
        originalKey: null,
      });
      assert.equal(action, null);
    });

    it('exposes the shared CLCF error code', () => {
      assert.equal(CLCF_ERROR_CODE, 'CONTENT_LENGTH_CHECK_FAILED');
    });
  });
});
