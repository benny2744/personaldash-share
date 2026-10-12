/**
 * Lease cross-compatibility: the sidecar verifier must accept exactly what
 * the app's lib/terminal/lease.js issues (shared TERMINAL_LEASE_SECRET).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { verifyTerminalLease } from '../lib/lease.js';
import {
  issueTerminalLease,
  verifyTerminalLease as appVerify,
} from '../../../lib/terminal/lease.js';

const SECRET = 'cross-compat-secret';
// The app lib reads its secret from env at issue time.
process.env.TERMINAL_LEASE_SECRET = SECRET;

test('sidecar verifies a lease issued by the app lib', () => {
  const lease = issueTerminalLease({
    sessionId: 'sess-123',
    identity: 'alice@example.com',
    now: 1_000_000,
  });
  const payload = verifyTerminalLease(lease.token, {
    secret: SECRET,
    expectedSessionId: 'sess-123',
    expectedIdentity: 'alice@example.com',
    now: 1_000_000 + 10,
  });
  assert.equal(payload.sid, 'sess-123');
  assert.equal(payload.sub, 'alice@example.com');
});

test('sidecar verifier and app verifier agree on a hand-signed token', () => {
  // Hand-sign a payload the way both implementations do.
  const payload = {
    v: 1,
    kind: 'terminal',
    sid: 'sess-abc',
    sub: 'bob@example.com',
    iat: 5_000_000,
    exp: 5_000_030,
    jti: 'jti-1',
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  const sig = Buffer.from(
    createHmac('sha256', SECRET).update(body).digest(),
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  const token = `${body}.${sig}`;

  const viaSidecar = verifyTerminalLease(token, {
    secret: SECRET,
    now: 5_000_001,
  });
  assert.equal(viaSidecar.sid, 'sess-abc');
  assert.equal(viaSidecar.sub, 'bob@example.com');
});

test('expired lease is rejected by the sidecar verifier', () => {
  const payload = {
    v: 1,
    kind: 'terminal',
    sid: 'sess-abc',
    sub: 'bob@example.com',
    iat: 5_000_000,
    exp: 5_000_030,
    jti: 'jti-2',
  };
  const b64 = (buf) =>
    Buffer.from(buf)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  const body = b64(JSON.stringify(payload));
  const sig = b64(createHmac('sha256', SECRET).update(body).digest());
  assert.throws(
    () =>
      verifyTerminalLease(`${body}.${sig}`, {
        secret: SECRET,
        now: 5_000_031,
      }),
    /expired/i,
  );
});

test('tampered payload is rejected by the sidecar verifier', () => {
  const token = issueTerminalLease({
    sessionId: 'sess-1',
    identity: 'a@b.c',
    now: 1_000,
  });
  const [body, sig] = token.token.split('.');
  const forged = Buffer.from(
    JSON.stringify({
      v: 1,
      kind: 'terminal',
      sid: 'sess-other',
      sub: 'attacker@example.com',
      iat: 1000,
      exp: 1200,
      jti: 'x',
    }),
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  assert.throws(
    () => verifyTerminalLease(`${forged}.${sig}`, { secret: SECRET, now: 1001 }),
    /signature/i,
  );
  void appVerify;
});
