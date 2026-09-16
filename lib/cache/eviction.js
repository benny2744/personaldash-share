// Pure eviction logic. No I/O — every function takes plain data so it can be
// unit-tested exhaustively without IndexedDB.

import {
  CATEGORY_WEIGHTS,
  CONFIGURED_BUDGET_BYTES,
  PRESSURE,
  PRIORITY,
  QUOTA_RESERVE_BYTES,
  QUOTA_SAFE_FRACTION,
  RETENTION,
  SCORING,
} from './config';

export function effectiveBudget({ quotaBytes, configuredBytes = CONFIGURED_BUDGET_BYTES } = {}) {
  const candidates = [configuredBytes];
  if (Number.isFinite(quotaBytes) && quotaBytes > 0) {
    candidates.push(Math.floor(quotaBytes * QUOTA_SAFE_FRACTION));
    candidates.push(Math.max(0, quotaBytes - QUOTA_RESERVE_BYTES));
  }
  return Math.min(...candidates);
}

export function pressureLevel(usedBytes, budgetBytes) {
  if (!budgetBytes || budgetBytes <= 0) return 'aggressive';
  const ratio = usedBytes / budgetBytes;
  if (ratio >= PRESSURE.AGGRESSIVE) return 'aggressive';
  if (ratio >= PRESSURE.ACTIVE) return 'active';
  if (ratio >= PRESSURE.LIGHT) return 'light';
  return 'normal';
}

export function evictionScore(record, now = Date.now()) {
  if (record.pinned || record.priority === PRIORITY.PINNED) return Infinity;
  const priorityBonus = SCORING.PRIORITY_BONUS[record.priority ?? PRIORITY.MEDIUM] ?? 0;
  const sinceAccess = Math.max(0, now - (record.lastAccessedAt || record.createdAt || 0));
  const recency =
    SCORING.RECENCY_FULL_BONUS *
    Math.pow(0.5, sinceAccess / SCORING.RECENCY_HALF_LIFE_MS);
  const ageMs = Math.max(0, now - (record.createdAt || now));
  const agePenalty = Math.min(
    SCORING.AGE_PENALTY_MAX,
    (ageMs / 86400000) * SCORING.AGE_PENALTY_PER_DAY,
  );
  const sizePenalty = ((record.size || 0) / 1073741824) * SCORING.SIZE_PENALTY_PER_GB;
  return priorityBonus + recency - agePenalty - sizePenalty;
}

function protectionMs(record) {
  if (record.kind === 'temp') return RETENTION.TEMP_TTL_MS;
  if (record.kind === 'conversation-meta' || record.kind === 'session-meta') {
    return RETENTION.CONVERSATION_META_PROTECT_MS;
  }
  if (record.kind === 'message') return RETENTION.CHAT_TEXT_PROTECT_MS;
  if (record.kind === 'attachment' || record.kind === 'blob') {
    return RETENTION.CHAT_ATTACHMENT_PROTECT_MS;
  }
  if (record.kind === 'kb-content' && record.text) return RETENTION.KB_TEXT_PROTECT_MS;
  return 0;
}

export function isProtected(record, now = Date.now()) {
  if (record.pinned || record.priority === PRIORITY.PINNED) return true;
  const protectMs = protectionMs(record);
  if (!protectMs) return false;
  return now - (record.createdAt || 0) < protectMs;
}

function evictableWithinPressure(record, level, now) {
  if (!isProtected(record, now)) return true;
  // Aggressive pressure may cut through soft protection windows, but never pinned.
  return level === 'aggressive' && !record.pinned && record.priority !== PRIORITY.PINNED;
}

// Decide which records to evict to get back under budget.
// records: [{ key, category, kind, size, createdAt, lastAccessedAt, priority, pinned, ... }]
// Returns an ordered list of keys to evict (most expendable first).
export function planPrune({ records, usedBytes, budgetBytes, now = Date.now() }) {
  const level = pressureLevel(usedBytes, budgetBytes);
  if (level === 'normal') return { level, evictKeys: [], targetFreeBytes: 0 };

  const overBy = usedBytes - budgetBytes;
  const targetFreeBytes =
    level === 'light'
      ? Math.max(Math.ceil(overBy), Math.ceil(budgetBytes * 0.05))
      : level === 'active'
        ? Math.max(Math.ceil(overBy), Math.ceil(budgetBytes * 0.15))
        : Math.max(Math.ceil(overBy), Math.ceil(budgetBytes * 0.3));

  const usageByCategory = {};
  for (const r of records) {
    usageByCategory[r.category] = (usageByCategory[r.category] || 0) + (r.size || 0);
  }
  // Over-weight share: how far a category exceeds its soft target. Negative
  // means the category is under its weight and should be evicted last.
  const overShare = (category) =>
    (usageByCategory[category] || 0) - (CATEGORY_WEIGHTS[category] || 0.1) * budgetBytes;

  const candidates = records
    .filter((r) => evictableWithinPressure(r, level, now))
    .map((r) => ({ key: r.key, size: r.size || 0, order: overShare(r.category) - evictionScore(r, now) }))
    .sort((a, b) => b.order - a.order);

  const evictKeys = [];
  let freed = 0;
  for (const c of candidates) {
    if (freed >= targetFreeBytes) break;
    evictKeys.push(c.key);
    freed += c.size;
  }
  return { level, evictKeys, targetFreeBytes };
}
