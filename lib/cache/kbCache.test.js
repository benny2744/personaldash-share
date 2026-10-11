import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

import { LocalStore } from './localStore';
import { readKbIndex, readNoteBody, writeKbIndex, writeNoteBody } from './kbCache';

function makeStore() {
  return new LocalStore({ dbName: `test-kb-${Date.now()}-${Math.random()}` });
}

test('KB index snapshot roundtrip', async () => {
  const store = makeStore();
  assert.equal(await readKbIndex(store), null);
  await writeKbIndex(store, { concepts: [{ id: 'k1', title: 'C' }] });
  const cached = await readKbIndex(store);
  assert.equal(cached.concepts[0].title, 'C');
  store.close();
});

test('note body roundtrip with contentHash revision', async () => {
  const store = makeStore();
  assert.equal(await readNoteBody(store, 'concepts/a.md'), null);
  await writeNoteBody(store, 'concepts/a.md', { content: '# A', contentHash: 'h1' });
  const cached = await readNoteBody(store, 'concepts/a.md');
  assert.equal(cached.content, '# A');
  assert.equal(cached.contentHash, 'h1');

  // revision change overwrites
  await writeNoteBody(store, 'concepts/a.md', { content: '# A2', contentHash: 'h2' });
  const updated = await readNoteBody(store, 'concepts/a.md');
  assert.equal(updated.contentHash, 'h2');
  store.close();
});

test('note bodies from different paths stay separate', async () => {
  const store = makeStore();
  await writeNoteBody(store, 'a.md', { content: 'A', contentHash: 'ha' });
  await writeNoteBody(store, 'b.md', { content: 'B', contentHash: 'hb' });
  assert.equal((await readNoteBody(store, 'a.md')).content, 'A');
  assert.equal((await readNoteBody(store, 'b.md')).content, 'B');
  store.close();
});
