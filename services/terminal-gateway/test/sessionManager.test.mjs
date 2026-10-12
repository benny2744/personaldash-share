/**
 * Session lifecycle end-to-end over fakes: attach → bridge → detach →
 * grace reattach → close. Also authorization/ownership rejections.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { createSessionManager } from '../lib/sessionManager.js';
import {
  fakePool,
  fakeSshFactory,
  seedSession,
  testConfig,
  FakeSocket,
} from './fakes.js';

function b64url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function makeLease(sessionId, identity, secret = 'test-secret') {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    kind: 'terminal',
    sid: sessionId,
    sub: identity,
    iat: now,
    exp: now + 300,
    jti: `jti-${Math.random().toString(36).slice(2)}`,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

const SMALL_LIMITS = {
  idleTimeoutSeconds: 900,
  maxSessionSeconds: 900,
  graceSeconds: 900,
};

void SMALL_LIMITS;

function setup(stateOverrides = {}, sshOverrides = {}, limits = SMALL_LIMITS) {
  const state = { sessions: new Map() };
  seedSession(state, stateOverrides);
  const pool = fakePool(state);
  const ssh = fakeSshFactory(sshOverrides);
  const audits = [];
  const manager = createSessionManager({
    pool,
    sshFactory: ssh,
    config: testConfig(),
    audit: {
      info: (event, fields) => audits.push({ event, fields }),
      warn: (event, fields) => audits.push({ event, fields }),
      error: (event, fields) => audits.push({ event, fields }),
    },
    getLimits: async () => limits,
  });
  return { state, pool, ssh, audits, manager };
}

const NOW = {}; // leases are minted against the real clock

void NOW;

test('attach bridges input/output and persists closed on shell exit', async () => {
  const { manager, ssh, state } = setup();
  const ws = new FakeSocket();
  const lease = makeLease('sess-1', 'alice@example.com');

  const result = await manager.attach({
    sessionId: 'sess-1',
    lease,
    ws,
    cols: 100,
    rows: 30,
  });
  assert.equal(result.ok, true);
  assert.equal(ssh.calls.length, 1);
  assert.equal(ssh.calls[0].sshHost, '192.0.2.5');
  assert.equal(ssh.calls[0].hostKeySha256, 'SHA256:AAAA');
  assert.equal(state.sessions.get('sess-1').status, 'active');
  assert.deepEqual(ws.frames('status')[0], { type: 'status', state: 'active' });

  // Client input reaches the channel; channel output reaches the client.
  ws.message({
    type: 'input',
    data: Buffer.from('echo hi\n').toString('base64'),
  });
  assert.equal(ssh.current.channel.written[0].toString('utf8'), 'echo hi\n');
  ssh.current.channel.emitData('hello\n');
  const output = ws.frames('output')[0];
  assert.equal(Buffer.from(output.data, 'base64').toString('utf8'), 'hello\n');

  // Shell exit closes the session and persists terminal state.
  ssh.current.channel.emitExit(0);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.sessions.get('sess-1').status, 'closed');
  assert.equal(state.sessions.get('sess-1').bytes_out, 'hello\n'.length);
  assert.equal(state.sessions.get('sess-1').bytes_in, 'echo hi\n'.length);
});

test('bad lease / wrong identity / wrong owner are rejected', async () => {
  {
    const { manager } = setup();
    const result = await manager.attach({
      sessionId: 'sess-1',
      lease: makeLease('sess-1', 'alice@example.com', 'wrong-secret'),
      ws: new FakeSocket(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  }
  {
    const { manager } = setup();
    const result = await manager.attach({
      sessionId: 'sess-1',
      lease: makeLease('sess-other', 'alice@example.com'),
      ws: new FakeSocket(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  }
  {
    // Lease identifies mallory but the session belongs to alice.
    const { manager } = setup();
    const result = await manager.attach({
      sessionId: 'sess-1',
      lease: makeLease('sess-1', 'mallory@example.com'),
      ws: new FakeSocket(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  }
  {
    // Identity not on the host allow-list.
    const { state, manager } = setup();
    seedSession(state, {
      id: 'sess-2',
      identity: 'bob@example.com',
      allowedIdentities: [],
    });
    const result = await manager.attach({
      sessionId: 'sess-2',
      lease: makeLease('sess-2', 'bob@example.com'),
      ws: new FakeSocket(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  }
});

test('second attach while active is rejected (single attachment)', async () => {
  const { manager } = setup();
  const ws1 = new FakeSocket();
  await manager.attach({
    sessionId: 'sess-1',
    lease: makeLease('sess-1', 'alice@example.com'),
    ws: ws1,
  });
  const result = await manager.attach({
    sessionId: 'sess-1',
    lease: makeLease('sess-1', 'alice@example.com'),
    ws: new FakeSocket(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
});

test('detach starts grace; reattach reuses the SSH channel', async () => {
  const { manager, ssh, state } = setup();
  const ws1 = new FakeSocket();
  await manager.attach({
    sessionId: 'sess-1',
    lease: makeLease('sess-1', 'alice@example.com'),
    ws: ws1,
  });
  const channelBefore = ssh.current.channel;

  ws1.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.sessions.get('sess-1').status, 'grace');

  const ws2 = new FakeSocket();
  const result = await manager.attach({
    sessionId: 'sess-1',
    lease: makeLease('sess-1', 'alice@example.com'),
    ws: ws2,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reattached, true);
  assert.equal(ssh.calls.length, 1, 'no second SSH dial');
  assert.equal(ssh.current.channel, channelBefore, 'same channel reused');

  // New socket is bridged.
  ws2.message({ type: 'input', data: Buffer.from('id\n').toString('base64') });
  assert.equal(ssh.current.channel.written[0].toString('utf8'), 'id\n');
  assert.equal(state.sessions.get('sess-1').status, 'active');
});

test('grace expiry closes the SSH channel and the session', async () => {
  const timers = [];
  const fakeTimers = {
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      if (t) t.cleared = true;
    },
    setInterval: () => 1,
    clearInterval: () => {},
  };
  const state = { sessions: new Map() };
  seedSession(state);
  const pool = fakePool(state);
  const ssh = fakeSshFactory();
  const manager = createSessionManager({
    pool,
    sshFactory: ssh,
    config: testConfig(),
    timers: fakeTimers,
    getLimits: async () => ({
      idleTimeoutSeconds: 900,
      maxSessionSeconds: 900,
      graceSeconds: 1,
    }),
  });
  const ws = new FakeSocket();
  await manager.attach({
    sessionId: 'sess-1',
    lease: makeLease('sess-1', 'alice@example.com'),
    ws,
  });

  ws.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.sessions.get('sess-1').status, 'grace');

  // Fire the grace timer (sessionManager registered it via injected timers).
  const graceTimer = timers.filter((t) => !t.cleared && t.ms === 1000).pop();
  assert.ok(graceTimer, 'grace timer registered');
  graceTimer.fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ssh.current.ended, true);
  assert.equal(state.sessions.get('sess-1').status, 'closed');
});

test('unpinned host key fails the session closed as failed', async () => {
  const { manager, state, audits } = setup({ hostKeySha256: null });
  const ws = new FakeSocket();
  const result = await manager.attach({
    sessionId: 'sess-1',
    lease: makeLease('sess-1', 'alice@example.com'),
    ws,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.sessions.get('sess-1').status, 'failed');
  assert.ok(
    audits.some((a) => a.event === 'terminal.session.failed'),
    'failure audited',
  );
});

test('idle timeout closes an otherwise active session', async () => {
  const timers = [];
  const fakeTimers = {
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      if (t) t.cleared = true;
    },
    setInterval: () => 1,
    clearInterval: () => {},
  };
  const state = { sessions: new Map() };
  seedSession(state);
  const pool = fakePool(state);
  const ssh = fakeSshFactory();
  const manager = createSessionManager({
    pool,
    sshFactory: ssh,
    config: testConfig(),
    timers: fakeTimers,
    getLimits: async () => ({
      idleTimeoutSeconds: 1,
      maxSessionSeconds: 900,
      graceSeconds: 900,
    }),
  });

  const ws = new FakeSocket();
  await manager.attach({
    sessionId: 'sess-1',
    lease: makeLease('sess-1', 'alice@example.com'),
    ws,
  });

  const idleTimer = timers.find((t) => !t.cleared && t.ms === 1000);
  assert.ok(idleTimer, 'idle timer registered');
  idleTimer.fn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ssh.current.ended, true);
  assert.equal(state.sessions.get('sess-1').status, 'closed');
});

test('fatal client frames close the socket with protocol code', async () => {
  const { manager, ssh } = setup();
  const ws = new FakeSocket();
  await manager.attach({
    sessionId: 'sess-1',
    lease: makeLease('sess-1', 'alice@example.com'),
    ws,
  });
  ws.emit('message', Buffer.from('garbage-not-json', 'utf8'));
  assert.ok(ws.frames('error').length >= 1);
  assert.equal(ws.readyState, 3); // CLOSED via ws.close()
  // Grace starts after the protocol close.
  void ssh;
});
