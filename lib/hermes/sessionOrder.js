/**
 * lib/hermes/sessionOrder.js — Pure helpers for pin-aware session ordering.
 *
 * Pins partition the session list: pinned sessions float to the top (ordered
 * by pin time, oldest first), everything else keeps its server-side recency
 * order. Unknown/deleted pin ids are ignored so stale pins never resurrect
 * rows.
 */

export function orderSessionsByPin(sessions, pinnedIds) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (!Array.isArray(pinnedIds) || pinnedIds.length === 0) return list;

  const rank = new Map();
  pinnedIds.forEach((id, index) => {
    if (typeof id === 'string' && id && !rank.has(id)) rank.set(id, index);
  });
  if (rank.size === 0) return list;

  const pinned = [];
  const rest = [];
  for (const session of list) {
    const id = session?.id || session?.session_id;
    if (id && rank.has(id)) pinned.push(session);
    else rest.push(session);
  }
  pinned.sort(
    (a, b) =>
      rank.get(a.id || a.session_id) - rank.get(b.id || b.session_id),
  );
  return [...pinned, ...rest];
}
