import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

import { LocalStore } from './localStore';
import {
  decideTranscriptSync,
  mergeTranscriptTail,
  readSessionList,
  readTranscript,
  writeSessionList,
  writeTranscript,
} from './hermesCache';
import { getDiagnostics } from './diagnostics';

function makeStore() {
  return new LocalStore({
    dbName: `test-hermes-${Date.now()}-${Math.random()}`,
  });
}

test('session list: miss → write → hit', async () => {
  const store = makeStore();
  assert.equal(await readSessionList(store), null);

  const sessions = [{ id: 's1', title: 'Chat A' }];
  await writeSessionList(store, sessions);
  const cached = await readSessionList(store);
  assert.equal(cached.sessions[0].title, 'Chat A');
  assert.ok(cached.cachedAt > 0);
  store.close();
});

test('transcript: write with aliases, read by either id', async () => {
  const store = makeStore();
  await writeTranscript(
    store,
    'stored-1',
    { messages: [{ role: 'user', content: 'hi' }], title: 'T' },
    { aliases: ['live-1', 'sidebar-1'] },
  );
  const a = await readTranscript(store, 'stored-1');
  const b = await readTranscript(store, 'live-1');
  assert.equal(a.messages.length, 1);
  assert.equal(b.messages.length, 1);
  assert.equal(b.title, 'T');
  store.close();
});

test('transcript snapshot replaces wholesale (snapshot model)', async () => {
  const store = makeStore();
  await writeTranscript(store, 's1', {
    messages: [{ role: 'user', content: 'one' }],
  });
  await writeTranscript(store, 's1', {
    messages: [{ role: 'user', content: 'two' }],
  });
  const cached = await readTranscript(store, 's1');
  assert.equal(cached.messages.length, 1);
  assert.equal(cached.messages[0].content, 'two');
  store.close();
});

test('hit/miss counters accumulate in diagnostics', async () => {
  const store = makeStore();
  await readSessionList(store);
  await writeSessionList(store, [{ id: 'x' }]);
  await readSessionList(store);
  const diag = await getDiagnostics(store);
  assert.equal(diag.counters['cacheMiss:agent'], 1);
  assert.equal(diag.counters['cacheHit:agent'], 1);
  assert.ok(diag.events['lastSync:agent-sessions'].at > 0);
  store.close();
});

test('transcripts survive across store instances (persistence)', async () => {
  const dbName = `test-hermes-persist-${Date.now()}`;
  const first = new LocalStore({ dbName });
  await writeTranscript(first, 's1', {
    messages: [{ role: 'assistant', content: 'remembered' }],
  });
  first.close();

  const second = new LocalStore({ dbName });
  const cached = await readTranscript(second, 's1');
  assert.equal(cached.messages[0].content, 'remembered');
  second.close();
});

test('writeTranscript filters out provisional rows', async () => {
  const store = makeStore();
  await writeTranscript(store, 's1', {
    messages: [
      { role: 'user', content: 'hi', id: 1 },
      { role: 'assistant', content: 'live', provisional: true },
      { role: 'user', content: 'again', id: 2 },
    ],
    title: 'T',
  });
  const cached = await readTranscript(store, 's1');
  assert.equal(cached.messages.length, 2);
  assert.equal(
    cached.messages.every((m) => !m.provisional),
    true,
  );
  assert.equal(cached.canonicalCount, 2);
  assert.equal(cached.lastMessageId, 2);
  store.close();
});

test('readTranscript derives defaults for legacy snapshots', async () => {
  const store = makeStore();
  await writeTranscript(store, 'legacy', {
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'y' },
    ],
    title: 'Legacy',
  });
  const cached = await readTranscript(store, 'legacy');
  assert.equal(cached.canonicalCount, 2);
  assert.equal(cached.lastMessageId, null);
  assert.equal(cached.messageCount, 2);
  assert.equal(cached.lastActivityAt, null);
  store.close();
});

test('session list is namespaced by profile (no cross-profile clobber)', async () => {
  const store = makeStore();
  await writeSessionList(store, [{ id: 'a', title: 'Profile A chat' }], 'coding');
  await writeSessionList(store, [{ id: 'b', title: 'Profile B chat' }], 'research');
  const a = await readSessionList(store, 'coding');
  const b = await readSessionList(store, 'research');
  assert.equal(a.sessions[0].title, 'Profile A chat');
  assert.equal(b.sessions[0].title, 'Profile B chat');
  // The default namespace is distinct from both named profiles.
  assert.equal(await readSessionList(store, ''), null);
  store.close();
});

test('transcript cache is namespaced by profile (session-key collisions are safe)', async () => {
  // Hermes session keys are timestamp+random, not a documented global-uniqueness
  // guarantee, so the same id under two profiles must not read each other's rows.
  const store = makeStore();
  await writeTranscript(
    store,
    '20260912_090000_deadbe',
    { messages: [{ role: 'user', content: 'coding' }], title: 'Coding' },
    { profile: 'coding' },
  );
  await writeTranscript(
    store,
    '20260912_090000_deadbe',
    { messages: [{ role: 'user', content: 'research' }], title: 'Research' },
    { profile: 'research' },
  );
  const coding = await readTranscript(store, '20260912_090000_deadbe', 'coding');
  const research = await readTranscript(
    store,
    '20260912_090000_deadbe',
    'research',
  );
  assert.equal(coding.messages[0].content, 'coding');
  assert.equal(research.messages[0].content, 'research');
  // Default namespace is separate from both.
  assert.equal(await readTranscript(store, '20260912_090000_deadbe', ''), null);
  store.close();
});

test('transcript aliases stay within the profile namespace', async () => {
  const store = makeStore();
  await writeTranscript(
    store,
    'stored-1',
    { messages: [{ role: 'user', content: 'hi' }], title: 'T' },
    { aliases: ['live-1'], profile: 'coding' },
  );
  assert.equal(
    (await readTranscript(store, 'live-1', 'coding')).messages[0].content,
    'hi',
  );
  // The alias is not readable under a different profile.
  assert.equal(await readTranscript(store, 'live-1', 'research'), null);
  store.close();
});

test('decideTranscriptSync: unchanged sessions skip transfer', () => {
  const cached = {
    canonicalCount: 10,
    lastMessageId: 100,
    lastActivityAt: 1234567890,
  };
  assert.equal(
    decideTranscriptSync(cached, {
      message_count: 10,
      last_activity_at: 1234567890,
    }),
    'skip',
  );
});

test('decideTranscriptSync: mutations trigger replace', () => {
  const cached = {
    canonicalCount: 10,
    lastMessageId: 100,
    lastActivityAt: 1234567890,
  };
  assert.equal(
    decideTranscriptSync(cached, { message_count: 9, last_activity_at: 0 }),
    'replace',
  );
  assert.equal(
    decideTranscriptSync(cached, {
      message_count: 10,
      last_activity_at: 1234567891,
    }),
    'replace',
  );
});

test('decideTranscriptSync: growth triggers boundary probe', () => {
  const cached = {
    canonicalCount: 10,
    lastMessageId: 100,
    lastActivityAt: 1234567890,
  };
  assert.equal(
    decideTranscriptSync(cached, {
      message_count: 15,
      last_activity_at: 1234567890,
    }),
    'probe',
  );
});

test('decideTranscriptSync: missing cursor falls back to replace', () => {
  assert.equal(
    decideTranscriptSync(null, { message_count: 10, last_activity_at: 1 }),
    'replace',
  );
  assert.equal(
    decideTranscriptSync(
      { canonicalCount: 0, lastMessageId: null, lastActivityAt: 1 },
      { message_count: 5, last_activity_at: 1 },
    ),
    'replace',
  );
});

test('mergeTranscriptTail appends canonical rows', () => {
  const existing = [{ id: 1, role: 'user', content: 'hi' }];
  const tail = [{ id: 2, role: 'assistant', content: 'hello' }];
  const merged = mergeTranscriptTail(existing, tail);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].content, 'hello');
});
