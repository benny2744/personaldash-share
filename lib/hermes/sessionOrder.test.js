import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { orderSessionsByPin } from './sessionOrder.js';

const session = (id, extra = {}) => ({ id, ...extra });

describe('orderSessionsByPin', () => {
  it('returns the list unchanged when there are no pins', () => {
    const sessions = [session('a'), session('b')];
    assert.equal(orderSessionsByPin(sessions, []), sessions);
    assert.equal(orderSessionsByPin(sessions, undefined), sessions);
  });

  it('floats pinned sessions first, in pin order', () => {
    const sessions = [session('a'), session('b'), session('c')];
    const ordered = orderSessionsByPin(sessions, ['c', 'a']);
    assert.deepEqual(
      ordered.map((s) => s.id),
      ['c', 'a', 'b'],
    );
  });

  it('keeps unpinned sessions in their existing order', () => {
    const sessions = [session('a'), session('b'), session('c'), session('d')];
    const ordered = orderSessionsByPin(sessions, ['d']);
    assert.deepEqual(
      ordered.map((s) => s.id),
      ['d', 'a', 'b', 'c'],
    );
  });

  it('ignores pin ids that are not in the list (deleted sessions)', () => {
    const sessions = [session('a'), session('b')];
    const ordered = orderSessionsByPin(sessions, ['gone', 'b']);
    assert.deepEqual(
      ordered.map((s) => s.id),
      ['b', 'a'],
    );
  });

  it('falls back to session_id when id is missing', () => {
    const sessions = [{ session_id: 'a' }, { session_id: 'b' }];
    const ordered = orderSessionsByPin(sessions, ['b']);
    assert.deepEqual(
      ordered.map((s) => s.session_id),
      ['b', 'a'],
    );
  });

  it('deduplicates pin ids and ignores invalid entries', () => {
    const sessions = [session('a'), session('b'), session('c')];
    const ordered = orderSessionsByPin(sessions, ['b', 7, null, 'b', '']);
    assert.deepEqual(
      ordered.map((s) => s.id),
      ['b', 'a', 'c'],
    );
  });
});
