import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

import { LocalStore } from './localStore';
import {
  attachBlob,
  evictBlob,
  getBlobForRef,
  putRecordWithBlobs,
  removeRecord,
  sweepOrphanBlobs,
} from './blobStore';

const store = new LocalStore({ dbName: `test-blob-${Date.now()}` });

function makeBlob(text) {
  return new Blob([text], { type: 'text/plain' });
}

test('attachBlob dedups by provider+externalId', async () => {
  const first = await attachBlob(store, {
    provider: 'dingtalk-media',
    externalId: '@mid1',
    data: makeBlob('hello'),
  });
  assert.equal(first.created, true);
  const second = await attachBlob(store, {
    provider: 'dingtalk-media',
    externalId: '@mid1',
    data: makeBlob('different'),
  });
  assert.equal(second.created, false);
  assert.equal(second.blobId, first.blobId);
});

test('getBlobForRef returns data and repairs dangling refs', async () => {
  await attachBlob(store, { provider: 'vault', externalId: 'hash1', data: makeBlob('content') });
  const got = await getBlobForRef(store, 'vault', 'hash1');
  assert.equal(got.type, 'text/plain');
  assert.equal(await got.data.text(), 'content');
  assert.equal(await getBlobForRef(store, 'vault', 'missing'), null);
});

test('putRecordWithBlobs links record and bumps refcounts in one tx', async () => {
  const row = await putRecordWithBlobs(
    store,
    { category: 'dingtalk', id: 'msg1', kind: 'message', data: { text: 'hi' }, size: 10 },
    [{ provider: 'dingtalk-media', externalId: '@m1', data: makeBlob('img'), size: 100 }],
  );
  assert.equal(row.blobRefs.length, 1);
  const blob = await getBlobForRef(store, 'dingtalk-media', '@m1');
  assert.equal(blob.refCount, 1);
});

test('replace semantics: re-putting a record with different blobs dec refs old ones', async () => {
  await putRecordWithBlobs(
    store,
    { category: 'dingtalk', id: 'msg2', kind: 'message', data: {}, size: 1 },
    [{ provider: 'dingtalk-media', externalId: '@old', data: makeBlob('old'), size: 50 }],
  );
  await putRecordWithBlobs(
    store,
    { category: 'dingtalk', id: 'msg2', kind: 'message', data: {}, size: 1 },
    [{ provider: 'dingtalk-media', externalId: '@new', data: makeBlob('new'), size: 60 }],
  );
  // old blob orphaned and collected inside the same tx; new one referenced
  assert.equal(await getBlobForRef(store, 'dingtalk-media', '@old'), null);
  const newBlob = await getBlobForRef(store, 'dingtalk-media', '@new');
  assert.equal(newBlob.refCount, 1);
});

test('removeRecord cascades: blob deleted when last reference removed', async () => {
  await putRecordWithBlobs(
    store,
    { category: 'dingtalk', id: 'msg3', kind: 'message', data: {}, size: 5 },
    [{ provider: 'dingtalk-media', externalId: '@m3', data: makeBlob('x'), size: 30 }],
  );
  const res = await removeRecord(store, 'dingtalk', 'msg3');
  assert.equal(res.removedBytes, 35);
  assert.equal(await store.getRecord('dingtalk', 'msg3'), null);
  assert.equal(await getBlobForRef(store, 'dingtalk-media', '@m3'), null);
});

test('removeRecord keeps shared blobs alive (refcount > 0)', async () => {
  const att = { provider: 'dingtalk-media', externalId: '@shared', data: makeBlob('shared'), size: 10 };
  await putRecordWithBlobs(store, { category: 'dingtalk', id: 'a', kind: 'message', data: {} }, [att]);
  await putRecordWithBlobs(store, { category: 'dingtalk', id: 'b', kind: 'message', data: {} }, [att]);
  await removeRecord(store, 'dingtalk', 'a');
  const still = await getBlobForRef(store, 'dingtalk-media', '@shared');
  assert.equal(still.refCount, 1);
});

test('evictBlob strips blobRefs from referencing records', async () => {
  await putRecordWithBlobs(
    store,
    { category: 'kb', id: 'doc9', kind: 'kb-content', data: {}, size: 1 },
    [{ provider: 'vault', externalId: 'h9', data: makeBlob('big'), size: 500 }],
  );
  const res = await evictBlob(store, 'h9');
  assert.equal(res.removedBytes, 500);
  const record = await store.getRecord('kb', 'doc9');
  assert.equal(record.blobRefs.length, 0);
  assert.equal(await getBlobForRef(store, 'vault', 'h9'), null);
});

test('sweepOrphanBlobs removes refCount-0 blobs and their refs', async () => {
  await attachBlob(store, { provider: 'temp', externalId: 't1', data: makeBlob('tmp'), size: 20 });
  const res = await sweepOrphanBlobs(store);
  assert.ok(res.removed >= 1);
  assert.equal(await getBlobForRef(store, 'temp', 't1'), null);
});

test('crashed two-step writes cannot drift refcounts: dangling ref self-heals', async () => {
  // Simulate a crash: ref exists but blob write never landed.
  const db = await store.db();
  await db.put('blob_refs', {
    namespace: store.namespace,
    provider: 'dingtalk-media',
    externalId: '@crashed',
    blobId: '@crashed',
    createdAt: Date.now(),
  });
  // getBlobForRef repairs; attachBlob recreates
  assert.equal(await getBlobForRef(store, 'dingtalk-media', '@crashed'), null);
  const re = await attachBlob(store, {
    provider: 'dingtalk-media',
    externalId: '@crashed',
    data: makeBlob('ok'),
  });
  assert.equal(re.created, true);
  assert.equal((await getBlobForRef(store, 'dingtalk-media', '@crashed')).refCount, 0);
});
