'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { reconnectDelayMs } from '@/lib/hermes/reconnect';
import { ensurePersistence, pruneIfNeeded } from '@/lib/cache/manager';

/**
 * Gateway connection lifecycle for the Hermes chat workspace.
 *
 * Owns the runtime connect/reconnect policy (backoff in lib/hermes/reconnect),
 * resume-after-disconnect bookkeeping, and mount/unmount cleanup. It does not
 * own chat state: reducer dispatches arrive via the onConnectionState/onEvent
 * callbacks, and reconnect resume runs through the facade's resumeSession
 * (passed by ref, since it changes identity with session logic).
 */
export function useHermesConnection({
  runtime,
  cacheStore,
  onConnectionState,
  onEvent,
  getSnapshot,
  resumeSessionRef,
  onConnected,
}) {
  const [bootstrapError, setBootstrapError] = useState(null);

  const reconnectTimer = useRef(null);
  const reconnectAttempt = useRef(0);
  const intentionalClose = useRef(false);
  const wasRunningOnDisconnect = useRef(false);
  const ensureConnectedRef = useRef(null);
  const scheduleReconnectRef = useRef(null);
  const onConnectionStateRef = useRef(null);
  const onEventRef = useRef(null);
  const getSnapshotRef = useRef(null);
  const onConnectedRef = useRef(null);

  useEffect(() => {
    onConnectionStateRef.current = onConnectionState;
  }, [onConnectionState]);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    getSnapshotRef.current = getSnapshot;
  }, [getSnapshot]);

  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

  scheduleReconnectRef.current = () => {
    if (reconnectTimer.current || intentionalClose.current) return;
    const delay = reconnectDelayMs(reconnectAttempt.current);
    reconnectTimer.current = setTimeout(async () => {
      reconnectTimer.current = null;
      try {
        await ensureConnectedRef.current?.();
        const current = getSnapshotRef.current?.();
        if (current?.storedSessionId) {
          await resumeSessionRef.current?.(current.storedSessionId, {
            afterDisconnect: wasRunningOnDisconnect.current,
          });
        }
        wasRunningOnDisconnect.current = false;
        reconnectAttempt.current = 0;
      } catch (error) {
        reconnectAttempt.current += 1;
        const close = runtime.lastCloseDiagnostic();
        const base = error.message || String(error);
        setBootstrapError(close ? `${base} [${close}]` : base);
        scheduleReconnectRef.current?.();
      }
    }, delay);
  };

  const ensureConnected = useCallback(async () => {
    try {
      await runtime.connect();
      reconnectAttempt.current = 0;
      setBootstrapError(null);
    } catch (error) {
      const close = runtime.lastCloseDiagnostic();
      const base = error.message || String(error);
      setBootstrapError(close ? `${base} [${close}]` : base);
      throw error;
    }
  }, [runtime]);

  useEffect(() => {
    ensureConnectedRef.current = ensureConnected;
  }, [ensureConnected]);

  useEffect(() => {
    intentionalClose.current = false;
    let cancelled = false;

    const offState = runtime.onConnectionState((connectionState) => {
      onConnectionStateRef.current?.(connectionState);
      if (connectionState === 'open') {
        reconnectAttempt.current = 0;
        setBootstrapError(null);
      }
      if (connectionState === 'closed' || connectionState === 'error') {
        if (getSnapshotRef.current?.()?.running) {
          wasRunningOnDisconnect.current = true;
        }
        if (!intentionalClose.current) {
          scheduleReconnectRef.current?.();
        }
      }
    });
    const offEvent = runtime.onEvent((event) => {
      onEventRef.current?.(event);
    });

    // Best-effort cache housekeeping on mount: request persistent storage and
    // run an opportunistic prune. Never blocks chat startup.
    ensurePersistence().catch(() => {});
    pruneIfNeeded(cacheStore()).catch(() => {});
    (async () => {
      try {
        await ensureConnectedRef.current?.();
        if (!cancelled) await onConnectedRef.current?.();
      } catch (error) {
        if (!cancelled) setBootstrapError(error.message || String(error));
      }
    })();

    return () => {
      cancelled = true;
      intentionalClose.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      offState();
      offEvent();
      runtime.disconnect();
    };
  }, [cacheStore, runtime]);

  return { bootstrapError, ensureConnected };
}
