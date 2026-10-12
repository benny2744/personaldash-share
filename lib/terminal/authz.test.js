import { test } from 'node:test';
import assert from 'node:assert/strict';

const { canAccessHost, filterHostsForIdentity } = await import('./authz.js');

test('canAccessHost: assigned identity passes, strangers fail', () => {
  const host = { allowedIdentities: ['alice@example.com'] };
  assert.equal(canAccessHost('alice@example.com', host), true);
  assert.equal(canAccessHost('mallory@example.com', host), false);
  assert.equal(canAccessHost(null, host), false);
  assert.equal(canAccessHost('alice@example.com', null), false);
});

test('canAccessHost: empty allow-list is admins-only', () => {
  const host = { allowedIdentities: [] };
  assert.equal(canAccessHost('alice@example.com', host), false);
  assert.equal(canAccessHost('alice@example.com', host, { isAdmin: true }), true);
});

test('filterHostsForIdentity hides disabled hosts from non-admins', () => {
  const hosts = [
    { slug: 'a', enabled: true, allowedIdentities: ['alice@example.com'] },
    { slug: 'b', enabled: false, allowedIdentities: ['alice@example.com'] },
    { slug: 'c', enabled: true, allowedIdentities: [] },
  ];
  assert.deepEqual(
    filterHostsForIdentity(hosts, 'alice@example.com').map((host) => host.slug),
    ['a'],
  );
  assert.equal(
    filterHostsForIdentity(hosts, 'alice@example.com', { isAdmin: true }).length,
    3,
  );
  assert.deepEqual(filterHostsForIdentity(hosts, null), []);
});
