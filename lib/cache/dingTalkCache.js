// DingTalk cache adapter. Conversations are a snapshot list; messages are
// individual records per conversation so the existing `after` timestamp
// cursor gives true incremental sync; media lives in the blob store keyed by
// upstream mediaId/fileId (via blob_refs) so identity can later migrate to
// content hashes without touching consumers.

import { incrCounter, markSync } from './diagnostics';
import { attachBlob, getBlobForRef } from './blobStore';

const CATEGORY = 'dingtalk';
const LIST_ID = 'conversation-list';
const MSG_PREFIX = 'msg:';

function approxSize(value) {
  try {
    return JSON.stringify(value)?.length || 0;
  } catch {
    return 0;
  }
}

export async function readConversationList(store) {
  const row = await store.getRecord(CATEGORY, LIST_ID);
  if (!row) {
    await incrCounter(store, 'cacheMiss:dingtalk');
    return null;
  }
  await incrCounter(store, 'cacheHit:dingtalk');
  await store.touchRecord(CATEGORY, LIST_ID);
  return row.data.conversations || [];
}

export async function writeConversationList(store, conversations) {
  const data = { conversations, cachedAt: Date.now() };
  await store.putRecord({
    category: CATEGORY,
    id: LIST_ID,
    kind: 'conversation-meta',
    data,
    size: approxSize(data),
    priority: 2,
  });
  await markSync(store, 'dingtalk-conversations', { count: conversations.length });
}

export async function readMessages(store, cid) {
  const rows = await store.listRecords(CATEGORY, { idPrefix: `${MSG_PREFIX}${cid}:` });
  if (rows.length === 0) {
    await incrCounter(store, 'cacheMiss:dingtalk');
    return null;
  }
  await incrCounter(store, 'cacheHit:dingtalk');
  return rows
    .map((r) => r.data)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export async function writeMessages(store, cid, messages) {
  for (const message of messages) {
    if (!message?.openMessageId) continue;
    await store.putRecord({
      category: CATEGORY,
      id: `${MSG_PREFIX}${cid}:${message.openMessageId}`,
      kind: 'message',
      text: true,
      data: message,
      size: approxSize(message),
      priority: 2,
      createdAt: Date.parse(message.createdAt) || Date.now(),
    });
  }
}

export async function getMessageCursor(store, cid) {
  return store.getMeta(`sync:dingtalk:${cid}`);
}

export async function setMessageCursor(store, cid, createdAt) {
  await store.putMeta(`sync:dingtalk:${cid}`, createdAt);
  await markSync(store, 'dingtalk-messages', { cid, cursor: createdAt });
}

// --- media blobs ---

function providerFor(kind) {
  return kind === 'file' ? 'dingtalk-file' : 'dingtalk-media';
}

export async function readMediaBlob(store, kind, resourceId) {
  const blob = await getBlobForRef(store, providerFor(kind), resourceId);
  return blob ? blob.data : null;
}

export async function writeMediaBlob(store, kind, resourceId, data, { priority = 1 } = {}) {
  return attachBlob(store, {
    provider: providerFor(kind),
    externalId: resourceId,
    data,
    type: data?.type,
    size: data?.size,
    category: CATEGORY,
    priority,
  });
}
