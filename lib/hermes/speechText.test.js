import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  markdownToSpeechText,
  prepareSpeechText,
  TTS_MAX_CHARS,
} from './speechText.js';

describe('speechText', () => {
  it('strips markdown chrome and validates length', () => {
    assert.equal(
      markdownToSpeechText('Hello **world** see https://example.com'),
      'Hello world see',
    );
    assert.equal(prepareSpeechText('').ok, false);
    assert.equal(prepareSpeechText('Speakable').ok, true);
    assert.equal(
      prepareSpeechText('a'.repeat(TTS_MAX_CHARS + 1)).status,
      413,
    );
  });
});
