import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TERMINAL_LEASE_SECRET = 'app-tier-lease-secret';

const { issueTerminalLease, verifyTerminalLease } = await import('./lease.js');

test('issue + verify round-trips the session/identity binding', () => {
  const lease = issueTerminalLease({
    sessionId: 'sess-42',
    identity: 'alice@example.com',
    now: 1_000_000,
  });
  const payload = verifyTerminalLease(lease.token, {
    expectedSessionId: 'sess-42',
    expectedIdentity: 'alice@example.com',
    now: 1_000_010,
  });
  assert.equal(payload.sid, 'sess-42');
  assert.equal(payload.sub, 'alice@example.com');
  assert.equal(payload.kind, 'terminal');
  assert.ok(lease.wsPath.startsWith('/api/terminal/ws?session=sess-42&lease='));
});

test('expired, forged, and mismatch-bound leases are rejected', () => {
  const lease = issueTerminalLease({
    sessionId: 'sess-42',
    identity: 'alice@example.com',
    now: 1_000_000,
    ttlSeconds: 10,
  });
  assert.throws(
    () => verifyTerminalLease(lease.token, { now: 1_000_011 }),
    /expired/i,
  );
  assert.throws(
    () => verifyTerminalLease(lease.token, { expectedSessionId: 'other', now: 1_000_005 }),
    /session mismatch/i,
  );
  assert.throws(
    () => verifyTerminalLease(`${lease.token}x`, { now: 1_000_005 }),
    /signature/i,
  );
  assert.throws(() => verifyTerminalLease('', { now: 1_000_005 }), /Malformed/);
});

test('issue refuses to run without the shared secret', async () => {
  delete process.env.TERMINAL_LEASE_SECRET;
  const { issueTerminalLease: fresh } = await import('./lease.js');
  assert.throws(
    () => fresh({ sessionId: 's', identity: 'x@y.z' }),
    /TERMINAL_LEASE_SECRET/,
  );
  process.env.TERMINAL_LEASE_SECRET = 'app-tier-lease-secret';
});

test('ttl is clamped to the 5–300 s window', () => {
  const lease = issueTerminalLease({
    sessionId: 's',
    identity: 'x@y.z',
    now: 1_000_000,
    ttlSeconds: 9999,
  });
  const payload = verifyTerminalLease(lease.token, { now: 1_000_000 });
  assert.equal(payload.exp - payload.iat, 300);
});
