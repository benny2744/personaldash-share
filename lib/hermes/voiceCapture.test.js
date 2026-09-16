import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ASR_SETTLE_TIMEOUT_MS,
  startStreamingTranscription,
} from './voiceCapture.js';

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.listeners = { message: [], error: [], close: [] };
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this._emit('message', {
        data: JSON.stringify({
          type: 'ready',
          mode: 'asr',
          sampleRate: 16000,
        }),
      });
    });
  }

  addEventListener(type, handler) {
    this.listeners[type]?.push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.listeners[type];
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  }

  send(data) {
    this.sent.push(JSON.parse(String(data)));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this._emit('close', {});
  }

  _emit(type, event) {
    for (const handler of this.listeners[type] || []) handler(event);
  }
}

function createAudioContextStub() {
  return class FakeAudioContext {
    constructor() {
      this.sampleRate = 16000;
      this.state = 'running';
    }
    createMediaStreamSource() {
      return {
        connect() {},
        disconnect() {},
      };
    }
    createScriptProcessor() {
      return {
        onaudioprocess: null,
        connect() {},
        disconnect() {},
      };
    }
    createGain() {
      return {
        gain: { value: 1 },
        connect() {},
        disconnect() {},
      };
    }
    async close() {
      this.state = 'closed';
    }
  };
}

async function startTestCapture(overrides = {}) {
  let lastSocket = null;
  class TrackingSocket extends FakeWebSocket {
    constructor(url) {
      super(url);
      lastSocket = this;
    }
  }

  const partials = [];
  const settled = [];
  const capture = await startStreamingTranscription({
    WebSocketCtor: TrackingSocket,
    AudioContextCtor: createAudioContextStub(),
    getUserMedia: async () => ({
      getTracks: () => [{ stop() {} }],
    }),
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          token: 't',
          wsPath: '/api/hermes/voice/ws?token=t',
          mode: 'asr',
        };
      },
    }),
    location: { protocol: 'http:', host: 'localhost' },
    onPartial: (text) => partials.push(text),
    onSettled: (info) => settled.push(info),
    maxSeconds: 0,
    settleTimeoutMs: 50,
    ...overrides,
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  return { capture, partials, settled, getSocket: () => lastSocket };
}

describe('startStreamingTranscription', () => {
  it('returns immediately on stop but still applies delayed finals', async () => {
    const { capture, partials, settled, getSocket } = await startTestCapture({
      settleTimeoutMs: 200,
    });
    const socket = getSocket();

    socket._emit('message', {
      data: JSON.stringify({
        type: 'transcript.partial',
        text: 'hello there',
      }),
    });
    assert.deepEqual(partials, ['hello there']);

    const started = Date.now();
    const latest = capture.stop();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 100, `stop should be immediate, took ${elapsed}ms`);
    assert.equal(latest, 'hello there');
    assert.equal(capture.micStopped, true);
    assert.equal(capture.draftUpdatesEnabled, true);
    assert.ok(socket.sent.some((msg) => msg.type === 'commit'));
    assert.ok(socket.sent.some((msg) => msg.type === 'finish'));

    socket._emit('message', {
      data: JSON.stringify({
        type: 'transcript.final',
        text: 'hello there trailing words',
      }),
    });
    assert.deepEqual(partials, [
      'hello there',
      'hello there trailing words',
    ]);
    assert.equal(capture.draftUpdatesEnabled, false);
    assert.equal(settled[0]?.reason, 'final');
  });

  it('suppressDraftUpdates blocks later finals', async () => {
    const { capture, partials, settled, getSocket } = await startTestCapture({
      settleTimeoutMs: 200,
    });
    const socket = getSocket();

    socket._emit('message', {
      data: JSON.stringify({ type: 'transcript.partial', text: 'one' }),
    });
    capture.stop();
    capture.suppressDraftUpdates();
    assert.equal(capture.draftUpdatesEnabled, false);
    assert.equal(settled[0]?.reason, 'suppressed');

    socket._emit('message', {
      data: JSON.stringify({
        type: 'transcript.final',
        text: 'one two three should not apply',
      }),
    });
    assert.deepEqual(partials, ['one']);
  });

  it('settles on timeout if no final arrives', async () => {
    const { capture, settled } = await startTestCapture({
      settleTimeoutMs: 30,
    });
    capture.stop();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(capture.draftUpdatesEnabled, false);
    assert.equal(settled[0]?.reason, 'timeout');
    assert.ok(ASR_SETTLE_TIMEOUT_MS >= 1000);
  });
});
