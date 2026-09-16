import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTranscriptCursor,
  fetchTailRows,
  reconcileTranscript,
} from './transcriptSync.js';

const alwaysCurrent = () => true;

function makeCached({ count = 2, lastId = 2, activity = 100 } = {}) {
  const messages = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `m${i + 1}`,
  }));
  return {
    messages,
    title: 'cached title',
    canonicalCount: count,
    messageCount: count,
    lastMessageId: lastId,
    lastActivityAt: activity,
  };
}

function makeRow({ count, activity }) {
  return { message_count: count, last_activity_at: activity };
}

function rowsFrom(startId, n) {
  return Array.from({ length: n }, (_, i) => ({
    id: startId + i,
    role: 'assistant',
    content: `row-${startId + i}`,
  }));
}

function fakeFetch(pages) {
  const calls = [];
  const fetchMessages = async (sessionId, opts = {}) => {
    // Mirror the REST helper's signature, which defaults offset to 0.
    const { offset = 0, limit } = opts;
    calls.push({ offset, limit });
    const key = `${offset}:${limit}`;
    if (!(key in pages)) throw new Error(`unexpected fetch ${key}`);
    const value = pages[key];
    if (value instanceof Error) throw value;
    return { messages: value };
  };
  return { calls, fetchMessages };
}

describe('fetchTailRows', () => {
  it('returns valid rows when ids are monotonic and the count matches', async () => {
    const { fetchMessages } = fakeFetch({
      '2:500': rowsFrom(3, 2),
    });
    const tail = await fetchTailRows('s1', 2, 4, alwaysCurrent, fetchMessages);
    assert.equal(tail.valid, true);
    assert.deepEqual(tail.rows.map((r) => r.id), [3, 4]);
  });

  it('invalidates the tail on non-monotonic ids', async () => {
    const { fetchMessages } = fakeFetch({
      '2:500': [...rowsFrom(3, 2), { id: 3, role: 'assistant' }],
    });
    const tail = await fetchTailRows('s1', 2, 5, alwaysCurrent, fetchMessages);
    assert.equal(tail.valid, false);
    assert.equal(tail.reason, 'non-monotonic id');
  });

  it('invalidates on count mismatch', async () => {
    const { fetchMessages } = fakeFetch({
      '2:500': rowsFrom(3, 1),
    });
    const tail = await fetchTailRows('s1', 2, 5, alwaysCurrent, fetchMessages);
    assert.equal(tail.valid, false);
    assert.equal(tail.reason, 'count mismatch');
  });

  it('reports superseded when the caller is no longer current', async () => {
    const { fetchMessages } = fakeFetch({});
    const tail = await fetchTailRows('s1', 2, 5, () => false, fetchMessages);
    assert.equal(tail.valid, false);
    assert.equal(tail.reason, 'superseded');
  });
});

describe('buildTranscriptCursor', () => {
  it('derives the cursor from canonical rows and session metadata', () => {
    const messages = [
      { id: 1, role: 'user', content: 'a' },
      { id: 2, role: 'assistant', content: 'b', provisional: true },
      { id: 7, role: 'assistant', content: 'c' },
    ];
    const cursor = buildTranscriptCursor(messages, {
      message_count: 9,
      last_activity_at: 555,
    });
    assert.equal(cursor.canonicalCount, 2);
    assert.equal(cursor.messageCount, 9);
    assert.equal(cursor.lastMessageId, 7);
    assert.equal(cursor.lastActivityAt, 555);
  });

  it('falls back to canonical length when the session row is missing', () => {
    const cursor = buildTranscriptCursor([{ id: 4, role: 'user' }], null);
    assert.equal(cursor.canonicalCount, 1);
    assert.equal(cursor.messageCount, 1);
    assert.equal(cursor.lastMessageId, 4);
    assert.equal(cursor.lastActivityAt, null);
  });
});

describe('reconcileTranscript', () => {
  it('replaces fully when there is no cache', async () => {
    const { calls, fetchMessages } = fakeFetch({
      '0:undefined': rowsFrom(1, 3),
    });
    const result = await reconcileTranscript({
      cached: null,
      sessionRow: makeRow({ count: 3, activity: 200 }),
      storedSessionId: 's1',
      rpcMessages: [],
      isCurrent: alwaysCurrent,
      fetchMessages,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.mode, 'replace');
    assert.equal(result.messages.length, 3);
    assert.equal(result.cursor.canonicalCount, 3);
    assert.equal(result.cursor.lastMessageId, 3);
    assert.equal(calls.length, 1);
  });

  it('skips the transfer when count and activity match the cache', async () => {
    const cached = makeCached({ count: 2, lastId: 2, activity: 100 });
    const { calls, fetchMessages } = fakeFetch({});
    const result = await reconcileTranscript({
      cached,
      sessionRow: makeRow({ count: 2, activity: 100 }),
      storedSessionId: 's1',
      isCurrent: alwaysCurrent,
      fetchMessages,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.mode, 'skip');
    assert.equal(result.messages, cached.messages);
    assert.deepEqual(result.cursor, {
      canonicalCount: 2,
      messageCount: 2,
      lastMessageId: 2,
      lastActivityAt: 100,
    });
    assert.equal(calls.length, 0);
  });

  it('appends a verified tail when the boundary probe matches', async () => {
    const cached = makeCached({ count: 2, lastId: 2, activity: 100 });
    const { fetchMessages } = fakeFetch({
      '1:1': [{ id: 2, role: 'assistant', content: 'm2' }],
      '2:500': rowsFrom(3, 2),
    });
    const result = await reconcileTranscript({
      cached,
      sessionRow: makeRow({ count: 4, activity: 300 }),
      storedSessionId: 's1',
      isCurrent: alwaysCurrent,
      fetchMessages,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.mode, 'tail');
    assert.deepEqual(
      result.messages.map((m) => m.id),
      [1, 2, 3, 4],
    );
    assert.equal(result.cursor.canonicalCount, 4);
    assert.equal(result.cursor.lastMessageId, 4);
  });

  it('replaces when the boundary probe mismatches', async () => {
    const cached = makeCached({ count: 2, lastId: 2, activity: 100 });
    const { fetchMessages } = fakeFetch({
      '1:1': [{ id: 99, role: 'assistant', content: 'mutated' }],
      '0:undefined': rowsFrom(1, 4),
    });
    const result = await reconcileTranscript({
      cached,
      sessionRow: makeRow({ count: 4, activity: 300 }),
      storedSessionId: 's1',
      isCurrent: alwaysCurrent,
      fetchMessages,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.mode, 'replace');
    assert.equal(result.messages.length, 4);
  });

  it('replaces when the tail turns out to be non-monotonic', async () => {
    const cached = makeCached({ count: 2, lastId: 2, activity: 100 });
    const { fetchMessages } = fakeFetch({
      '1:1': [{ id: 2, role: 'assistant', content: 'm2' }],
      '2:500': [...rowsFrom(4, 2), { id: 4, role: 'assistant' }],
      '0:undefined': rowsFrom(1, 5),
    });
    const result = await reconcileTranscript({
      cached,
      sessionRow: makeRow({ count: 5, activity: 300 }),
      storedSessionId: 's1',
      isCurrent: alwaysCurrent,
      fetchMessages,
    });
    assert.equal(result.mode, 'replace');
    assert.equal(result.messages.length, 5);
  });

  it('replaces when the tail count mismatches', async () => {
    const cached = makeCached({ count: 2, lastId: 2, activity: 100 });
    const { fetchMessages } = fakeFetch({
      '1:1': [{ id: 2, role: 'assistant', content: 'm2' }],
      '2:500': rowsFrom(3, 1),
      '0:undefined': rowsFrom(1, 4),
    });
    const result = await reconcileTranscript({
      cached,
      sessionRow: makeRow({ count: 4, activity: 300 }),
      storedSessionId: 's1',
      isCurrent: alwaysCurrent,
      fetchMessages,
    });
    assert.equal(result.mode, 'replace');
    assert.equal(result.messages.length, 4);
  });

  it('falls back to the cache when authoritative sync fails', async () => {
    const cached = makeCached({ count: 2, lastId: 2, activity: 100 });
    const { fetchMessages } = fakeFetch({
      '0:undefined': new Error('network down'),
    });
    const result = await reconcileTranscript({
      cached,
      sessionRow: makeRow({ count: 4, activity: 300 }),
      storedSessionId: 's1',
      rpcMessages: [{ role: 'assistant', text: 'ws projection' }],
      isCurrent: alwaysCurrent,
      fetchMessages,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.mode, 'skip');
    assert.equal(result.messages, cached.messages);
    assert.equal(result.cursor, cached);
  });

  it('requests the rpc-fallback path when there is no cache and sync fails', async () => {
    const rpc = [{ role: 'assistant', text: 'ws projection' }];
    const { fetchMessages } = fakeFetch({
      '0:undefined': new Error('network down'),
    });
    const result = await reconcileTranscript({
      cached: null,
      sessionRow: null,
      storedSessionId: 's1',
      rpcMessages: rpc,
      isCurrent: alwaysCurrent,
      fetchMessages,
    });
    assert.deepEqual(result, { status: 'rpc-fallback', messages: rpc });
  });

  it('throws when sync fails with no cache and no rpc projection', async () => {
    const { fetchMessages } = fakeFetch({
      '0:undefined': new Error('network down'),
    });
    await assert.rejects(() =>
      reconcileTranscript({
        cached: null,
        sessionRow: null,
        storedSessionId: 's1',
        isCurrent: alwaysCurrent,
        fetchMessages,
      }),
    );
  });

  it('does not take the rpc-fallback path when superseded', async () => {
    const { fetchMessages } = fakeFetch({
      '0:undefined': new Error('network down'),
    });
    await assert.rejects(() =>
      reconcileTranscript({
        cached: null,
        sessionRow: null,
        storedSessionId: 's1',
        rpcMessages: [{ role: 'assistant' }],
        isCurrent: () => false,
        fetchMessages,
      }),
    );
  });
});
