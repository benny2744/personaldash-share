import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

import { LocalStore } from './localStore';
import {
  getMessageCursor,
  readConversationList,
  readMediaBlob,
  readMessages,
  setMessageCursor,
  writeConversationList,
  writeMediaBlob,
  writeMessages,
} from './dingTalkCache';

function makeStore() {
  return new LocalStore({ dbName: `test-dt-${Date.now()}-${Math.random()}` });
}

function msg(cid, id, createdAt) {
  return { openMessageId: id, senderName: 'X', content: `text-${id}`, createdAt };
}

test('conversation list roundtrip', async () => {
  const store = makeStore();
  assert.equal(await readConversationList(store), null);
  await writeConversationList(store, [{ openConversationId: 'cid1', title: 'A' }]);
  const cached = await readConversationList(store);
  assert.equal(cached[0].title, 'A');
  store.close();
});

test('messages are stored per conversation and read sorted by createdAt', async () => {
  const store = makeStore();
  await writeMessages(store, 'cid1', [
    msg('cid1', 'm2', '2026-08-24T10:00:00Z'),
    msg('cid1', 'm1', '2026-08-24T09:00:00Z'),
  ]);
  await writeMessages(store, 'cid2', [msg('cid2', 'x1', '2026-08-24T11:00:00Z')]);

  const msgs = await readMessages(store, 'cid1');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].openMessageId, 'm1');
  assert.equal(msgs[1].openMessageId, 'm2');

  // other conversation not leaked
  const other = await readMessages(store, 'cid2');
  assert.equal(other.length, 1);
  assert.equal(await readMessages(store, 'cid-none'), null);
  store.close();
});

test('message write dedups by openMessageId (incremental re-merge safe)', async () => {
  const store = makeStore();
  await writeMessages(store, 'cid1', [msg('cid1', 'm1', '2026-08-24T09:00:00Z')]);
  await writeMessages(store, 'cid1', [msg('cid1', 'm1', '2026-08-24T09:00:00Z')]);
  const msgs = await readMessages(store, 'cid1');
  assert.equal(msgs.length, 1);
  store.close();
});

test('message cursor persists per conversation', async () => {
  const store = makeStore();
  assert.equal(await getMessageCursor(store, 'cid1'), null);
  await setMessageCursor(store, 'cid1', '2026-08-24T12:00:00Z');
  assert.equal(await getMessageCursor(store, 'cid1'), '2026-08-24T12:00:00Z');
  assert.equal(await getMessageCursor(store, 'cid2'), null);
  store.close();
});

test('media blob roundtrip via upstream identity', async () => {
  const store = makeStore();
  assert.equal(await readMediaBlob(store, 'media', '@nope'), null);
  await writeMediaBlob(store, 'media', '@m1', new Blob(['img-bytes'], { type: 'image/png' }));
  const data = await readMediaBlob(store, 'media', '@m1');
  assert.equal(data.type, 'image/png');
  assert.equal(await data.text(), 'img-bytes');
  // same identity rewrites do not duplicate
  await writeMediaBlob(store, 'media', '@m1', new Blob(['img-bytes']));
  const usage = await store.collectUsage();
  assert.equal(usage.blobs.filter((b) => b.key[1] === '@m1').length, 1);
  store.close();
});
