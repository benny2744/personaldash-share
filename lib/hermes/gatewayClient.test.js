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
    const submitted = FakeWebSocket.instances[0].sent
      .map((frame) => JSON.parse(frame))
      .find((frame) => frame.method === 'prompt.submit');
    assert.ok(submitted);
    assert.equal(submitted.id, 't1');

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

  it('disposes failed handshakes and records close diagnostics', async () => {    FakeWebSocket.reset();
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

describe('server→client requests (protocol v7 blocking prompts)', () => {
  async function connectClient(options = {}) {
    FakeWebSocket.reset();
    const client = new JsonRpcGatewayClient({
      socketFactory: (url) => new FakeWebSocket(url),
      ...options,
    });
    const connectPromise = client.connect('ws://127.0.0.1:9119/api/ws');
    FakeWebSocket.instances[0].open();
    await connectPromise;
    return client;
  }

  function sentFrames(socket) {
    return (socket.sent || []).map((frame) => JSON.parse(frame));
  }

  it('advertises server_requests capability on connect', async () => {
    await connectClient();
    const caps = sentFrames(FakeWebSocket.instances[0]).find(
      (frame) => frame.method === 'client.capabilities',
    );
    assert.ok(caps, 'capabilities frame should be sent on open');
    assert.equal(caps.params.server_requests, true);
  });

  it('skips the capability advertisement when disabled', async () => {
    await connectClient({ serverRequests: false });
    const caps = sentFrames(FakeWebSocket.instances[0]).find(
      (frame) => frame.method === 'client.capabilities',
    );
    assert.equal(caps, undefined);
  });

  it('routes srq frames to handlers and replies with the result', async () => {
    const client = await connectClient();
    const seen = [];
    client.onServerRequest((request) => {
      seen.push(request);
      return { choice: 'once' };
    });

    FakeWebSocket.instances[0].emit('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 'srq-abc123def456',
        method: 'approval',
        params: { session_id: 's1', command: 'rm -rf /tmp/x' },
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(seen.length, 1);
    assert.equal(seen[0].id, 'srq-abc123def456');
    assert.equal(seen[0].method, 'approval');

    const reply = sentFrames(FakeWebSocket.instances[0]).find(
      (frame) => frame.id === 'srq-abc123def456',
    );
    assert.ok(reply, 'result frame should be sent back');
    assert.deepEqual(reply.result, { choice: 'once' });
  });

  it('answers asynchronously via answerServerRequest after rendering a card', async () => {
    const client = await connectClient();
    client.onServerRequest((request) => {
      if (request.method === 'approval') return undefined; // card shown; user answers later
      return null;
    });

    FakeWebSocket.instances[0].emit('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 'srq-pending01',
        method: 'approval',
        params: { session_id: 's1', command: 'ssh host' },
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      sentFrames(FakeWebSocket.instances[0]).some(
        (frame) => frame.id === 'srq-pending01',
      ),
      false,
      'no reply until the user answers',
    );

    assert.equal(
      client.answerServerRequest('srq-pending01', { choice: 'session' }),
      true,
    );
    const reply = sentFrames(FakeWebSocket.instances[0]).find(
      (frame) => frame.id === 'srq-pending01',
    );
    assert.deepEqual(reply.result, { choice: 'session' });
  });

  it('replies -32601 when a handler explicitly declines (null)', async () => {
    const client = await connectClient();
    client.onServerRequest(() => null);

    FakeWebSocket.instances[0].emit('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 'srq-unknown1',
        method: 'tour',
        params: { session_id: 's1', action: 'start' },
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));

    const reply = sentFrames(FakeWebSocket.instances[0]).find(
      (frame) => frame.id === 'srq-unknown1',
    );
    assert.ok(reply);
    assert.equal(reply.error.code, -32601);
  });

  it('stays silent when every handler returns undefined', async () => {
    const client = await connectClient();
    let called = 0;
    client.onServerRequest(() => {
      called += 1;
      return undefined;
    });

    FakeWebSocket.instances[0].emit('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 'srq-elsewhere',
        method: 'approval',
        params: { session_id: 'other-session', command: 'ls' },
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(called, 1);
    assert.equal(
      sentFrames(FakeWebSocket.instances[0]).some(
        (frame) => frame.id === 'srq-elsewhere',
      ),
      false,
      'a non-owned request must stay open for other clients',
    );
  });

  it('replies -32603 when a handler throws', async () => {
    const client = await connectClient();
    client.onServerRequest(() => {
      throw new Error('boom');
    });

    FakeWebSocket.instances[0].emit('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 'srq-throw001',
        method: 'approval',
        params: { session_id: 's1' },
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));

    const reply = sentFrames(FakeWebSocket.instances[0]).find(
      (frame) => frame.id === 'srq-throw001',
    );
    assert.ok(reply);
    assert.equal(reply.error.code, -32603);
    assert.match(reply.error.message, /boom/);
  });

  it('still resolves pending client requests when srq frames arrive', async () => {
    const client = await connectClient();
    const requestPromise = client.request('session.usage', {
      session_id: 's1',
    });
    FakeWebSocket.instances[0].emit('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 'srq-midturn12',
        method: 'secret',
        params: { session_id: 's1', env_var: 'API_KEY', prompt: 'Key?' },
      }),
    });
    FakeWebSocket.instances[0].emit('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: 'r1',
        result: { total: 42 },
      }),
    });
    assert.deepEqual(await requestPromise, { total: 42 });
  });
});
