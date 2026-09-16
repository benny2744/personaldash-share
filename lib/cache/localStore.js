// Central persistent cache boundary. UI code never touches IndexedDB directly.
//
// DB: pdash-cache (version = CACHE_SCHEMA_VERSION)
//   meta       [namespace, key]                      → { value, updatedAt }
//   records    [namespace, category, id]             → structured app data
//   blobs      [namespace, blobId]                   → { data, size, type, refCount, ... }
//   blob_refs  [namespace, provider, externalId]     → { blobId, ... }
//
// Namespace is part of every primary key: cross-account reads are impossible
// by construction, and per-user wipes are single key-range deletes.

import { openDB } from 'idb';
import { CACHE_DB_NAME, CACHE_SCHEMA_VERSION, DEFAULT_NAMESPACE } from './config';

const STORE_META = 'meta';
const STORE_RECORDS = 'records';
const STORE_BLOBS = 'blobs';
const STORE_BLOB_REFS = 'blob_refs';

export class LocalStore {
  constructor({ namespace = DEFAULT_NAMESPACE, dbName = CACHE_DB_NAME } = {}) {
    this.namespace = namespace;
    this.dbName = dbName;
    this.available = typeof indexedDB !== 'undefined';
    this.dbPromise = null;
    this.onError = null;
  }

  reportError(context, error) {
    if (this.onError) {
      try {
        this.onError(context, error);
      } catch {
        // never let diagnostics break the cache
      }
    }
  }

  async db() {
    if (!this.available) return null;
    if (!this.dbPromise) {
      this.dbPromise = openDB(this.dbName, CACHE_SCHEMA_VERSION, {
        upgrade(db, oldVersion) {
          // Destructive rebuild is acceptable: the server is authoritative.
          if (oldVersion > 0) {
            for (const name of db.objectStoreNames) db.deleteObjectStore(name);
          }
          db.createObjectStore(STORE_META, { keyPath: ['namespace', 'key'] });
          const records = db.createObjectStore(STORE_RECORDS, {
            keyPath: ['namespace', 'category', 'id'],
          });
          records.createIndex('by-category', ['namespace', 'category']);
          records.createIndex('by-access', ['namespace', 'lastAccessedAt']);
          const blobs = db.createObjectStore(STORE_BLOBS, { keyPath: ['namespace', 'blobId'] });
          blobs.createIndex('by-access', ['namespace', 'lastAccessedAt']);
          const refs = db.createObjectStore(STORE_BLOB_REFS, {
            keyPath: ['namespace', 'provider', 'externalId'],
          });
          refs.createIndex('by-blob', ['namespace', 'blobId']);
        },
        blocked: () => {
          this.available = false;
        },
      }).catch((error) => {
        this.available = false;
        this.reportError('open', error);
        return null;
      });
    }
    return this.dbPromise;
  }

  recordKey(category, id, namespace = this.namespace) {
    return [namespace, category, id];
  }

  // --- meta ---

  async getMeta(key) {
    const db = await this.db();
    if (!db) return null;
    const row = await db.get(STORE_META, [this.namespace, key]);
    return row ? row.value : null;
  }

  async putMeta(key, value) {
    const db = await this.db();
    if (!db) return;
    await db.put(STORE_META, {
      namespace: this.namespace,
      key,
      value,
      updatedAt: Date.now(),
    });
  }

  // --- records ---

  async getRecord(category, id) {
    const db = await this.db();
    if (!db) return null;
    return (await db.get(STORE_RECORDS, this.recordKey(category, id))) || null;
  }

  async putRecord(record) {
    const db = await this.db();
    if (!db) return;
    const now = Date.now();
    await db.put(STORE_RECORDS, {
      priority: 1,
      pinned: false,
      ...record,
      namespace: this.namespace,
      createdAt: record.createdAt || now,
      lastAccessedAt: now,
    });
  }

  async touchRecord(category, id) {
    const db = await this.db();
    if (!db) return;
    const key = this.recordKey(category, id);
    const row = await db.get(STORE_RECORDS, key);
    if (row) {
      row.lastAccessedAt = Date.now();
      await db.put(STORE_RECORDS, row);
    }
  }

  async deleteRecord(category, id) {
    const db = await this.db();
    if (!db) return;
    await db.delete(STORE_RECORDS, this.recordKey(category, id));
  }

  async listRecords(category, { limit, idPrefix } = {}) {
    const db = await this.db();
    if (!db) return [];
    const range = idPrefix
      ? IDBKeyRange.bound(
          [this.namespace, category, idPrefix],
          [this.namespace, category, `${idPrefix}￿`],
        )
      : IDBKeyRange.bound(
          [this.namespace, category],
          [this.namespace, category, []],
        );
    const rows = [];
    let cursor = await db.transaction(STORE_RECORDS).store.openCursor(range);
    while (cursor && (limit === undefined || rows.length < limit)) {
      rows.push(cursor.value);
      cursor = await cursor.continue();
    }
    return rows;
  }

  // Usage accounting for the cache manager: one record per row + blobs.
  async collectUsage() {
    const db = await this.db();
    if (!db) return { records: [], blobs: [], totalBytes: 0 };
    const records = [];
    const blobs = [];
    let totalBytes = 0;

    const nsLow = [this.namespace];
    const nsHigh = [this.namespace, []];
    const nsRange = IDBKeyRange.bound(nsLow, nsHigh);

    let cursor = await db.transaction(STORE_RECORDS).store.openCursor(nsRange);
    while (cursor) {
      const v = cursor.value;
      records.push({
        key: [v.namespace, v.category, v.id],
        category: v.category,
        kind: v.kind,
        size: v.size || 0,
        createdAt: v.createdAt,
        lastAccessedAt: v.lastAccessedAt,
        priority: v.priority,
        pinned: v.pinned,
        text: v.text,
      });
      totalBytes += v.size || 0;
      cursor = await cursor.continue();
    }
    cursor = await db.transaction(STORE_BLOBS).store.openCursor(nsRange);
    while (cursor) {
      const v = cursor.value;
      blobs.push({
        key: [v.namespace, v.blobId],
        category: v.category,
        kind: 'blob',
        size: v.size || 0,
        createdAt: v.createdAt,
        lastAccessedAt: v.lastAccessedAt,
        priority: v.priority,
        pinned: v.pinned,
        refCount: v.refCount || 0,
      });
      totalBytes += v.size || 0;
      cursor = await cursor.continue();
    }
    return { records, blobs, totalBytes };
  }

  async wipeNamespace(namespace = this.namespace) {
    const db = await this.db();
    if (!db) return;
    const range = IDBKeyRange.bound([namespace], [namespace, []]);
    const tx = db.transaction(
      [STORE_META, STORE_RECORDS, STORE_BLOBS, STORE_BLOB_REFS],
      'readwrite',
    );
    await Promise.all([
      tx.objectStore(STORE_META).delete(IDBKeyRange.bound([namespace], [namespace, []])),
      tx.objectStore(STORE_RECORDS).delete(range),
      tx.objectStore(STORE_BLOBS).delete(range),
      tx.objectStore(STORE_BLOB_REFS).delete(range),
      tx.done,
    ]);
  }

  async clearAll() {
    const db = await this.db();
    if (!db) return;
    const tx = db.transaction(
      [STORE_META, STORE_RECORDS, STORE_BLOBS, STORE_BLOB_REFS],
      'readwrite',
    );
    await Promise.all([
      tx.objectStore(STORE_META).clear(),
      tx.objectStore(STORE_RECORDS).clear(),
      tx.objectStore(STORE_BLOBS).clear(),
      tx.objectStore(STORE_BLOB_REFS).clear(),
      tx.done,
    ]);
  }

  close() {
    if (this.dbPromise) {
      this.dbPromise.then((db) => db?.close()).catch(() => {});
      this.dbPromise = null;
    }
  }
}

let shared = null;
export function getLocalStore(options) {
  if (!shared || options) {
    shared = new LocalStore(options);
  }
  return shared;
}

export function resetSharedLocalStore() {
  if (shared) shared.close();
  shared = null;
}
