/**
 * services/terminal-gateway/lib/sessionManager.js — terminal session state
 * machine: lease-verified attach, SSH bridge, idle/max timers, disconnect
 * grace with reattach, byte counters, audit metadata (no content capture).
 *
 * Lifecycle: pending → active → grace → closed (or failed at any step).
 * A grace reattach REUSES the live SSH channel (within terminal.graceSeconds);
 * once the grace lapses the channel is closed — no persistence (V1, by design).
 */

import { canAccessHost } from './authz.js';
import {
  flushCounters,
  getSessionWithHost,
  transitionSession,
} from './db.js';
import {
  encodeServerFrame,
  parseClientFrame,
} from './protocol.js';
import { verifyTerminalLease } from './lease.js';

function consoleAudit(level, event, fields) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    component: 'terminal-gateway',
    ...fields,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {object} deps.sshFactory  defaultSshFactory() output (injectable)
 * @param {object} deps.config      getConfig() output
 * @param {object} [deps.limitsCache]
 * @param {object} [deps.audit]
 * @param {object} [deps.getLimits]
 */
export function createSessionManager(deps) {
  const { pool, sshFactory, config } = deps;
  const audit = deps.audit || {
    info: (event, fields) => consoleAudit('info', event, fields),
    warn: (event, fields) => consoleAudit('warn', event, fields),
    error: (event, fields) => consoleAudit('error', event, fields),
  };
  const getLimits = deps.getLimits;
  const timers = deps.timers || globalThis;

  // Unref long-lived timers (when the environment supports it) so they never
  // keep the process alive on their own.
  const watch = (handle) => {
    if (handle && typeof handle.unref === 'function') handle.unref();
    return handle;
  };

  /** sessionId → live entry (active or grace) */
  const live = new Map();

  function send(entry, frame) {
    const ws = entry?.ws;
    if (!ws || ws.readyState !== 1 /* OPEN */) return;
    if (ws.bufferedAmount > config.maxBufferedOutputBytes) {
      // Backpressure: drop output rather than buffer without bound.
      entry.droppedOutput += 1;
      return;
    }
    try {
      ws.send(encodeServerFrame(frame));
    } catch {}
  }

  function status(entry, state, message) {
    send(entry, { type: 'status', state, ...(message ? { message } : {}) });
  }

  function resetIdleTimer(entry) {
    if (entry.idleTimer) timers.clearTimeout(entry.idleTimer);
    entry.idleTimer = watch(
      timers.setTimeout(() => {
        close(entry.sessionId, 'idle_timeout');
      }, entry.limits.idleTimeoutSeconds * 1000),
    );
  }

  function startGrace(entry) {
    entry.state = 'grace';
    status(entry, 'grace');
    entry.graceTimer = watch(
      timers.setTimeout(() => {
        close(entry.sessionId, 'grace_expired');
      }, entry.limits.graceSeconds * 1000),
    );
  }

  function clearTimers(entry) {
    for (const key of ['idleTimer', 'graceTimer', 'maxTimer', 'flushTimer']) {
      if (entry[key]) {
        if (key === 'flushTimer') timers.clearInterval(entry[key]);
        else timers.clearTimeout(entry[key]);
        entry[key] = null;
      }
    }
  }

  /** Final teardown: close SSH + WS, persist terminal state, audit. */
  async function close(sessionId, reason, { failed = false } = {}) {
    const entry = live.get(sessionId);
    live.delete(sessionId);
    if (entry) {
      clearTimers(entry);
      const ws = entry.ws;
      if (ws && ws.readyState === 1) {
        send(entry, {
          type: failed ? 'error' : 'exit',
          ...(failed ? { message: reason } : { reason }),
        });
        try {
          ws.close(1000, failed ? 'failed' : 'closed');
        } catch {}
      }
      try {
        entry.ssh?.end?.();
      } catch {}
    }

    try {
      const toState = failed ? 'failed' : 'closed';
      const applied = await transitionSession(
        pool,
        sessionId,
        ['pending', 'active', 'grace'],
        toState,
        { closedAt: new Date(), closeReason: reason },
      );

      if (entry) {
        await flushPendingCounters(sessionId, entry, { final: true });
        audit.info(failed ? 'terminal.session.failed' : 'terminal.session.closed', {
          sessionId,
          identity: entry.identity,
          hostSlug: entry.hostSlug,
          reason,
          bytesIn: entry.counters.in,
          bytesOut: entry.counters.out,
          droppedOutput: entry.droppedOutput,
          persisted: applied,
        });
      } else {
        audit.info('terminal.session.closed', {
          sessionId,
          reason,
          persisted: applied,
        });
      }
    } catch (error) {
      audit.error('terminal.session.close_persist_failed', {
        sessionId,
        reason,
        error: error.message,
      });
    }
  }

  async function flushPendingCounters(sessionId, entry, { final = false } = {}) {
    const bytesIn = entry.counters.in - entry.flushed.in;
    const bytesOut = entry.counters.out - entry.flushed.out;
    if (bytesIn <= 0 && bytesOut <= 0) return;
    entry.flushed.in += bytesIn;
    entry.flushed.out += bytesOut;
    try {
      await flushCounters(pool, sessionId, bytesIn, bytesOut);
    } catch (error) {
      if (final) throw error;
      audit.warn('terminal.counters.flush_failed', {
        sessionId,
        error: error.message,
      });
    }
  }

  function wireSshChannel(entry) {
    const { channel } = entry.ssh;
    channel.on('data', (chunk) => {
      entry.counters.out += chunk.length;
      send(entry, { type: 'output', data: chunk });
    });
    channel.stderr?.on?.('data', (chunk) => {
      entry.counters.out += chunk.length;
      send(entry, { type: 'output', data: chunk });
    });
    channel.on('exit', (code) => {
      entry.exitCode = typeof code === 'number' ? code : null;
    });
    channel.on('close', () => {
      close(entry.sessionId, entry.exitCode === null || entry.exitCode === undefined
        ? 'ssh_closed'
        : `exit_${entry.exitCode}`);
    });
  }

  function wireSocket(entry) {
    const { ws } = entry;
    ws.on('message', (raw) => {
      const result = parseClientFrame(raw.toString('utf8'), config);
      if (!result.ok) {
        if (result.fatal) {
          audit.warn('terminal.frame.rejected', {
            sessionId: entry.sessionId,
            reason: result.reason,
          });
          send(entry, { type: 'error', message: result.reason });
          try {
            ws.close(1008, 'protocol');
          } catch {}
          return;
        }
        return;
      }
      const frame = result.frame;
      if (frame.type === 'input') {
        entry.counters.in += frame.data.length;
        entry.lastInputAt = Date.now();
        resetIdleTimer(entry);
        try {
          entry.ssh.channel.write(frame.data);
        } catch {}
      } else if (frame.type === 'resize') {
        entry.ssh.resize(frame.cols, frame.rows);
      } else if (frame.type === 'ping') {
        send(entry, { type: 'pong' });
      }
    });
    ws.on('close', () => {
      if (live.get(entry.sessionId) !== entry) return; // replaced by reattach
      entry.ws = null;
      // Persist the grace transition (fire-and-forget; grace close handles
      // the terminal state if no reattach arrives).
      transitionSession(pool, entry.sessionId, ['active'], 'grace').catch(() => {});
      startGrace(entry);
      audit.info('terminal.session.detached', {
        sessionId: entry.sessionId,
        identity: entry.identity,
        hostSlug: entry.hostSlug,
      });
    });
    ws.on('error', () => {
      try {
        ws.terminate();
      } catch {}
    });
  }

  /**
   * Attach a verified WebSocket to a session.
   * @param {{ sessionId: string, lease: string, ws: WebSocket, requestMeta?: object }} params
   * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string }>}
   */
  async function attach(params) {
    const { sessionId } = params;

    // 1. Lease verification (HMAC, bound to session id).
    let lease;
    try {
      lease = verifyTerminalLease(params.lease, {
        secret: config.leaseSecret,
        expectedSessionId: sessionId,
      });
    } catch (error) {
      audit.warn('terminal.attach.lease_rejected', { sessionId });
      return {
        ok: false,
        status: Number(error?.status) || 401,
        error: error.message,
      };
    }

    // 2. Single-attachment guard.
    const existing = live.get(sessionId);
    if (existing && existing.ws && existing.ws.readyState === 1) {
      return { ok: false, status: 409, error: 'Session is already attached' };
    }

    // 3. Load session + host; verify ownership + authorization + status.
    const row = await getSessionWithHost(pool, sessionId);
    if (!row) return { ok: false, status: 404, error: 'Session not found' };
    if (row.identity !== lease.sub) {
      audit.warn('terminal.attach.identity_mismatch', {
        sessionId,
        leaseIdentity: lease.sub,
      });
      return { ok: false, status: 403, error: 'Session belongs to another user' };
    }
    if (row.host_enabled === false) {
      return { ok: false, status: 409, error: 'Host is disabled' };
    }
    if (!canAccessHost(row.identity, row)) {
      audit.warn('terminal.authz.denied', {
        sessionId,
        identity: row.identity,
        hostSlug: row.host_slug,
        action: 'ws.attach',
      });
      return { ok: false, status: 403, error: 'You do not have access to this host' };
    }
    if (!['pending', 'grace'].includes(row.status)) {
      return { ok: false, status: 409, error: `Session is ${row.status}` };
    }

    const limits = getLimits
      ? await getLimits()
      : {
          idleTimeoutSeconds: config.defaults['terminal.idleTimeoutSeconds'],
          maxSessionSeconds: config.defaults['terminal.maxSessionSeconds'],
          graceSeconds: config.defaults['terminal.graceSeconds'],
        };

    // 4. Grace reattach: reuse the live SSH channel.
    if (existing) {
      timers.clearTimeout(existing.graceTimer);
      existing.graceTimer = null;
      existing.state = 'active';
      existing.ws = params.ws;
      const applied = await transitionSession(pool, sessionId, ['grace'], 'active');
      wireSocket(existing);
      status(existing, 'active');
      audit.info('terminal.session.reattached', {
        sessionId,
        identity: row.identity,
        hostSlug: row.host_slug,
        persisted: applied,
      });
      return { ok: true, reattached: true };
    }

    // 5. Fresh attach: claim status then dial SSH.
    const claimed = await transitionSession(pool, sessionId, ['pending', 'grace'], 'active', {
      connectedAt: new Date(),
    });
    if (!claimed) {
      return { ok: false, status: 409, error: `Session is ${row.status}` };
    }

    const entry = {
      sessionId,
      identity: row.identity,
      hostSlug: row.host_slug,
      ws: params.ws,
      ssh: null,
      state: 'active',
      limits,
      counters: { in: 0, out: 0 },
      flushed: { in: 0, out: 0 },
      droppedOutput: 0,
      exitCode: null,
      idleTimer: null,
      graceTimer: null,
      maxTimer: null,
      flushTimer: null,
    };
    live.set(sessionId, entry);

    try {
      entry.ssh = await sshFactory.connect({
        sshHost: row.ssh_host,
        sshPort: row.ssh_port,
        sshUser: row.ssh_user,
        credentialRef: row.credential_ref,
        keyDir: config.keyDir,
        hostKeySha256: row.host_key_sha256,
        cols: params.cols,
        rows: params.rows,
      });
    } catch (error) {
      const reason =
        error?.code === 'HOSTKEY_MISMATCH'
          ? 'host_key_mismatch'
          : error?.code === 'HOSTKEY_UNPINNED'
            ? 'host_key_unpinned'
            : error?.code === 'KEY_NOT_FOUND'
              ? 'credential_missing'
              : error?.code === 'AUTH_FAILED'
                ? 'ssh_auth_failed'
                : 'ssh_connect_failed';
      audit.error('terminal.session.failed', {
        sessionId,
        identity: row.identity,
        hostSlug: row.host_slug,
        reason,
        detail: error?.code || error?.message,
      });
      await close(sessionId, reason, { failed: true });
      return {
        ok: false,
        status: 502,
        error:
          error?.code === 'HOSTKEY_MISMATCH'
            ? 'Host key fingerprint mismatch — connection refused'
            : error?.code === 'AUTH_FAILED'
              ? 'SSH authentication failed'
              : `Could not connect: ${reason.replaceAll('_', ' ')}`,
      };
    }

    wireSshChannel(entry);
    wireSocket(entry);

    entry.maxTimer = watch(
      timers.setTimeout(() => {
        close(sessionId, 'max_duration');
      }, limits.maxSessionSeconds * 1000),
    );
    entry.flushTimer = watch(
      timers.setInterval(() => {
        flushPendingCounters(sessionId, entry, { final: false });
      }, config.counterFlushMs),
    );
    resetIdleTimer(entry);

    status(entry, 'active');
    audit.info('terminal.session.attached', {
      sessionId,
      identity: row.identity,
      hostSlug: row.host_slug,
      sshHost: row.ssh_host,
      sshPort: row.ssh_port,
    });
    return { ok: true, reattached: false };
  }

  /** Internal fingerprint probe (learn flow) — no auth, no credentials. */
  async function fingerprint({ host, port }) {
    return sshFactory.fingerprint({ sshHost: host, sshPort: port });
  }

  async function shutdown() {
    const ids = [...live.keys()];
    await Promise.all(ids.map((id) => close(id, 'gateway_shutdown')));
  }

  function stats() {
    return {
      liveSessions: live.size,
      sessions: [...live.values()].map((entry) => ({
        sessionId: entry.sessionId,
        identity: entry.identity,
        hostSlug: entry.hostSlug,
        state: entry.state,
        bytesIn: entry.counters.in,
        bytesOut: entry.counters.out,
      })),
    };
  }

  return { attach, close, fingerprint, shutdown, stats, live };
}
