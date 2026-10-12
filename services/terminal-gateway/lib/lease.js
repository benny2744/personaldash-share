/**
 * services/terminal-gateway/lib/lease.js — verify terminal attach leases.
 * Self-contained mirror of lib/terminal/lease.js (app tier); a cross-test in
 * test/lease.test.mjs asserts the two implementations interoperate.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

function b64url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * @param {string} token
 * @param {{ secret: string, expectedSessionId?: string, expectedIdentity?: string, now?: number }} options
 */
export function verifyTerminalLease(token, options) {
  const secret = String(options?.secret || '');
  if (!secret) {
    throw Object.assign(new Error('Lease secret is not configured'), {
      status: 503,
    });
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
  if (options.expectedSessionId && payload.sid !== options.expectedSessionId) {
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
