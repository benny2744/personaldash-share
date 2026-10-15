import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PREFETCH_SESSION_LIMIT,
  prefetchTranscript,
  selectPrefetchTargets,
  sessionIdFromRow,
  transcriptNeedsPrefetch,
} from './transcriptPrefetch.js';

const row = (id, extra = {}) => ({ id, ...extra });

// Minimal store double covering writeTranscript (putRecord) and the
// diagnostics markSync it triggers (getMeta/putMeta).
function makeStore() {
  const records = [];
  const meta = new Map();
  return {
    records,
    async putRecord(record) {
      records.push(record);
    },
    async getRecord() {
      return null;
    },
    async touchRecord() {},
    async getMeta(key) {
      return meta.get(key) || null;
    },
    async putMeta(key, value) {
      meta.set(key, value);
    },
  };
}

describe('sessionIdFromRow', () => {
  it('prefers session_id over id and handles bare strings', () => {
    assert.equal(sessionIdFromRow({ session_id: 'a', id: 'b' }), 'a');
    assert.equal(sessionIdFromRow({ id: 'b' }), 'b');
    assert.equal(sessionIdFromRow('c'), 'c');
    assert.equal(sessionIdFromRow(null), null);
    assert.equal(sessionIdFromRow({}), null);
  });
});

describe('selectPrefetchTargets', () => {
  it('picks at most the configured limit, most recent first', () => {
    const sessions = [row('a'), row('b'), row('c'), row('d')];
    const picked = selectPrefetchTargets(sessions);
    assert.deepEqual(picked, [row('a'), row('b'), row('c'), row('d')]);
    assert.deepEqual(
      selectPrefetchTargets(sessions, { limit: 2 }).map((r) => r.id),
      ['a', 'b'],
    );
  });

  it('caps at PREFETCH_SESSION_LIMIT by default', () => {
    const sessions = Array.from({ length: 20 }, (_, i) => row(`s${i}`));
    assert.equal(selectPrefetchTargets(sessions).length, PREFETCH_SESSION_LIMIT);
  });

  it('excludes active session ids (live + stored forms)', () => {
    const sessions = [row('live'), row('stored'), row('other')];
    const picked = selectPrefetchTargets(sessions, {
      excludeIds: ['live', 'stored', null],
    });
    assert.deepEqual(picked.map((r) => r.id), ['other']);
  });

  it('dedupes and skips rows without an id', () => {
    const sessions = [row('a'), {}, row('a'), row('b'), null];
    const picked = selectPrefetchTargets(sessions);
    assert.deepEqual(picked.map((r) => r.id), ['a', 'b']);
  });

  it('tolerates non-array input', () => {
    assert.deepEqual(selectPrefetchTargets(null), []);
    assert.deepEqual(selectPrefetchTargets(undefined), []);
  });
});

describe('transcriptNeedsPrefetch', () => {
  const cached = {
    canonicalCount: 10,
    lastMessageId: 42,
    lastActivityAt: 1000,
  };

  it('wants a prefetch when nothing is cached', () => {
    assert.equal(transcriptNeedsPrefetch(null, row('a')), true);
  });

  it('wants a prefetch when session metadata is missing (unknown state)', () => {
    assert.equal(transcriptNeedsPrefetch(cached, null), true);
  });

  it('skips when the cache matches the session row exactly', () => {
    assert.equal(
      transcriptNeedsPrefetch(cached, { message_count: 10, last_activity_at: 1000 }),
      false,
    );
  });

  it('wants a prefetch on growth, shrink, or activity change', () => {
    assert.equal(
      transcriptNeedsPrefetch(cached, { message_count: 15, last_activity_at: 1000 }),
      true,
    );
    assert.equal(
      transcriptNeedsPrefetch(cached, { message_count: 9, last_activity_at: 1000 }),
      true,
    );
    assert.equal(
      transcriptNeedsPrefetch(cached, { message_count: 10, last_activity_at: 1001 }),
      true,
    );
  });
});

describe('prefetchTranscript', () => {
  const messages = [
    { id: 1, role: 'user', content: 'hi' },
    { id: 2, role: 'assistant', content: 'hello' },
  ];

  it('fetches the full transcript and writes it with a cursor under the profile namespace', async () => {
    const store = makeStore();
    const fetches = [];
    const result = await prefetchTranscript({
      sessionId: 's1',
      sessionRow: { id: 's1', title: 'T', message_count: 2, last_activity_at: 7 },
      cached: null,
      fetchMessages: async (id) => {
        fetches.push(id);
        return { messages };
      },
      store,
      profile: 'work',
    });

    assert.deepEqual(fetches, ['s1']);
    assert.equal(result.mode, 'prefetched');
    assert.equal(result.count, 2);
    assert.equal(store.records.length, 1);
    const record = store.records[0];
    assert.equal(record.id, 'transcript:work:s1');
    assert.equal(record.data.title, 'T');
    assert.equal(record.data.canonicalCount, 2);
    assert.equal(record.data.messageCount, 2);
    assert.equal(record.data.lastMessageId, 2);
    assert.equal(record.data.lastActivityAt, 7);
    assert.deepEqual(record.data.messages, messages);
  });

  it('falls back to the cached title when the row has none', async () => {
    const store = makeStore();
    await prefetchTranscript({
      sessionId: 's1',
      sessionRow: { id: 's1', message_count: 2, last_activity_at: 7 },
      cached: { title: 'old title' },
      fetchMessages: async () => ({ messages }),
      store,
    });
    assert.equal(store.records[0].data.title, 'old title');
  });

  it('reports empty without writing when the transcript has no rows', async () => {
    const store = makeStore();
    const result = await prefetchTranscript({
      sessionId: 's1',
      sessionRow: null,
      cached: null,
      fetchMessages: async () => ({ messages: [] }),
      store,
    });
    assert.equal(result.mode, 'empty');
    assert.equal(store.records.length, 0);
  });

  it('propagates fetch failures to the caller', async () => {
    await assert.rejects(
      prefetchTranscript({
        sessionId: 's1',
        sessionRow: null,
        cached: null,
        fetchMessages: async () => {
          throw new Error('network down');
        },
        store: makeStore(),
      }),
      /network down/,
    );
  });
});
