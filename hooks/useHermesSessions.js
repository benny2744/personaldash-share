'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  readSessionList,
  readTranscript,
  writeSessionList,
} from '@/lib/cache/hermesCache';
import {
  prefetchTranscript,
  selectPrefetchTargets,
  transcriptNeedsPrefetch,
  PREFETCH_DELAY_MS,
} from '@/lib/hermes/transcriptPrefetch';

/**
 * Session list/search/CRUD state for the Hermes chat workspace.
 *
 * Owns only the sidebar-facing list lifecycle; the active-session state and
 * its reducer stay in useHermesChat. The active-session side effects of
 * rename/delete (reducer updates when the current session is affected) are
 * layered on by the facade.
 */
export function useHermesSessions({
  runtime,
  cacheStore,
  profile,
  getActiveSessionIds,
}) {
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState(null);
  const [query, setQuery] = useState('');
  const [pinnedIds, setPinnedIds] = useState([]);
  const [searching, setSearching] = useState(false);

  const queryRef = useRef(query);
  const runtimeRef = useRef(runtime);
  const profileRef = useRef(profile);
  const pinnedIdsRef = useRef(pinnedIds);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  // Background transcript prefetch: after a fresh list lands, warm the most
  // recent sessions into the IndexedDB transcript cache so opening them is
  // instant. Best-effort — any failure just means a normal (slower) open.
  const prefetchTimerRef = useRef(null);
  const prefetchRunRef = useRef(0);
  const activeSessionIdsRef = useRef(getActiveSessionIds);

  useEffect(() => {
    activeSessionIdsRef.current = getActiveSessionIds;
  }, [getActiveSessionIds]);

  const cancelPrefetch = useCallback(() => {
    if (prefetchTimerRef.current) {
      clearTimeout(prefetchTimerRef.current);
      prefetchTimerRef.current = null;
    }
    prefetchRunRef.current += 1;
  }, []);

  const scheduleTranscriptPrefetch = useCallback(
    (list) => {
      if (prefetchTimerRef.current) {
        clearTimeout(prefetchTimerRef.current);
      }
      const reqRuntime = runtime;
      const reqProfile = profile;
      const run = ++prefetchRunRef.current;
      const isCurrent = () =>
        prefetchRunRef.current === run &&
        runtimeRef.current === reqRuntime &&
        profileRef.current === reqProfile;
      prefetchTimerRef.current = setTimeout(
        async () => {
          prefetchTimerRef.current = null;
          if (!isCurrent()) return;
          const targets = selectPrefetchTargets(list, {
            excludeIds: activeSessionIdsRef.current?.() || [],
          });
          for (const row of targets) {
            if (!isCurrent()) return;
            const sessionId =
              row?.session_id || row?.id || (typeof row === 'string' ? row : null);
            if (!sessionId) continue;
            try {
              const cached = await readTranscript(
                cacheStore(),
                sessionId,
                reqProfile,
              );
              if (!isCurrent()) return;
              if (!transcriptNeedsPrefetch(cached, row)) continue;
              await prefetchTranscript({
                sessionId,
                sessionRow: row,
                cached,
                fetchMessages: reqRuntime.sessions.getMessages,
                store: cacheStore(),
                profile: reqProfile,
              });
            } catch {
              // Best-effort: leave the cache as-is for this session.
            }
          }
        },
        PREFETCH_DELAY_MS,
      );
    },
    [cacheStore, profile, runtime],
  );

  // Prefetch work never survives a profile/runtime swap or unmount.
  useEffect(() => {
    cancelPrefetch();
    return cancelPrefetch;
  }, [cancelPrefetch, runtime, profile]);

  // A profile switch swaps the runtime instance. Drop the previous profile's
  // list immediately so its sessions never flash under the new profile, and
  // let the in-flight guard below discard any late result from the old runtime.
  useEffect(() => {
    runtimeRef.current = runtime;
    profileRef.current = profile;
    setSessions([]);
    setSessionsLoading(true);
    setSessionsError(null);
    setPinnedIds([]);
    setSearching(false);
  }, [runtime, profile]);

  const refreshPins = useCallback(async () => {
    const reqRuntime = runtime;
    const reqProfile = profile;
    const isCurrent = () =>
      runtimeRef.current === reqRuntime && profileRef.current === reqProfile;
    try {
      const response = await fetch(
        `/api/hermes/pins?profile=${encodeURIComponent(reqProfile)}`,
      );
      if (!response.ok) {
        throw new Error(`Failed to load pins (${response.status})`);
      }
      const data = await response.json();
      if (!isCurrent()) return;
      const ids = (data.pins || [])
        .map((pin) => pin.sessionId)
        .filter((id) => typeof id === 'string' && id);
      pinnedIdsRef.current = ids;
      setPinnedIds(ids);
    } catch (error) {
      // Pins are a preference: on failure keep whatever state we had rather
      // than blocking the session list.
      if (isCurrent()) console.warn('[hermes] failed to load pins', error);
    }
  }, [runtime, profile]);

  useEffect(() => {
    refreshPins();
  }, [refreshPins]);

  const refreshSessions = useCallback(
    async (search = queryRef.current) => {
      const reqRuntime = runtime;
      const reqProfile = profile;
      const isCurrent = () =>
        runtimeRef.current === reqRuntime && profileRef.current === reqProfile;
      const searching = Boolean(String(search || '').trim());
      // Local-first: cached session list renders immediately (never for search
      // results — those are always live).
      if (!searching) {
        const cached = await readSessionList(cacheStore(), reqProfile);
        if (isCurrent() && cached?.sessions?.length) {
          setSessions(cached.sessions);
          setSessionsError(null);
        }
      }
      if (!isCurrent()) return;
      setSessionsLoading(true);
      setSessionsError(null);
      try {
        if (searching) {
          const result = await runtime.sessions.search(String(search).trim());
          if (isCurrent()) {
            setSearching(true);
            // Search endpoint returns { results: [...] }; list returns
            // { sessions: [...] }. Never set a non-array (crashes .map).
            const found = Array.isArray(result)
              ? result
              : result?.results || result?.sessions || [];
            setSessions(found);
          }
        } else {
          const result = await runtime.sessions.list({
            limit: 50,
            order: 'recent',
          });
          const list = result.sessions || [];
          if (isCurrent()) {
            setSearching(false);
            setSessions(list);
            await writeSessionList(cacheStore(), list, reqProfile);
            scheduleTranscriptPrefetch(list);
          }
        }
      } catch (error) {
        if (isCurrent()) setSessionsError(error.message || String(error));
      } finally {
        if (isCurrent()) setSessionsLoading(false);
      }
    },
    [cacheStore, profile, runtime, scheduleTranscriptPrefetch],
  );

  const renameSession = useCallback(
    async (sessionId, title) => {
      await runtime.sessions.rename(sessionId, title);
      await refreshSessions();
    },
    [refreshSessions, runtime],
  );

  const removeSession = useCallback(
    async (sessionId) => {
      await runtime.sessions.delete(sessionId);
      // Best-effort cleanup so deleted sessions don't leave stale pins.
      if (pinnedIdsRef.current.includes(sessionId)) {
        try {
          await fetch('/api/hermes/pins', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              profile: profileRef.current,
              sessionId,
              pinned: false,
            }),
          });
        } catch (error) {
          console.warn('[hermes] failed to unpin deleted session', error);
        }
        const next = pinnedIdsRef.current.filter((id) => id !== sessionId);
        pinnedIdsRef.current = next;
        setPinnedIds(next);
      }
      await refreshSessions();
    },
    [refreshSessions, runtime],
  );

  const togglePin = useCallback(async (sessionId) => {
    const current = pinnedIdsRef.current;
    const wasPinned = current.includes(sessionId);
    const next = wasPinned
      ? current.filter((id) => id !== sessionId)
      : [...current, sessionId];
    // Optimistic: the row flips immediately; revert if the server rejects.
    pinnedIdsRef.current = next;
    setPinnedIds(next);
    try {
      const response = await fetch('/api/hermes/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: profileRef.current,
          sessionId,
          pinned: !wasPinned,
        }),
      });
      if (!response.ok) {
        throw new Error(
          `Failed to ${wasPinned ? 'unpin' : 'pin'} (${response.status})`,
        );
      }
    } catch (error) {
      pinnedIdsRef.current = current;
      setPinnedIds(current);
      console.warn('[hermes] pin toggle failed', error);
    }
  }, []);

  return {
    sessions,
    sessionsLoading,
    sessionsError,
    query,
    setQuery,
    refreshSessions,
    renameSession,
    removeSession,
    pinnedIds,
    togglePin,
    searching,
  };
}
