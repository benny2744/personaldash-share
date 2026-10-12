/**
 * Test doubles for the terminal-gateway session manager.
 * No real ssh2/ws/pg — everything is a minimal in-process fake.
 */

import { EventEmitter } from 'node:events';

export const OPEN = 1;
export const CLOSED = 3;

/** Minimal WebSocket stand-in compatible with sessionManager's usage. */
export class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = OPEN;
    this.bufferedAmount = 0;
    this.sent = [];
  }
  send(raw) {
    if (this.readyState !== OPEN) throw new Error('not open');
    this.sent.push(JSON.parse(raw));
  }
  close() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    queueMicrotask(() => this.emit('close', 1000, 'fake'));
  }
  terminate() {
    this.close();
  }
  ping() {}
  /** Drive a client frame into the manager. */
  message(object) {
    this.emit('message', Buffer.from(JSON.stringify(object), 'utf8'));
  }
  get last() {
    return this.sent[this.sent.length - 1] || null;
  }
  frames(type) {
    return this.sent.filter((frame) => frame.type === type);
  }
}

/** Minimal ssh2 shell channel + transport. */
export class FakeChannel extends EventEmitter {
  constructor() {
    super();
    this.written = [];
  }
  write(data) {
    this.written.push(data);
    return true;
  }
  setWindow() {}
  end() {
    queueMicrotask(() => this.emit('close'));
  }
  /** Test helper: emit output bytes. */
  emitData(text) {
    this.emit('data', Buffer.from(text, 'utf8'));
  }
  /** Test helper: simulate the shell exiting. */
  emitExit(code) {
    this.emit('exit', code);
    this.emit('close');
  }
}

/**
 * Fake ssh factory. `opts.reject` controls connect failures;
 * tracks connect calls so tests can assert reattach reuses the channel.
 */
export function fakeSshFactory(opts = {}) {
  const calls = [];
  let current = null;
  return {
    calls,
    get current() {
      return current;
    },
    async connect(params) {
      calls.push(params);
      if (opts.rejectOnConnect) {
        throw Object.assign(new Error(opts.rejectReason || 'dial failed'), {
          code: opts.rejectCode || 'SSH_ERROR',
        });
      }
      if (!params.hostKeySha256) {
        throw Object.assign(new Error('unpinned'), {
          code: 'HOSTKEY_UNPINNED',
        });
      }
      current = {
        channel: new FakeChannel(),
        end() {
          this.ended = true;
        },
        resize() {
          this.resized = this.resized || [];
          this.resized.push(arguments);
        },
      };
      return current;
    },
    async fingerprint({ sshHost, sshPort }) {
      calls.push({ fingerprint: true, sshHost, sshPort });
      return { fingerprint: 'SHA256:fakefingerprint' };
    },
  };
}

/**
 * Fake pg pool implementing only the statements sessionManager issues.
 * Backed by plain objects: { sessions: Map, hosts: Map, settings: Map }.
 */
export function fakePool(state = { sessions: new Map() }) {
  const transitions = [];
  async function query(sql, values) {
    if (sql.includes('FROM terminal_sessions s')) {
      const id = values[0];
      const session = state.sessions.get(id);
      if (!session) return { rows: [], rowCount: 0 };
      const host = (state.hosts || new Map()).get(session.host_id) || {};
      return {
        rowCount: 1,
        rows: [
          {
            id: session.id,
            identity: session.identity,
            status: session.status,
            host_id: session.host_id,
            host_slug: host.slug,
            display_name: host.display_name,
            ssh_host: host.ssh_host,
            ssh_port: host.ssh_port,
            ssh_user: host.ssh_user,
            credential_ref: host.credential_ref,
            host_key_sha256: host.host_key_sha256,
            allowed_identities: host.allowed_identities,
            host_enabled: host.enabled !== false,
          },
        ],
      };
    }
    if (sql.startsWith('UPDATE terminal_sessions SET status')) {
      const [id, fromStates, toState] = values;
      const session = state.sessions.get(id);
      const ok = session && fromStates.includes(session.status);
      transitions.push({ id, fromStates, toState, ok });
      if (ok) {
        session.status = toState;
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    }
    if (sql.includes('bytes_in = bytes_in +')) {
      const [id, bytesIn, bytesOut] = values;
      const session = state.sessions.get(id);
      if (session) {
        session.bytes_in = (session.bytes_in || 0) + Number(bytesIn);
        session.bytes_out = (session.bytes_out || 0) + Number(bytesOut);
      }
      return { rowCount: session ? 1 : 0 };
    }
    if (sql.includes('FROM app_settings')) {
      return { rows: state.settings ? [...state.settings] : [], rowCount: 0 };
    }
    throw new Error(`fakePool: unexpected statement: ${sql.slice(0, 60)}`);
  }
  return { query, state, transitions };
}

export function seedSession(state, overrides = {}) {
  const id = overrides.id || 'sess-1';
  const session = {
    id,
    identity: overrides.identity || 'alice@example.com',
    status: overrides.status || 'pending',
    host_id: overrides.host_id || 'host-1',
    bytes_in: 0,
    bytes_out: 0,
  };
  state.sessions.set(id, session);
  state.hosts = state.hosts || new Map();
  state.hosts.set(session.host_id, {
    slug: 'vm-1',
    display_name: 'VM 1',
    ssh_host: '192.0.2.5',
    ssh_port: 22,
    ssh_user: 'deploy',
    credential_ref: 'default',
    host_key_sha256:
      overrides.hostKeySha256 === null
        ? null
        : (overrides.hostKeySha256 ?? 'SHA256:AAAA'),
    allowed_identities: overrides.allowedIdentities ?? ['alice@example.com'],
    enabled: overrides.hostEnabled ?? true,
  });
  return session;
}

export function testConfig(overrides = {}) {
  return {
    leaseSecret: 'test-secret',
    keyDir: '/run/terminal-keys',
    maxFrameBytes: 96 * 1024,
    maxInputBytes: 64 * 1024,
    maxBufferedOutputBytes: 4 * 1024 * 1024,
    counterFlushMs: 60_000,
    defaults: {
      'terminal.idleTimeoutSeconds': 900,
      'terminal.maxSessionSeconds': 28800,
      'terminal.graceSeconds': 60,
    },
    ...overrides,
  };
}
