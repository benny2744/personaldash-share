'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { readSessionList, writeSessionList } from '@/lib/cache/hermesCache';

/**
 * Session list/search/CRUD state for the Hermes chat workspace.
 *
 * Owns only the sidebar-facing list lifecycle; the active-session state and
 * its reducer stay in useHermesChat. The active-session side effects of
 * rename/delete (reducer updates when the current session is affected) are
 * layered on by the facade.
 */
export function useHermesSessions({ runtime, cacheStore, profile }) {
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
            setSessions(result.sessions || result || []);
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
          }
        }
      } catch (error) {
        if (isCurrent()) setSessionsError(error.message || String(error));
      } finally {
        if (isCurrent()) setSessionsLoading(false);
      }
    },
    [cacheStore, profile, runtime],
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
        throw new Error(`Failed to ${wasPinned ? 'unpin' : 'pin'} (${response.status})`);
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
