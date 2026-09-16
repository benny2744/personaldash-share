import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

import { LocalStore } from './localStore';
import { attachBlob } from './blobStore';
import { getCacheStatus, pruneIfNeeded } from './manager';
import { getDiagnostics } from './diagnostics';
import { PRIORITY } from './config';

const DAY = 86400000;

function stubNavigatorStorage(quota) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      storage: {
        estimate: async () => ({ quota, usage: 0 }),
        persist: async () => false,
        persisted: async () => false,
      },
    },
  });
}

function restoreNavigator() {
  delete globalThis.navigator;
}

test('getCacheStatus reports tracked usage and level', async () => {
  const s = new LocalStore({ dbName: `test-status-${Date.now()}` });
  await s.putRecord({ category: 'kb', id: 'd', size: 1000 });
  const status = await getCacheStatus(s);
  assert.equal(status.supported, true);
  assert.equal(status.trackedBytes, 1000);
  assert.equal(status.byCategory.kb, 1000);
  assert.equal(status.level, 'normal');
  s.close();
});

test('pruneIfNeeded: no-op under normal pressure, still sweeps orphans', async () => {
  const s = new LocalStore({ dbName: `test-p1-${Date.now()}` });
  await attachBlob(s, { provider: 'temp', externalId: 'orphan', data: new Blob(['x']), size: 10 });
  const res = await pruneIfNeeded(s);
  assert.equal(res.level, 'normal');
  assert.ok(res.removedBytes >= 10);
  s.close();
});

test('pruneIfNeeded evicts low-priority old records when browser quota shrinks the budget', async () => {
  const s = new LocalStore({ dbName: `test-p2-${Date.now()}` });
  const now = Date.now();
  stubNavigatorStorage(200);
  try {
    await s.putRecord({
      category: 'dingtalk',
      id: 'old-msg',
      kind: 'message',
      data: { text: 'x' },
      size: 150,
      priority: PRIORITY.LOW,
      createdAt: now - 60 * DAY,
      lastAccessedAt: now - 60 * DAY,
    });
    await s.putRecord({
      category: 'dingtalk',
      id: 'new-msg',
      kind: 'message',
      data: { text: 'y' },
      size: 50,
      priority: PRIORITY.HIGH,
      createdAt: now,
      lastAccessedAt: now,
    });
    const res = await pruneIfNeeded(s);
    assert.ok(res.evicted >= 1);
    assert.equal(await s.getRecord('dingtalk', 'old-msg'), null);
  } finally {
    restoreNavigator();
    s.close();
  }
});

test('prune records diagnostics', async () => {
  const s = new LocalStore({ dbName: `test-p3-${Date.now()}` });
  stubNavigatorStorage(100);
  try {
    await s.putRecord({
      category: 'other',
      id: 'junk',
      kind: 'temp',
      size: 90,
      priority: PRIORITY.LOW,
      createdAt: 1,
      lastAccessedAt: 1,
    });
    await pruneIfNeeded(s);
    const diag = await getDiagnostics(s);
    assert.ok(diag.counters.pruneRuns >= 1);
    assert.ok(diag.events.lastPrune.removedBytes > 0);
  } finally {
    restoreNavigator();
    s.close();
  }
});
