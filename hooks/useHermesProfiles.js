'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Enumerates the Hermes profiles exposed by the deployment. The catalog is
 * cross-profile (profiles.list returns every profile), so it is fetched once
 * per runtime and only re-fetched if the active runtime changes or a prior
 * attempt failed. Selection state and the runtime swap itself live in the
 * facade (useHermesChat), not here.
 *
 * @param {{ runtime: object, ready?: boolean }} args
 *   `ready` gates enumeration until the runtime is connected.
 */
export function useHermesProfiles({ runtime, ready = false }) {
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const loadedFor = useRef(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await runtime.profiles.list();
      setProfiles(rows);
      loadedFor.current = runtime;
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [runtime]);

  useEffect(() => {
    if (ready && loadedFor.current !== runtime) {
      refresh();
    }
  }, [ready, runtime, refresh]);

  return { profiles, loading, error, refresh };
}
