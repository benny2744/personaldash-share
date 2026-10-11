import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canSpeakReply,
  createReplyPlaybackController,
  playbackButtonLabel,
  playbackButtonState,
} from './voicePlayback.js';

describe('canSpeakReply', () => {
  it('allows completed non-empty assistant replies only', () => {
    assert.equal(
      canSpeakReply({ role: 'assistant', content: 'Hi', streaming: false }),
      true,
    );
    assert.equal(
      canSpeakReply({ role: 'assistant', content: 'Hi', streaming: true }),
      false,
    );
    assert.equal(canSpeakReply({ role: 'user', content: 'Hi' }), false);
    assert.equal(canSpeakReply({ role: 'assistant', content: '   ' }), false);
  });
});

describe('playbackButtonState', () => {
  it('only surfaces active reply state', () => {
    assert.equal(playbackButtonState('playing', 'a', 'a'), 'playing');
    assert.equal(playbackButtonState('playing', 'a', 'b'), 'idle');
    assert.equal(playbackButtonLabel('playing'), 'Stop playback');
  });
});

describe('createReplyPlaybackController', () => {
  it('enforces one active reply and aborts superseded requests', async () => {
    const snapshots = [];
    const revoked = [];
    let fetchCount = 0;

    class FakeAudio {
      constructor(url) {
        this.url = url;
        this.onended = null;
        this.onerror = null;
      }
      async play() {
        return undefined;
      }
      pause() {}
    }

    const controller = createReplyPlaybackController({
      preferStreaming: false,
      AudioCtor: FakeAudio,
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: (url) => revoked.push(url),
      fetchImpl: async () => {
        fetchCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          ok: true,
          async blob() {
            return new Blob([new Uint8Array([1, 2, 3])], {
              type: 'audio/wav',
            });
          },
        };
      },
    });

    controller.subscribe((snap) => snapshots.push({ ...snap }));

    const first = controller.toggle('msg-1', 'Hello one');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = controller.toggle('msg-2', 'Hello two');
    await Promise.allSettled([first, second]);

    const final = controller.getSnapshot();
    assert.equal(final.activeId, 'msg-2');
    assert.equal(final.state, 'playing');
    assert.equal(fetchCount, 2);

    controller.toggle('msg-2', 'Hello two');
    assert.equal(controller.getSnapshot().state, 'idle');
    assert.equal(controller.getSnapshot().activeId, null);
    assert.ok(revoked.includes('blob:fake'));

    controller.dispose();
  });
});
