import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  effectiveBudget,
  evictionScore,
  isProtected,
  planPrune,
  pressureLevel,
} from './eviction';
import { PRIORITY } from './config';

const GB = 1024 ** 3;
const DAY = 86400000;

test('effectiveBudget uses configured budget when no quota known', () => {
  assert.equal(effectiveBudget({ quotaBytes: null }), 3 * GB);
});

test('effectiveBudget respects safe fraction and reserve headroom', () => {
  // quota 2 GB: safeFraction => 1.6 GB, reserve => 1.5 GB → min is 1.5 GB
  assert.equal(effectiveBudget({ quotaBytes: 2 * GB }), 2 * GB - 512 * 1024 * 1024);
  // quota 10 GB → configured 3 GB wins
  assert.equal(effectiveBudget({ quotaBytes: 10 * GB }), 3 * GB);
});

test('pressureLevel thresholds', () => {
  assert.equal(pressureLevel(0, 3 * GB), 'normal');
  assert.equal(pressureLevel(2.2 * GB, 3 * GB), 'light');
  assert.equal(pressureLevel(2.7 * GB, 3 * GB), 'active');
  assert.equal(pressureLevel(2.96 * GB, 3 * GB), 'aggressive');
  assert.equal(pressureLevel(3 * GB, 3 * GB), 'aggressive');
  assert.equal(pressureLevel(100, 0), 'aggressive');
});

test('evictionScore: pinned is infinite, priority raises score', () => {
  const now = Date.now();
  const base = { size: 1000, createdAt: now, lastAccessedAt: now };
  assert.equal(evictionScore({ ...base, pinned: true }, now), Infinity);
  assert.equal(evictionScore({ ...base, priority: PRIORITY.PINNED }, now), Infinity);
  assert.ok(evictionScore({ ...base, priority: PRIORITY.HIGH }, now) > evictionScore({ ...base, priority: PRIORITY.LOW }, now));
});

test('evictionScore: LRU — recently accessed scores higher', () => {
  const now = Date.now();
  const fresh = { size: 1000, createdAt: now, lastAccessedAt: now };
  const stale = { size: 1000, createdAt: now - 30 * DAY, lastAccessedAt: now - 14 * DAY };
  assert.ok(evictionScore(fresh, now) > evictionScore(stale, now));
});

test('evictionScore: large objects score lower', () => {
  const now = Date.now();
  const small = { size: 1000, createdAt: now, lastAccessedAt: now };
  const large = { size: 2 * GB, createdAt: now, lastAccessedAt: now };
  assert.ok(evictionScore(small, now) > evictionScore(large, now));
});

test('isProtected: recent chat text and conversation metadata survive', () => {
  const now = Date.now();
  assert.ok(isProtected({ kind: 'message', createdAt: now - DAY }, now));
  assert.ok(isProtected({ kind: 'conversation-meta', createdAt: now - 10 * DAY }, now));
  assert.ok(!isProtected({ kind: 'message', createdAt: now - 10 * DAY }, now));
  assert.ok(!isProtected({ kind: 'attachment', createdAt: now - 4 * DAY }, now));
});

test('planPrune: no eviction under normal pressure', () => {
  const plan = planPrune({ records: [], usedBytes: GB, budgetBytes: 3 * GB });
  assert.equal(plan.level, 'normal');
  assert.deepEqual(plan.evictKeys, []);
});

test('planPrune: frees enough to get back under budget', () => {
  const now = Date.now();
  const records = Array.from({ length: 10 }, (_, i) => ({
    key: ['ns', 'dingtalk', `m${i}`],
    category: 'dingtalk',
    kind: 'attachment',
    size: 0.4 * GB,
    createdAt: now - 30 * DAY,
    lastAccessedAt: now - 30 * DAY,
    priority: PRIORITY.LOW,
  }));
  const plan = planPrune({ records, usedBytes: 4 * GB, budgetBytes: 3 * GB, now });
  assert.equal(plan.level, 'aggressive');
  const freed = plan.evictKeys.length * 0.4 * GB;
  assert.ok(freed >= 1 * GB, `freed ${freed}`);
});

test('planPrune: category weights — most-over-weight category evicted first', () => {
  const now = Date.now();
  const mk = (category, i) => ({
    key: ['ns', category, `${category}-${i}`],
    category,
    kind: 'attachment',
    size: 0.2 * GB,
    createdAt: now - 30 * DAY,
    lastAccessedAt: now - 30 * DAY,
    priority: PRIORITY.LOW,
  });
  // dingtalk way over its 15% share; kb under its 60% share
  // total 2.7 GB of a 3 GB budget → active pressure
  const records = [...Array.from({ length: 12 }, (_, i) => mk('dingtalk', i)), { ...mk('kb', 0), size: 0.3 * GB }];
  const plan = planPrune({ records, usedBytes: 2.7 * GB, budgetBytes: 3 * GB, now });
  assert.equal(plan.level, 'active');
  assert.ok(plan.evictKeys.length > 0);
  assert.ok(plan.evictKeys.every((k) => k[1] === 'dingtalk'));
});

test('planPrune: unused weight is reusable — under-weight category not force-evicted', () => {
  const now = Date.now();
  // Only KB content exists; it may exceed its 60% weight without eviction
  // until pressure thresholds are hit.
  const records = [
    {
      key: ['ns', 'kb', 'doc'],
      category: 'kb',
      kind: 'kb-content',
      size: 2 * GB,
      createdAt: now - DAY,
      lastAccessedAt: now,
      priority: PRIORITY.HIGH,
    },
  ];
  const plan = planPrune({ records, usedBytes: 2 * GB, budgetBytes: 3 * GB, now });
  assert.equal(plan.level, 'normal');
  assert.deepEqual(plan.evictKeys, []);
});

test('planPrune: pinned records never evicted even under aggressive pressure', () => {
  const now = Date.now();
  const records = [
    {
      key: ['ns', 'kb', 'pinned'],
      category: 'kb',
      kind: 'kb-content',
      size: GB,
      createdAt: now - 100 * DAY,
      lastAccessedAt: now - 100 * DAY,
      priority: PRIORITY.LOW,
      pinned: true,
    },
    {
      key: ['ns', 'kb', 'normal'],
      category: 'kb',
      kind: 'kb-content',
      size: GB,
      createdAt: now - 100 * DAY,
      lastAccessedAt: now - 100 * DAY,
      priority: PRIORITY.LOW,
    },
  ];
  const plan = planPrune({ records, usedBytes: 4 * GB, budgetBytes: 3 * GB, now });
  assert.equal(plan.level, 'aggressive');
  assert.deepEqual(plan.evictKeys, [['ns', 'kb', 'normal']]);
});

test('planPrune: protected recent text skipped at light/active pressure', () => {
  const now = Date.now();
  const recentText = {
    key: ['ns', 'agent', 'recent'],
    category: 'agent',
    kind: 'message',
    size: 0.5 * GB,
    createdAt: now - DAY,
    lastAccessedAt: now,
    priority: PRIORITY.HIGH,
  };
  const oldBlob = {
    key: ['ns', 'agent', 'old'],
    category: 'agent',
    kind: 'attachment',
    size: 0.5 * GB,
    createdAt: now - 60 * DAY,
    lastAccessedAt: now - 60 * DAY,
    priority: PRIORITY.LOW,
  };
  const plan = planPrune({ records: [recentText, oldBlob], usedBytes: 2.6 * GB, budgetBytes: 3 * GB, now });
  assert.equal(plan.level, 'active');
  assert.deepEqual(plan.evictKeys, [['ns', 'agent', 'old']]);
});
