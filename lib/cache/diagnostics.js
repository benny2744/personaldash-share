// Diagnostics counters persisted in the meta store. Quiet by design — no
// console output on the happy path; counters are read by /settings tooling.

const COUNTERS_KEY = 'diagnostics:counters';
const EVENTS_KEY = 'diagnostics:events';

export async function incrCounter(store, name, amount = 1) {
  const counters = (await store.getMeta(COUNTERS_KEY)) || {};
  counters[name] = (counters[name] || 0) + amount;
  await store.putMeta(COUNTERS_KEY, counters);
}

export async function markPrune(store, removedBytes, level) {
  await incrCounter(store, 'pruneRuns');
  await incrCounter(store, 'prunedBytes', removedBytes);
  await store.putMeta(EVENTS_KEY, {
    ...(await store.getMeta(EVENTS_KEY)),
    lastPrune: { at: Date.now(), removedBytes, level },
  });
}

export async function markSync(store, feature, detail = {}) {
  const events = (await store.getMeta(EVENTS_KEY)) || {};
  events[`lastSync:${feature}`] = { at: Date.now(), ...detail };
  await store.putMeta(EVENTS_KEY, events);
}

export async function getDiagnostics(store) {
  return {
    counters: (await store.getMeta(COUNTERS_KEY)) || {},
    events: (await store.getMeta(EVENTS_KEY)) || {},
  };
}
