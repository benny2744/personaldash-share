import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyLiveVoiceTranscript,
  insertTranscriptIntoDraft,
} from './transcriptDraft.js';

describe('insertTranscriptIntoDraft', () => {
  it('appends with spacing and preserves empty drafts', () => {
    assert.equal(insertTranscriptIntoDraft('', 'hello'), 'hello');
    assert.equal(insertTranscriptIntoDraft('Hi', 'there'), 'Hi there');
    assert.equal(insertTranscriptIntoDraft('Hi ', 'there'), 'Hi there');
    assert.equal(insertTranscriptIntoDraft('Hi', ', there'), 'Hi, there');
    assert.equal(insertTranscriptIntoDraft('Hi', '   '), 'Hi');
  });
});

describe('applyLiveVoiceTranscript', () => {
  it('replaces cumulative hypotheses against a frozen base draft', () => {
    const base = 'Notes:';
    assert.equal(applyLiveVoiceTranscript(base, 'hello'), 'Notes: hello');
    assert.equal(
      applyLiveVoiceTranscript(base, 'hello world'),
      'Notes: hello world',
    );
    assert.equal(applyLiveVoiceTranscript('', 'partial'), 'partial');
  });
});
