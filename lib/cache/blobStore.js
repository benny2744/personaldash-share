// Blob storage with upstream-identity decoupling and transactional refcounts.
//
// blob_refs maps (namespace, provider, externalId) -> blobId, so DingTalk
// mediaIds, vault content hashes, and agent file paths can later migrate to
// content-hash blobIds without consumers changing.
//
// Refcount correctness rule: any operation that changes both a record's
// blobRefs and a blob's refCount runs in a single IndexedDB transaction.
// Never increment/decrement refcounts from separate calls.

const STORE_RECORDS = 'records';
const STORE_BLOBS = 'blobs';
const STORE_BLOB_REFS = 'blob_refs';

function refKey(namespace, provider, externalId) {
  return [namespace, provider, externalId];
}

export async function attachBlob(
  store,
  { provider, externalId, data, type, size, category = 'other', priority = 1, pinned = false },
) {
  const db = await store.db();
  if (!db) return null;
  const ns = store.namespace;
  const now = Date.now();
  const tx = db.transaction([STORE_BLOBS, STORE_BLOB_REFS], 'readwrite');
  const refs = tx.objectStore(STORE_BLOB_REFS);
  const blobs = tx.objectStore(STORE_BLOBS);

  const existing = await refs.get(refKey(ns, provider, externalId));
  if (existing) {
    const blob = await blobs.get([ns, existing.blobId]);
    if (blob) {
      blob.lastAccessedAt = now;
      await blobs.put(blob);
      await tx.done;
      return { blobId: existing.blobId, created: false };
    }
    // Dangling ref — repair by falling through to recreate the blob.
  }

  const blobId = externalId;
  await blobs.put({
    namespace: ns,
    blobId,
    data,
    type: type || data?.type || 'application/octet-stream',
    size: size ?? data?.size ?? 0,
    category,
    priority,
    pinned,
    refCount: 0,
    createdAt: now,
    lastAccessedAt: now,
  });
  await refs.put({ namespace: ns, provider, externalId, blobId, createdAt: now });
  await tx.done;
  return { blobId, created: true };
}

// Atomically resolve/create blobs, swap a record's blobRefs, and fix
// refcounts — all in one transaction. attachments: [{ provider, externalId,
// data?, type?, size?, category?, priority? }]. Attachments whose blob already
// exists reuse it (data may be omitted).
export async function putRecordWithBlobs(store, record, attachments = []) {
  const db = await store.db();
  if (!db) return null;
  const ns = store.namespace;
  const now = Date.now();
  const tx = db.transaction([STORE_RECORDS, STORE_BLOBS, STORE_BLOB_REFS], 'readwrite');
  const records = tx.objectStore(STORE_RECORDS);
  const blobs = tx.objectStore(STORE_BLOBS);
  const refs = tx.objectStore(STORE_BLOB_REFS);

  const key = [ns, record.category, record.id];
  const old = await records.get(key);
  const oldRefs = new Set(
    (old?.blobRefs || []).map((r) => `${r.provider}${r.externalId}`),
  );

  const blobRefs = [];
  for (const att of attachments) {
    let ref = await refs.get(refKey(ns, att.provider, att.externalId));
    let blob = ref ? await blobs.get([ns, ref.blobId]) : null;
    if (!blob) {
      const blobId = att.externalId;
      blob = {
        namespace: ns,
        blobId,
        data: att.data,
        type: att.type || att.data?.type || 'application/octet-stream',
        size: att.size ?? att.data?.size ?? 0,
        category: att.category || record.category,
        priority: att.priority ?? record.priority ?? 1,
        pinned: Boolean(att.pinned),
        refCount: 0,
        createdAt: now,
        lastAccessedAt: now,
      };
      await blobs.put(blob);
      await refs.put({
        namespace: ns,
        provider: att.provider,
        externalId: att.externalId,
        blobId,
        createdAt: now,
      });
      ref = { blobId };
    }
    blob.lastAccessedAt = now;
    const marker = `${att.provider}${att.externalId}`;
    if (!oldRefs.has(marker)) blob.refCount = (blob.refCount || 0) + 1;
    await blobs.put(blob);
    oldRefs.delete(marker);
    blobRefs.push({ provider: att.provider, externalId: att.externalId, blobId: ref.blobId });
  }

  // Old references not present in the new set: decref and collect orphans.
  for (const oldRef of old?.blobRefs || []) {
    const marker = `${oldRef.provider}${oldRef.externalId}`;
    if (!oldRefs.has(marker)) continue;
    const blob = await blobs.get([ns, oldRef.blobId]);
    if (blob) {
      blob.refCount = Math.max(0, (blob.refCount || 0) - 1);
      if (blob.refCount === 0) {
        await blobs.delete([ns, oldRef.blobId]);
        await refs.delete(refKey(ns, oldRef.provider, oldRef.externalId));
      } else {
        await blobs.put(blob);
      }
    }
  }

  const row = {
    priority: 1,
    pinned: false,
    ...record,
    namespace: ns,
    blobRefs,
    createdAt: record.createdAt || old?.createdAt || now,
    lastAccessedAt: now,
  };
  await records.put(row);
  await tx.done;
  return row;
}

export async function removeRecord(store, category, id) {
  const db = await store.db();
  if (!db) return { removedBytes: 0 };
  const ns = store.namespace;
  const tx = db.transaction([STORE_RECORDS, STORE_BLOBS, STORE_BLOB_REFS], 'readwrite');
  const records = tx.objectStore(STORE_RECORDS);
  const blobs = tx.objectStore(STORE_BLOBS);
  const refs = tx.objectStore(STORE_BLOB_REFS);

  const key = [ns, category, id];
  const record = await records.get(key);
  if (!record) {
    await tx.done;
    return { removedBytes: 0 };
  }
  let removedBytes = record.size || 0;
  for (const ref of record.blobRefs || []) {
    const blob = await blobs.get([ns, ref.blobId]);
    if (!blob) continue;
    blob.refCount = Math.max(0, (blob.refCount || 0) - 1);
    if (blob.refCount === 0) {
      removedBytes += blob.size || 0;
      await blobs.delete([ns, ref.blobId]);
      await refs.delete(refKey(ns, ref.provider, ref.externalId));
    } else {
      await blobs.put(blob);
    }
  }
  await records.delete(key);
  await tx.done;
  return { removedBytes };
}

export async function getBlobForRef(store, provider, externalId) {
  const db = await store.db();
  if (!db) return null;
  const ns = store.namespace;
  const ref = await db.get(STORE_BLOB_REFS, refKey(ns, provider, externalId));
  if (!ref) return null;
  const blob = await db.get(STORE_BLOBS, [ns, ref.blobId]);
  if (!blob) {
    // Dangling ref — repair so callers can just refetch from the server.
    await db.delete(STORE_BLOB_REFS, refKey(ns, provider, externalId));
    return null;
  }
  blob.lastAccessedAt = Date.now();
  await db.put(STORE_BLOBS, blob);
  return blob;
}

// Prune-time blob eviction: deletes the blob, its refs, and strips the
// matching blobRefs from any record that points at it — one transaction, so
// records never dangle after the blob is gone.
export async function evictBlob(store, blobId) {
  const db = await store.db();
  if (!db) return { removedBytes: 0 };
  const ns = store.namespace;
  const tx = db.transaction([STORE_RECORDS, STORE_BLOBS, STORE_BLOB_REFS], 'readwrite');
  const records = tx.objectStore(STORE_RECORDS);
  const blobs = tx.objectStore(STORE_BLOBS);
  const refs = tx.objectStore(STORE_BLOB_REFS);

  const blob = await blobs.get([ns, blobId]);
  if (!blob) {
    await tx.done;
    return { removedBytes: 0 };
  }
  const removedBytes = blob.size || 0;

  let refCursor = await refs.index('by-blob').openCursor(IDBKeyRange.only([ns, blobId]));
  while (refCursor) {
    await refCursor.delete();
    refCursor = await refCursor.continue();
  }

  const range = IDBKeyRange.bound([ns], [ns, []]);
  let recCursor = await records.openCursor(range);
  while (recCursor) {
    const record = recCursor.value;
    const before = record.blobRefs?.length || 0;
    if (before > 0) {
      record.blobRefs = record.blobRefs.filter((r) => r.blobId !== blobId);
      if (record.blobRefs.length !== before) await recCursor.update(record);
    }
    recCursor = await recCursor.continue();
  }
  await blobs.delete([ns, blobId]);
  await tx.done;
  return { removedBytes };
}

export async function sweepOrphanBlobs(store) {
  const db = await store.db();
  if (!db) return { removed: 0, removedBytes: 0 };
  const ns = store.namespace;
  const tx = db.transaction([STORE_BLOBS, STORE_BLOB_REFS], 'readwrite');
  const blobs = tx.objectStore(STORE_BLOBS);
  const refs = tx.objectStore(STORE_BLOB_REFS);
  const range = IDBKeyRange.bound([ns], [ns, []]);
  let removed = 0;
  let removedBytes = 0;
  let cursor = await blobs.openCursor(range);
  while (cursor) {
    const blob = cursor.value;
    if ((blob.refCount || 0) <= 0) {
      removed += 1;
      removedBytes += blob.size || 0;
      await cursor.delete();
      let refCursor = await refs.index('by-blob').openCursor(IDBKeyRange.only([ns, blob.blobId]));
      while (refCursor) {
        await refCursor.delete();
        refCursor = await refCursor.continue();
      }
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  return { removed, removedBytes };
}
