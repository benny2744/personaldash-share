/**
 * Transcript reconciliation engine for Hermes sessions.
 *
 * Extracted from useHermesChat's resumeSession: uses the integer message id
 * cursor from the REST endpoint to decide between skip / probe+tail / replace,
 * with cache and WS-projection fallbacks when authoritative sync fails.
 *
 * This module is a behavior-preserving extraction — the skip/probe/tail/
 * replace matrix is pinned by transcriptSync.test.js. Do not "simplify" the
 * branches without updating that matrix; the boundary probe, monotonic id
 * verification and count checks are load-bearing for cache correctness.
 */

import {
  decideTranscriptSync,
  mergeTranscriptTail,
} from '../cache/hermesCache';

/**
 * Fetch the canonical tail of a transcript starting at `startOffset`,
 * verifying row ids increase monotonically and the expected number of rows
 * arrives. Any anomaly invalidates the tail so the caller can fall back to a
 * full replace.
 */
export async function fetchTailRows(
  sessionId,
  startOffset,
  expectedTotal,
  currentCheck,
  fetchMessages,
) {
  const rows = [];
  let offset = startOffset;
  const expectedNew = expectedTotal - startOffset;
  while (rows.length < expectedNew) {
    if (!currentCheck()) {
      return { rows: [], valid: false, reason: 'superseded' };
    }
    const page = await fetchMessages(sessionId, {
      offset,
      limit: 500,
    });
    const pageRows = page.messages || [];
    if (pageRows.length === 0) break;

    let prevId = rows.length > 0 ? rows[rows.length - 1].id : null;
    for (const row of pageRows) {
      if (
        typeof row.id !== 'number' ||
        (prevId != null && row.id <= prevId)
      ) {
        return { rows: [], valid: false, reason: 'non-monotonic id' };
      }
      prevId = row.id;
    }

    rows.push(...pageRows);
    offset += pageRows.length;
    if (pageRows.length < 500) break;
  }
  if (rows.length !== expectedNew) {
    return { rows: [], valid: false, reason: 'count mismatch' };
  }
  return { rows, valid: true };
}

export function buildTranscriptCursor(msgs, row) {
  const canonical = msgs.filter((message) => !message.provisional);
  const numericIds = canonical
    .map((message) => message.id)
    .filter((id) => typeof id === 'number' && Number.isFinite(id));
  return {
    canonicalCount: canonical.length,
    messageCount: row?.message_count ?? canonical.length,
    lastMessageId: numericIds.length ? Math.max(...numericIds) : null,
    lastActivityAt: row?.last_activity_at ?? null,
  };
}

/**
 * Reconcile a cached transcript against fresh session metadata.
 *
 * @param {{
 *   cached: object | null,
 *   sessionRow: { message_count: number, last_activity_at: number } | null,
 *   storedSessionId: string,
 *   rpcMessages: Array<object> | undefined,
 *   isCurrent: () => boolean,
 *   fetchMessages: (sessionId: string, opts?: { offset?: number, limit?: number }) => Promise<{ messages?: Array<object> }>,
 * }} options
 * @returns {Promise<
 *   | { status: 'ok', messages: Array<object>, cursor: object, mode: string }
 *   | { status: 'rpc-fallback', messages: Array<object> }
 * >}
 */
export async function reconcileTranscript({
  cached,
  sessionRow,
  storedSessionId,
  rpcMessages,
  isCurrent,
  fetchMessages,
}) {
  const syncAction = decideTranscriptSync(cached, sessionRow);
  let mode = syncAction;
  let messages;
  let cursor;

  try {
    if (syncAction === 'skip') {
      messages = cached.messages;
      cursor = {
        canonicalCount: cached.canonicalCount,
        messageCount: sessionRow.message_count,
        lastMessageId: cached.lastMessageId,
        lastActivityAt: sessionRow.last_activity_at,
      };
    } else if (syncAction === 'replace' || !sessionRow) {
      const history = await fetchMessages(storedSessionId, {});
      messages = history.messages || [];
      cursor = buildTranscriptCursor(messages, sessionRow);
      mode = 'replace';
    } else if (syncAction === 'probe') {
      const probe = await fetchMessages(storedSessionId, {
        offset: cached.canonicalCount - 1,
        limit: 1,
      });
      const probeRow = probe.messages?.[0];
      if (
        probeRow &&
        typeof probeRow.id === 'number' &&
        probeRow.id === cached.lastMessageId
      ) {
        const tail = await fetchTailRows(
          storedSessionId,
          cached.canonicalCount,
          sessionRow.message_count,
          isCurrent,
          fetchMessages,
        );
        if (tail.valid) {
          messages = mergeTranscriptTail(cached.messages, tail.rows);
          cursor = buildTranscriptCursor(messages, sessionRow);
          mode = 'tail';
        } else {
          const history = await fetchMessages(storedSessionId, {});
          messages = history.messages || [];
          cursor = buildTranscriptCursor(messages, sessionRow);
          mode = 'replace';
        }
      } else {
        const history = await fetchMessages(storedSessionId, {});
        messages = history.messages || [];
        cursor = buildTranscriptCursor(messages, sessionRow);
        mode = 'replace';
      }
    }
  } catch (error) {
    // If authoritative sync fails, keep the existing cache if we have one.
    // Otherwise fall back to the provisional WS projection so the UI isn't
    // empty; it will be canonicalized on the next successful sync.
    if (cached && isCurrent()) {
      return {
        status: 'ok',
        messages: cached.messages,
        cursor: cached,
        mode: 'skip',
      };
    }
    if (rpcMessages && isCurrent()) {
      return { status: 'rpc-fallback', messages: rpcMessages };
    }
    throw error;
  }

  return { status: 'ok', messages, cursor, mode };
}
