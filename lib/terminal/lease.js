/**
 * lib/terminal/lease.js — short-lived HMAC leases for the terminal-gateway
 * sidecar. Mirrors the voiceLease.js envelope (verified by cross-tests in
 * services/terminal-gateway/test) so both tiers share one secret format.
 * The secret stays server-side (app + sidecar); the browser only receives
 * the opaque token bound to (sessionId, identity).
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const TERMINAL_LEASE_TTL_SEC = 30;

function stripEnvQuotes(value) {
  const trimmed = String(value || '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function b64url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function b64urlJson(object) {
  return b64url(Buffer.from(JSON.stringify(object), 'utf8'));
}

export function getTerminalLeaseConfig() {
  const secret = stripEnvQuotes(process.env.TERMINAL_LEASE_SECRET || '');
  const gatewayUrl = stripEnvQuotes(
    process.env.TERMINAL_GATEWAY_URL || 'http://terminal-gateway:3016',
  ).replace(/\/+$/, '');
  const publicWsPath = stripEnvQuotes(
    process.env.TERMINAL_PUBLIC_WS_PATH || '/api/terminal/ws',
  );
  return {
    secret,
    gatewayUrl,
    publicWsPath,
    configured: Boolean(secret),
  };
}

/**
 * Issue a terminal attach lease.
 * @param {{ sessionId: string, identity: string, ttlSeconds?: number, now?: number, jti?: string }} params
 */
export function issueTerminalLease({ sessionId, identity, ttlSeconds, now, jti }) {
  const config = getTerminalLeaseConfig();
  if (!config.configured) {
    throw Object.assign(
      new Error('TERMINAL_LEASE_SECRET is not configured for the terminal'),
      { status: 503 },
    );
  }
  if (!sessionId || typeof sessionId !== 'string') {
    throw Object.assign(new Error('sessionId is required'), { status: 400 });
  }
  if (!identity || typeof identity !== 'string') {
    throw Object.assign(new Error('identity is required'), { status: 400 });
  }

  const issuedAt =
    Number.isFinite(now) ? now : Math.floor(Date.now() / 1000);
  const ttl = Number.isFinite(ttlSeconds)
    ? Math.max(5, Math.min(300, Math.floor(ttlSeconds)))
    : TERMINAL_LEASE_TTL_SEC;
  const payload = {
    v: 1,
    kind: 'terminal',
    sid: sessionId,
    sub: identity,
    iat: issuedAt,
    exp: issuedAt + ttl,
    jti: jti || randomUUID(),
  };
  const body = b64urlJson(payload);
  const sig = b64url(createHmac('sha256', config.secret).update(body).digest());
  return {
    token: `${body}.${sig}`,
    expiresAt: payload.exp,
    wsPath: `${config.publicWsPath}?session=${encodeURIComponent(sessionId)}&lease=${encodeURIComponent(`${body}.${sig}`)}`,
  };
}

/**
 * Verify a terminal attach lease (shared implementation shape with the
 * sidecar's verifier). Throws { status: 401|503 } on any problem.
 * @param {string} token
 * @param {{ expectedSessionId?: string, expectedIdentity?: string, secret?: string, now?: number }} [options]
 */
export function verifyTerminalLease(token, options = {}) {
  const config = getTerminalLeaseConfig();
  const secret = options.secret !== undefined ? options.secret : config.secret;
  if (!secret) {
    throw Object.assign(
      new Error('TERMINAL_LEASE_SECRET is not configured'),
      { status: 503 },
    );
  }
  const raw = String(token || '');
  const idx = raw.lastIndexOf('.');
  if (idx <= 0) {
    throw Object.assign(new Error('Malformed lease token'), { status: 401 });
  }
  const body = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  const expected = b64url(createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw Object.assign(new Error('Invalid lease signature'), { status: 401 });
  }

  let payload;
  try {
    const json = Buffer.from(
      body.replace(/-/g, '+').replace(/_/g, '/') +
        '='.repeat((4 - (body.length % 4)) % 4),
      'base64',
    ).toString('utf8');
    payload = JSON.parse(json);
  } catch {
    throw Object.assign(new Error('Malformed lease payload'), { status: 401 });
  }

  if (payload?.kind !== 'terminal' || payload?.v !== 1) {
    throw Object.assign(new Error('Lease kind is invalid'), { status: 401 });
  }
  if (!payload.sid || !payload.sub) {
    throw Object.assign(new Error('Lease is missing binding'), { status: 401 });
  }
  if (
    options.expectedSessionId &&
    payload.sid !== options.expectedSessionId
  ) {
    throw Object.assign(new Error('Lease session mismatch'), { status: 401 });
  }
  if (options.expectedIdentity && payload.sub !== options.expectedIdentity) {
    throw Object.assign(new Error('Lease identity mismatch'), { status: 401 });
  }
  const now = Number.isFinite(options.now)
    ? options.now
    : Math.floor(Date.now() / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp <= now) {
    throw Object.assign(new Error('Lease expired'), { status: 401 });
  }
  return payload;
}
