import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  JsonRpcGatewayClient,
  buildHermesWebSocketUrl,
} from './gatewayClient.js';

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  static instances = [];

  static reset() {
    FakeWebSocket.instances = [];
  }

  addEventListener(type, handler, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
    if (options?.once) {
      const wrap = (...args) => {
        this.listeners.get(type)?.delete(wrap);
        handler(...args);
      };
      this.listeners.get(type).delete(handler);
      this.listeners.get(type).add(wrap);
    }
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  emit(type, event = {}) {
    for (const handler of [...(this.listeners.get(type) || [])]) {
      handler(event);
    }
  }

  send(data) {
    this.sent = this.sent || [];
    this.sent.push(data);
  }

  close(code = null, reason = '') {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  fail(code = 4403, reason = 'origin_mismatch') {
    this.readyState = 3;
    this.emit('close', { code, reason });
    this.emit('error');
  }
}

describe('buildHermesWebSocketUrl', () => {
  it('prefixes base path and auth token', () => {
    const url = buildHermesWebSocketUrl({
      path: '/api/ws',
      basePath: '/hermes',
      authParam: ['token', 'abc'],
      protocol: 'https:',
      host: 'dash.example.com',
    });
    assert.equal(url, 'wss://dash.example.com/hermes/api/ws?token=abc');
  });
});

describe('JsonRpcGatewayClient', () => {
  it('resolves RPC results and dispatches events', async () => {
    FakeWebSocket.reset();
    const client = new JsonRpcGatewayClient({
      socketFactory: (url) => new FakeWebSocket(url),
      requestIdPrefix: 't',
    });

    const connectPromise = client.connect('ws://127.0.0.1:9119/api/ws');
    FakeWebSocket.instances[0].open();
    await connectPromise;

    const events = [];
    client.on('message.delta', (event) => events.push(event));

    const requestPromise = client.request('prompt.submit', {
      session_id: 's1',
      text: 'hi',
    });
    const sent = JSON.parse(FakeWebSocket.instances[0].sent[0]);
    assert.equal(sent.method, 'prompt.submit');
    assert.equal(sent.id, 't1');

    FakeWebSocket.instances[0].emit('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: {
          type: 'message.delta',
          session_id: 's1',
          payload: { text: 'Hello' },
        },
      }),
    });

    FakeWebSocket.instances[0].emit('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 't1',
        result: { status: 'streaming' },
      }),
    });

    const result = await requestPromise;
    assert.deepEqual(result, { status: 'streaming' });
    assert.equal(events[0].payload.text, 'Hello');
  });

  it('rejects pending calls on close', async () => {
    FakeWebSocket.reset();
    const client = new JsonRpcGatewayClient({
      socketFactory: (url) => new FakeWebSocket(url),
    });
    const connectPromise = client.connect('ws://127.0.0.1:9119/api/ws');
    FakeWebSocket.instances[0].open();
    await connectPromise;

    const pending = client.request('session.create');
    FakeWebSocket.instances[0].close();
    await assert.rejects(pending, /WebSocket closed/);
    assert.equal(client.connectionState, 'closed');
  });

  it('rejects timed-out requests', async () => {
    FakeWebSocket.reset();
    const client = new JsonRpcGatewayClient({
      socketFactory: (url) => new FakeWebSocket(url),
      requestTimeoutMs: 20,
    });
    const connectPromise = client.connect('ws://127.0.0.1:9119/api/ws');
    FakeWebSocket.instances[0].open();
    await connectPromise;
    await assert.rejects(client.request('session.create'), /timed out/);
  });

  it('disposes failed handshakes and records close diagnostics', async () => {
    FakeWebSocket.reset();
    const client = new JsonRpcGatewayClient({
      socketFactory: (url) => new FakeWebSocket(url),
      connectTimeoutMs: 20,
    });

    const first = client.connect('ws://127.0.0.1:9119/api/ws');
    await assert.rejects(first, /WebSocket connection failed/);
    assert.equal(client.connectionState, 'error');
    assert.equal(client.socket, null);

    const second = client.connect('ws://127.0.0.1:9119/api/ws');
    assert.equal(FakeWebSocket.instances.length, 2);
    FakeWebSocket.instances[1].fail(4403, 'origin_mismatch');
    await assert.rejects(second, /WebSocket connection failed/);
    assert.equal(client.lastCloseInfo?.code, 4403);
    assert.match(client.lastCloseInfo?.reason || '', /origin_mismatch/);
  });
});
