import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

import { LocalStore } from './localStore';

const store = new LocalStore({ dbName: `test-ls-${Date.now()}` });

test('record write/read/overwrite/delete roundtrip', async () => {
  await store.putRecord({ category: 'dingtalk', id: 'conv1', kind: 'conversation-meta', data: { title: 'A' }, size: 10 });
  let row = await store.getRecord('dingtalk', 'conv1');
  assert.equal(row.data.title, 'A');

  await store.putRecord({ category: 'dingtalk', id: 'conv1', kind: 'conversation-meta', data: { title: 'B' }, size: 10 });
  row = await store.getRecord('dingtalk', 'conv1');
  assert.equal(row.data.title, 'B');

  await store.deleteRecord('dingtalk', 'conv1');
  assert.equal(await store.getRecord('dingtalk', 'conv1'), null);
});

test('namespace is part of the primary key — no cross-namespace reads', async () => {
  await store.putRecord({ category: 'kb', id: 'doc', data: { v: 1 } });
  const other = new LocalStore({ namespace: 'user-b', dbName: store.dbName });
  assert.equal(await other.getRecord('kb', 'doc'), null);
  await store.putRecord({ category: 'kb', id: 'doc', data: { v: 1 } });
  other.close();
});

test('listRecords is namespace-scoped and limit-aware', async () => {
  for (let i = 0; i < 5; i += 1) {
    await store.putRecord({ category: 'agent', id: `s${i}`, kind: 'session-meta', size: 1 });
  }
  const all = await store.listRecords('agent');
  assert.equal(all.length, 5);
  assert.equal(all.every((r) => r.namespace === store.namespace), true);
  assert.equal((await store.listRecords('agent', { limit: 2 })).length, 2);
  assert.deepEqual(await store.listRecords('nonexistent'), []);
});

test('touchRecord updates lastAccessedAt', async () => {
  await store.putRecord({ category: 'kb', id: 't', data: {} });
  const before1 = await store.getRecord('kb', 't');
  await new Promise((r) => setTimeout(r, 5));
  await store.touchRecord('kb', 't');
  const after1 = await store.getRecord('kb', 't');
  assert.ok(after1.lastAccessedAt >= before1.lastAccessedAt);
});

test('meta roundtrip', async () => {
  await store.putMeta('sync:dt', { cursor: '2026-08-24' });
  assert.deepEqual(await store.getMeta('sync:dt'), { cursor: '2026-08-24' });
  assert.equal(await store.getMeta('missing'), null);
});

test('collectUsage aggregates record sizes by category', async () => {
  const s = new LocalStore({ dbName: `test-usage-${Date.now()}` });
  await s.putRecord({ category: 'kb', id: 'a', size: 100 });
  await s.putRecord({ category: 'kb', id: 'b', size: 50 });
  await s.putRecord({ category: 'dingtalk', id: 'c', size: 25 });
  const usage = await s.collectUsage();
  assert.equal(usage.totalBytes, 175);
  assert.equal(usage.records.length, 3);
  s.close();
});

test('wipeNamespace removes only that namespace', async () => {
  const dbName = `test-wipe-${Date.now()}`;
  const a = new LocalStore({ namespace: 'a', dbName });
  const b = new LocalStore({ namespace: 'b', dbName });
  await a.putRecord({ category: 'kb', id: 'x', data: {} });
  await b.putRecord({ category: 'kb', id: 'x', data: {} });
  await a.wipeNamespace();
  assert.equal(await a.getRecord('kb', 'x'), null);
  assert.ok(await b.getRecord('kb', 'x'));
  a.close();
  b.close();
});

test('clearAll empties everything', async () => {
  await store.putRecord({ category: 'other', id: 'z', data: {} });
  await store.clearAll();
  assert.equal(await store.getRecord('other', 'z'), null);
  assert.equal((await store.collectUsage()).totalBytes, 0);
});

test('unavailable when indexedDB is missing — all calls no-op safely', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
  const dead = new LocalStore();
  assert.equal(dead.available, false);
  assert.equal(await dead.getRecord('kb', 'x'), null);
  await dead.putRecord({ category: 'kb', id: 'x' });
  assert.deepEqual(await dead.listRecords('kb'), []);
  assert.deepEqual(await dead.collectUsage(), { records: [], blobs: [], totalBytes: 0 });
  Object.defineProperty(globalThis, 'indexedDB', saved);
});
