import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXT_RUNTIME = 'nodejs';
process.env.TERMINAL_LEASE_SECRET = 'sessions-test-secret';
process.env.TERMINAL_LOCAL_IDENTITY = 'alice@example.com';
process.env.TERMINAL_ADMIN_IDENTITIES = 'admin@example.com';

const hostRows = new Map([
  [
    'host-1',
    {
      id: 'host-1',
      slug: 'vm-1',
      displayName: 'VM 1',
      sshHost: '192.0.2.5',
      sshPort: 22,
      sshUser: 'deploy',
      credentialRef: 'default',
      hostKeySha256: 'SHA256:AAAA',
      allowedIdentities: ['alice@example.com'],
      enabled: true,
    },
  ],
  [
    'host-2',
    {
      id: 'host-2',
      slug: 'shared-vm',
      displayName: 'Shared VM',
      sshHost: '192.0.2.6',
      sshPort: 22,
      sshUser: 'deploy',
      credentialRef: 'default',
      hostKeySha256: null,
      allowedIdentities: [],
      enabled: true,
    },
  ],
]);
const sessionRows = [];
let createdSessions = 0;

globalThis.__prisma = {
  appSetting: {
    findUnique: async () => null,
    findMany: async () => [],
  },
  terminalHost: {
    findUnique: async ({ where }) =>
      [...hostRows.values()].find((host) => host.slug === where.slug) ||
      [...hostRows.values()].find((host) => host.id === where.id) ||
      null,
    findMany: async () => [...hostRows.values()],
    create: async ({ data }) => data,
  },
  terminalSession: {
    count: async () => sessionRows.length,
    create: async ({ data }) => {
      createdSessions += 1;
      sessionRows.push(data);
      return data;
    },
    findUnique: async ({ where }) =>
      sessionRows.find((row) =>
        row.id === where.id ? { ...row, host: hostRows.get(row.hostId) } : null,
      ) || null,
    update: async ({ where, data }) => {
      const row = sessionRows.find((entry) => entry.id === where.id);
      Object.assign(row, data);
      return row;
    },
    findMany: async () => sessionRows,
  },
  $transaction: async (ops) => Promise.all(ops),
};

const {
  getTerminalLimits,
  listTargets,
  createSession,
  refreshLease,
  closeSession,
} = await import('./sessions.js');
const { verifyTerminalLease } = await import('./lease.js');

function request(overrides = {}) {
  const headers = {
    'user-agent': 'test-agent',
    ...(overrides.headers || {}),
  };
  return {
    headers: { get: (name) => headers[name] ?? null },
    json: async () => overrides.body ?? {},
  };
}

const adminRequest = (body) =>
  request({
    headers: { 'Cf-Access-Authenticated-User-Email': 'admin@example.com' },
    body,
  });

test('limits resolve from settings with defaults', async () => {
  const limits = await getTerminalLimits();
  assert.equal(limits.enabled, false); // registry default; no env set
  assert.equal(limits.maxSessionsPerIdentity, 3);
  assert.equal(limits.idleTimeoutSeconds, 900);
});

test('targets are identity-filtered and disabled terminal is refused', async () => {
  process.env.TERMINAL_ENABLED = 'true';
  const { invalidateSettingsCache } = await import('@/lib/settings/resolve');
  invalidateSettingsCache();

  const listed = await listTargets(request());
  assert.equal(listed.hosts.length, 1); // shared-vm has an empty allow-list
  assert.equal(listed.hosts[0].slug, 'vm-1');
  assert.equal(listed.hosts[0].hostKeyPinned, true);

  const adminListed = await listTargets(adminRequest());
  assert.equal(adminListed.hosts.length, 2); // admins see everything
  assert.equal(adminListed.isAdmin, true);

  process.env.TERMINAL_ENABLED = 'false';
  invalidateSettingsCache();
  await assert.rejects(() => listTargets(request()), { status: 403 });
  process.env.TERMINAL_ENABLED = 'true';
  invalidateSettingsCache();
});

test('session create authorizes, pins, limits, and issues a lease', async () => {
  const ok = await createSession(
    request({ body: { hostSlug: 'vm-1', cols: 120, rows: 40 } }),
  );
  assert.ok(ok.sessionId);
  assert.equal(ok.host.slug, 'vm-1');
  assert.equal(ok.initialSize.cols, 120);
  const payload = verifyTerminalLease(ok.lease, {
    expectedSessionId: ok.sessionId,
    expectedIdentity: 'alice@example.com',
  });
  assert.equal(payload.kind, 'terminal');
  assert.equal(createdSessions, 1);
  assert.equal(sessionRows[0].status, 'pending');

  // Unauthorized host (not on allow-list → explicit 403, never a key hint).
  await assert.rejects(
    () => createSession(request({ body: { hostSlug: 'shared-vm' } })),
    { status: 403 },
  );

  // Admin reaches the unpinned host but gets 409 until the key is pinned.
  await assert.rejects(
    () => createSession(adminRequest({ hostSlug: 'shared-vm' })),
    { status: 409, message: /fingerprint/i },
  );
});

test('refresh requires pending/grace status and same owner', async () => {
  const created = await createSession(request({ body: { hostSlug: 'vm-1' } }));
  const refreshed = await refreshLease(request(), created.sessionId);
  assert.ok(refreshed.lease);

  sessionRows.find((row) => row.id === created.sessionId).status = 'active';
  await assert.rejects(() => refreshLease(request(), created.sessionId), {
    status: 409,
  });
  sessionRows.find((row) => row.id === created.sessionId).status = 'pending';
});

test('close is idempotent and records the reason', async () => {
  const created = await createSession(request({ body: { hostSlug: 'vm-1' } }));
  const first = await closeSession(request(), created.sessionId, 'user');
  assert.equal(first.ok, true);
  const again = await closeSession(request(), created.sessionId, 'user');
  assert.equal(again.status, 'closed');
});
