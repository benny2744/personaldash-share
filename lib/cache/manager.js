// Cache manager: effective budget, storage pressure, prune orchestration.
// Eviction *decisions* live in eviction.js (pure); this file performs them.

import { evictBlob, removeRecord, sweepOrphanBlobs } from './blobStore';
import { effectiveBudget, planPrune, pressureLevel } from './eviction';
import { markPrune } from './diagnostics';

export async function getStorageEstimate() {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const { quota, usage } = await navigator.storage.estimate();
      return { quotaBytes: quota ?? null, usageBytes: usage ?? null };
    }
  } catch {
    // fall through
  }
  return { quotaBytes: null, usageBytes: null };
}

export async function ensurePersistence() {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      return await navigator.storage.persist();
    }
  } catch {
    // unsupported — fine, cache remains best-effort
  }
  return false;
}

export async function getCacheStatus(store) {
  const { quotaBytes } = await getStorageEstimate();
  const budgetBytes = effectiveBudget({ quotaBytes });
  let persisted = null;
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persisted) {
      persisted = await navigator.storage.persisted();
    }
  } catch {
    // ignore
  }
  const usage = await store.collectUsage();
  const byCategory = {};
  for (const r of [...usage.records, ...usage.blobs]) {
    byCategory[r.category] = (byCategory[r.category] || 0) + (r.size || 0);
  }
  return {
    supported: store.available,
    persisted,
    quotaBytes,
    budgetBytes,
    trackedBytes: usage.totalBytes,
    byCategory,
    level: pressureLevel(usage.totalBytes, budgetBytes),
  };
}

// Prune if usage is above the light threshold. Returns null when nothing ran.
export async function pruneIfNeeded(store, { now = Date.now() } = {}) {
  const { quotaBytes } = await getStorageEstimate();
  const budgetBytes = effectiveBudget({ quotaBytes });
  const usage = await store.collectUsage();

  // Orphan blobs are free wins at any pressure level.
  const swept = await sweepOrphanBlobs(store);

  const plan = planPrune({
    records: [...usage.records, ...usage.blobs],
    usedBytes: usage.totalBytes,
    budgetBytes,
    now,
  });
  if (plan.level === 'normal') {
    if (swept.removed > 0) await markPrune(store, swept.removedBytes, plan.level);
    return { level: plan.level, evicted: 0, removedBytes: swept.removedBytes };
  }

  const recordKeys = new Set(usage.records.map((r) => JSON.stringify(r.key)));
  let evicted = 0;
  let removedBytes = swept.removedBytes;
  for (const key of plan.evictKeys) {
    if (recordKeys.has(JSON.stringify(key))) {
      const [, category, id] = key;
      const res = await removeRecord(store, category, id);
      removedBytes += res.removedBytes;
    } else {
      const [, blobId] = key;
      const res = await evictBlob(store, blobId);
      removedBytes += res.removedBytes;
    }
    evicted += 1;
  }
  await markPrune(store, removedBytes, plan.level);
  return { level: plan.level, evicted, removedBytes };
}
