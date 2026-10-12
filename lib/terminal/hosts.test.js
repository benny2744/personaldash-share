import { test } from 'node:test';
import assert from 'node:assert/strict';

const { validateCredentialRef } = await import('./credentials.js');
const { validateHostPayload, requireHostsAdmin } = await import('./hosts.js');

test('credentialRef rejects traversal and separators', () => {
  for (const bad of [
    '../etc',
    'a/b',
    '.hidden',
    'has_underscore',
    'UPPER',
    '',
    'a'.repeat(65),
  ]) {
    assert.throws(() => validateCredentialRef(bad), /credentialRef/);
  }
  assert.equal(validateCredentialRef('default'), 'default');
  assert.equal(validateCredentialRef('student-vm-01'), 'student-vm-01');
});

test('host payload: happy path normalizes', () => {
  const payload = validateHostPayload({
    slug: 'Vm-1',
    displayName: 'Student VM 1',
    sshHost: '192.0.2.5',
    sshPort: '2222',
    sshUser: 'deploy',
    credentialRef: 'default',
    hostKeySha256: `sha256:${'A'.repeat(43)}`,
    allowedIdentities: 'Alice@Example.com, bob@example.com,,',
  });
  assert.equal(payload.slug, 'vm-1');
  assert.equal(payload.sshPort, 2222);
  assert.equal(payload.hostKeySha256.startsWith('SHA256:'), true);
  assert.deepEqual(payload.allowedIdentities, [
    'alice@example.com',
    'bob@example.com',
  ]);
  assert.equal(payload.enabled, true);
});

test('host payload: rejects hostile or malformed fields', () => {
  const base = {
    slug: 'ok',
    displayName: 'ok',
    sshHost: '192.0.2.5',
    sshUser: 'deploy',
  };
  const cases = [
    [{ ...base, slug: 'Bad_Slug' }, /slug/],
    [{ ...base, slug: '../escape' }, /slug/],
    [{ ...base, displayName: '' }, /displayName/],
    [{ ...base, sshHost: 'deploy@192.0.2.5' }, /sshHost/],
    [{ ...base, sshHost: '192.0.2.5/' }, /sshHost/],
    [{ ...base, sshUser: 'deploy; rm -rf' }, /sshUser/],
    [{ ...base, sshPort: 0 }, /sshPort/],
    [{ ...base, sshPort: 70000 }, /sshPort/],
    [{ ...base, sshPort: 22.5 }, /sshPort/],
    [
      { ...base, hostKeySha256: 'AAAAB3NzaC1yc2E notafingerprint' },
      /hostKeySha256/,
    ],
    [{ ...base, allowedIdentities: ['bad identity with spaces'] }, /identity/],
    [{ ...base, credentialRef: '../keys' }, /credentialRef/],
  ];
  for (const [payload, matcher] of cases) {
    assert.throws(() => validateHostPayload(payload), matcher);
  }
});

test('host payload: IPv6 hosts and null fingerprint pin accepted', () => {
  const payload = validateHostPayload({
    slug: 'v6',
    displayName: 'v6 host',
    sshHost: '2001:db8::1',
    sshUser: 'deploy',
    hostKeySha256: null,
  });
  assert.equal(payload.sshHost, '2001:db8::1');
  assert.equal(payload.hostKeySha256, null);
});

test('partial update only touches provided fields', () => {
  const patch = validateHostPayload(
    { enabled: 'false', allowedIdentities: ['x@y.z'] },
    { partial: true },
  );
  assert.deepEqual(patch, { allowedIdentities: ['x@y.z'], enabled: false });
});
