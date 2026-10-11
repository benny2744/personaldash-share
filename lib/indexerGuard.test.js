import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  shouldRunReconcile,
  createDeletionBreaker,
} from './indexerGuard.js';

test('shouldRunReconcile allows a healthy scan', () => {
  assert.equal(shouldRunReconcile(3120, 3120), true);
  assert.equal(shouldRunReconcile(4000, 3120), true);
  // A big-but-plausible prune (files slightly ahead of DB) is allowed
  assert.equal(shouldRunReconcile(1800, 3120), true);
});

test('shouldRunReconcile refuses an empty vault listing', () => {
  // The 2026-10-06 incident signature: VAULT_PATH wrong/unmounted → 0 files
  assert.equal(shouldRunReconcile(0, 3120), false);
});

test('shouldRunReconcile refuses a listing far below the live library', () => {
  assert.equal(shouldRunReconcile(1000, 3120), false);
});

test('shouldRunReconcile allows when nothing is live', () => {
  assert.equal(shouldRunReconcile(0, 0), true);
  assert.equal(shouldRunReconcile(5, 0), true);
});

test('deletion breaker allows bursts under the limit', () => {
  let t = 1000;
  const breaker = createDeletionBreaker({ limit: 5, windowMs: 60_000, now: () => t });
  for (let i = 0; i < 5; i++) {
    assert.equal(breaker.record().allowed, true);
  }
});

test('deletion breaker trips at the limit and refuses until the window drains', () => {
  let t = 1000;
  const breaker = createDeletionBreaker({ limit: 5, windowMs: 60_000, now: () => t });
  for (let i = 0; i < 5; i++) breaker.record();

  const refused = breaker.record();
  assert.equal(refused.allowed, false);
  assert.equal(refused.trippedCount, 1);
  assert.equal(breaker.record().trippedCount, 2);

  // Advance past the window: old stamps expire, breaker resets
  t += 61_000;
  assert.equal(breaker.record().allowed, true);
  assert.equal(breaker.record().trippedCount, 0);
});

test('deletion breaker stamps expire individually', () => {
  let t = 1000;
  const breaker = createDeletionBreaker({ limit: 3, windowMs: 60_000, now: () => t });
  breaker.record();
  t += 30_000;
  breaker.record();
  t += 31_000; // first stamp (t=1000) is now 60s old — expired
  assert.equal(breaker.record().allowed, true);
  t += 1_000;
  assert.equal(breaker.record().allowed, true);
});

test('deletion breaker reset clears state', () => {
  let t = 1000;
  const breaker = createDeletionBreaker({ limit: 2, windowMs: 60_000, now: () => t });
  breaker.record();
  breaker.record();
  assert.equal(breaker.record().allowed, false);
  breaker.reset();
  assert.equal(breaker.record().allowed, true);
});
