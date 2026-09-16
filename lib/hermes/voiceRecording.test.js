import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canStartRecording,
  extensionForMime,
  pickRecorderMimeType,
} from './voiceRecording.js';

describe('canStartRecording', () => {
  it('allows idle/error and blocks offline/disabled/busy', () => {
    assert.equal(canStartRecording('idle'), true);
    assert.equal(canStartRecording('error'), true);
    assert.equal(canStartRecording('recording'), false);
    assert.equal(canStartRecording('idle', { offline: true }), false);
    assert.equal(canStartRecording('idle', { disabled: true }), false);
    assert.equal(canStartRecording('idle', { busy: true }), false);
  });
});

describe('pickRecorderMimeType', () => {
  it('returns the first supported type', () => {
    const mime = pickRecorderMimeType({
      isTypeSupported: (type) => type === 'audio/webm',
    });
    assert.equal(mime, 'audio/webm');
  });

  it('returns empty when unsupported', () => {
    assert.equal(
      pickRecorderMimeType({ isTypeSupported: () => false }),
      '',
    );
  });
});

describe('extensionForMime', () => {
  it('maps common recorder MIME types', () => {
    assert.equal(extensionForMime('audio/webm;codecs=opus'), 'webm');
    assert.equal(extensionForMime('audio/ogg'), 'ogg');
    assert.equal(extensionForMime('audio/mp4'), 'm4a');
  });
});
