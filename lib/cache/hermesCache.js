// Hermes (agent chat) cache adapter. The Hermes state.db messages table has a
// real AUTOINCREMENT `id` plus `timestamp`; the dashboard REST endpoint returns
// those raw rows. We therefore treat the integer message id as the canonical
// cursor. The cache stores only canonical (REST-origin) rows; live WS rows are
// kept ephemeral in the reducer and deliberately excluded from persistence.

import { incrCounter, markSync } from './diagnostics';

const CATEGORY = 'agent';
const SESSION_LIST_PREFIX = 'session-list';
const TRANSCRIPT_PREFIX = 'transcript';

// Hermes session keys are `YYYYMMDD_HHMMSS_<6 hex>` (timestamp + random) — not a
// documented global-uniqueness guarantee. Profile switching makes a latent
// collision nastier, so cache ids are namespaced by profile. '' = launch default.
function profileNs(profile) {
  return profile || 'default';
}

function sessionListId(profile) {
  return `${SESSION_LIST_PREFIX}:${profileNs(profile)}`;
}

function transcriptId(profile, sessionId) {
  return `${TRANSCRIPT_PREFIX}:${profileNs(profile)}:${sessionId}`;
}

function approxSize(value) {
  try {
    return JSON.stringify(value)?.length || 0;
  } catch {
    return 0;
  }
}

function isCanonicalMessage(message) {
  return message && message.provisional !== true;
}

function extractCursor(messages) {
  const canonical = messages.filter(isCanonicalMessage);
  const numericIds = canonical
    .map((message) => message.id)
    .filter((id) => typeof id === 'number' && Number.isFinite(id));
  return {
    canonicalCount: canonical.length,
    lastMessageId: numericIds.length ? Math.max(...numericIds) : null,
  };
}

export async function readSessionList(store, profile = '') {
  const id = sessionListId(profile);
  const row = await store.getRecord(CATEGORY, id);
  if (!row) {
    await incrCounter(store, 'cacheMiss:agent');
    return null;
  }
  await incrCounter(store, 'cacheHit:agent');
  await store.touchRecord(CATEGORY, id);
  return { sessions: row.data.sessions || [], cachedAt: row.data.cachedAt };
}

export async function writeSessionList(store, sessions, profile = '') {
  const data = { sessions, cachedAt: Date.now() };
  await store.putRecord({
    category: CATEGORY,
    id: sessionListId(profile),
    kind: 'session-list',
    data,
    size: approxSize(data),
    priority: 2,
  });
  await markSync(store, 'agent-sessions', { count: sessions.length });
}

export async function readTranscript(store, sessionId, profile = '') {
  const id = transcriptId(profile, sessionId);
  const row = await store.getRecord(CATEGORY, id);
  if (!row) {
    await incrCounter(store, 'cacheMiss:agent');
    return null;
  }
  await incrCounter(store, 'cacheHit:agent');
  await store.touchRecord(CATEGORY, id);

  const messages = (row.data.messages || []).filter(isCanonicalMessage);
  const cursor = extractCursor(messages);
  const stored = row.data;
  return {
    messages,
    title: stored.title,
    cachedAt: stored.cachedAt,
    canonicalCount: stored.canonicalCount ?? cursor.canonicalCount,
    messageCount: stored.messageCount ?? cursor.canonicalCount,
    lastMessageId:
      stored.lastMessageId !== undefined
        ? stored.lastMessageId
        : cursor.lastMessageId,
    lastActivityAt: stored.lastActivityAt ?? null,
  };
}

export async function writeTranscript(
  store,
  sessionId,
  {
    messages,
    title,
    canonicalCount,
    messageCount,
    lastMessageId,
    lastActivityAt,
  },
  { aliases = [], profile = '' } = {},
) {
  const canonicalMessages = (messages || []).filter(isCanonicalMessage);
  const cursor = extractCursor(canonicalMessages);
  const data = {
    messages: canonicalMessages,
    title,
    cachedAt: Date.now(),
    canonicalCount: canonicalCount ?? cursor.canonicalCount,
    messageCount: messageCount ?? cursor.canonicalCount,
    lastMessageId:
      lastMessageId !== undefined ? lastMessageId : cursor.lastMessageId,
    lastActivityAt: lastActivityAt ?? null,
  };
  const size = approxSize(data);
  const ids = [sessionId, ...aliases.filter((a) => a && a !== sessionId)];
  for (const sid of ids) {
    await store.putRecord({
      category: CATEGORY,
      id: transcriptId(profile, sid),
      kind: 'transcript',
      text: true,
      data,
      size,
      priority: 2,
    });
  }
  await markSync(store, 'agent-transcript', {
    sessionId,
    messages: canonicalMessages.length,
    bytes: size,
  });
}

/**
 * Decide how to reconcile a cached transcript against fresh session metadata.
 *
 * @param {object|null} cached
 * @param {{message_count: number, last_activity_at: number}} sessionRow
 * @returns {'replace'|'skip'|'probe'}
 */
export function decideTranscriptSync(cached, sessionRow) {
  if (!cached || !sessionRow) return 'replace';
  const hasCursor =
    cached.canonicalCount > 0 &&
    cached.lastMessageId != null &&
    cached.lastActivityAt != null;
  if (!hasCursor) return 'replace';

  if (sessionRow.message_count < cached.canonicalCount) return 'replace';
  if (sessionRow.message_count === cached.canonicalCount) {
    return sessionRow.last_activity_at === cached.lastActivityAt
      ? 'skip'
      : 'replace';
  }
  return 'probe';
}

/**
 * Append canonical tail rows to an existing canonical transcript.
 * The caller must already have verified the boundary row id matches.
 *
 * @param {object[]} existing
 * @param {object[]} tailRows
 */
export function mergeTranscriptTail(existing, tailRows) {
  return [...existing, ...tailRows];
}

// Managed-workspace files. Identity is the path (no server revision exists);
// the network result always replaces the cache when reachable.

export async function readFileListing(store, path) {
  const row = await store.getRecord(CATEGORY, `listing:${path || ''}`);
  if (!row) return null;
  await store.touchRecord(CATEGORY, `listing:${path || ''}`);
  return row.data.listing;
}

export async function writeFileListing(store, path, listing) {
  await store.putRecord({
    category: CATEGORY,
    id: `listing:${path || ''}`,
    kind: 'file-listing',
    data: { listing, cachedAt: Date.now() },
    size: approxSize(listing),
    priority: 1,
  });
}

export async function readFilePreview(store, path) {
  const row = await store.getRecord(CATEGORY, `preview:${path}`);
  if (!row) return null;
  await store.touchRecord(CATEGORY, `preview:${path}`);
  return row.data.preview;
}

export async function writeFilePreview(store, path, preview) {
  await store.putRecord({
    category: CATEGORY,
    id: `preview:${path}`,
    kind: 'file-preview',
    data: { preview, cachedAt: Date.now() },
    size: approxSize(preview),
    priority: 1,
  });
}
