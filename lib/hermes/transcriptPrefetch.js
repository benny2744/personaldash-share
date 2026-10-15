// Background transcript prefetch for the Hermes chat workspace.
//
// After the session list refreshes, the most recent sessions are warmed into
// the IndexedDB transcript cache so opening them renders instantly from the
// local-first path. Selection is a pure, unit-tested decision (top-N recent,
// skip the active session, skip transcripts the reconcile engine would treat
// as fresh); the network write reuses the exact writeTranscript/cursor
// contract resumeSession uses, so prefetched rows are indistinguishable from
// authoritative opens and self-heal through the normal reconcile on mismatch.

import { decideTranscriptSync, writeTranscript } from '../cache/hermesCache';
import { buildTranscriptCursor } from './transcriptSync';

export const PREFETCH_SESSION_LIMIT = 5;
export const PREFETCH_DELAY_MS = 1500;

/** List rows carry `id`; RPC shapes sometimes use `session_id`. */
export function sessionIdFromRow(row) {
  if (typeof row === 'string') return row;
  return row?.session_id || row?.id || null;
}

/**
 * Pick the sessions worth prefetching, most recent first.
 * Non-search list rows only; the active session is excluded so the prefetch
 * can never race the open path's aliased write for the same transcript.
 */
export function selectPrefetchTargets(
  sessions,
  { limit = PREFETCH_SESSION_LIMIT, excludeIds = [] } = {},
) {
  const excluded = new Set(excludeIds.filter(Boolean));
  const picked = [];
  const seen = new Set();
  for (const row of Array.isArray(sessions) ? sessions : []) {
    const id = sessionIdFromRow(row);
    if (!id || excluded.has(id) || seen.has(id)) continue;
    seen.add(id);
    picked.push(row);
    if (picked.length >= limit) break;
  }
  return picked;
}

/**
 * Reuse the exact decision resumeSession's reconcile will make on open:
 * anything other than 'skip' is worth warming. A missing session row (list
 * rows without message metadata) degrades to 'replace' — an extra background
 * fetch at worst.
 */
export function transcriptNeedsPrefetch(cached, sessionRow) {
  return decideTranscriptSync(cached, sessionRow || null) !== 'skip';
}

/**
 * Fetch and cache one transcript. Throws on network failure — the runner is
 * best-effort and treats any error as "skip this session".
 */
export async function prefetchTranscript({
  sessionId,
  sessionRow,
  cached,
  fetchMessages,
  store,
  profile = '',
}) {
  const history = await fetchMessages(sessionId, {});
  const messages = history?.messages || [];
  if (!messages.length) return { sessionId, mode: 'empty' };
  const cursor = buildTranscriptCursor(messages, sessionRow);
  await writeTranscript(
    store,
    sessionId,
    {
      messages,
      title: sessionRow?.title || cached?.title || '',
      canonicalCount: cursor.canonicalCount,
      messageCount: cursor.messageCount,
      lastMessageId: cursor.lastMessageId,
      lastActivityAt: cursor.lastActivityAt,
    },
    { profile },
  );
  return { sessionId, mode: 'prefetched', count: messages.length };
}
