/** Authorization mirror tests (sidecar copy must match app semantics). */

import test from 'node:test';
import assert from 'node:assert/strict';

import { canAccessHost } from '../lib/authz.js';
import {
  canAccessHost as appCanAccessHost,
  filterHostsForIdentity,
} from '../../../lib/terminal/authz.js';

test('allowed identity passes; strangers fail', () => {
  const host = { allowed_identities: ['alice@example.com'] };
  assert.equal(canAccessHost('alice@example.com', host), true);
  assert.equal(canAccessHost('mallory@example.com', host), false);
  assert.equal(canAccessHost(null, host), false);
});

test('empty allow-list is admins only', () => {
  const host = { allowed_identities: [] };
  assert.equal(canAccessHost('alice@example.com', host), false);
  assert.equal(canAccessHost('alice@example.com', host, { isAdmin: true }), true);
});

test('sidecar mirror matches app implementation', () => {
  const hosts = [
    { allowed_identities: ['alice@example.com'] },
    { allowed_identities: [] },
  ];
  const appHosts = [
    { allowedIdentities: ['alice@example.com'] },
    { allowedIdentities: [] },
  ];
  for (const [i, host] of hosts.entries()) {
    for (const identity of ['alice@example.com', 'bob@example.com', null]) {
      for (const isAdmin of [true, false]) {
        assert.equal(
          canAccessHost(identity, host, { isAdmin }),
          appCanAccessHost(identity, appHosts[i], { isAdmin }),
          `mismatch for ${identity} isAdmin=${isAdmin}`,
        );
      }
    }
  }
});

test('app filter drops disabled hosts for non-admins', () => {
  const hosts = [
    { slug: 'a', enabled: true, allowedIdentities: ['alice@example.com'] },
    { slug: 'b', enabled: false, allowedIdentities: ['alice@example.com'] },
  ];
  const visible = filterHostsForIdentity(hosts, 'alice@example.com');
  assert.deepEqual(visible.map((host) => host.slug), ['a']);
  const adminVisible = filterHostsForIdentity(hosts, 'alice@example.com', {
    isAdmin: true,
  });
  assert.equal(adminVisible.length, 2);
});
