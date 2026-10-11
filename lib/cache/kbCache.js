// Knowledge base cache adapter. Metadata index is a snapshot; note bodies are
// keyed by filepath with a contentHash revision so revalidation only
// re-downloads when the body actually changed.

import { incrCounter, markSync } from './diagnostics';

const CATEGORY = 'kb';
const INDEX_ID = 'index';
const NOTE_PREFIX = 'note:';

function approxSize(value) {
  try {
    return JSON.stringify(value)?.length || 0;
  } catch {
    return 0;
  }
}

export async function readKbIndex(store) {
  const row = await store.getRecord(CATEGORY, INDEX_ID);
  if (!row) {
    await incrCounter(store, 'cacheMiss:kb');
    return null;
  }
  await incrCounter(store, 'cacheHit:kb');
  await store.touchRecord(CATEGORY, INDEX_ID);
  return row.data.datasets;
}

export async function writeKbIndex(store, datasets) {
  await store.putRecord({
    category: CATEGORY,
    id: INDEX_ID,
    kind: 'kb-meta',
    data: { datasets, cachedAt: Date.now() },
    size: approxSize(datasets),
    priority: 2,
  });
  await markSync(store, 'kb-index');
}

// Returns { content, contentHash, cachedAt } or null.
export async function readNoteBody(store, filepath) {
  const row = await store.getRecord(CATEGORY, `${NOTE_PREFIX}${filepath}`);
  if (!row) {
    await incrCounter(store, 'cacheMiss:kb');
    return null;
  }
  await incrCounter(store, 'cacheHit:kb');
  await store.touchRecord(CATEGORY, `${NOTE_PREFIX}${filepath}`);
  return row.data;
}

export async function writeNoteBody(store, filepath, { content, contentHash }) {
  await store.putRecord({
    category: CATEGORY,
    id: `${NOTE_PREFIX}${filepath}`,
    kind: 'kb-content',
    text: true,
    data: { content, contentHash, cachedAt: Date.now() },
    size: approxSize(content),
    priority: 2,
  });
}
