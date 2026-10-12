'use client';

/**
 * components/terminal/TerminalClient.js — xterm.js frontend for the web
 * terminal. Sessions are created via REST (identity + authorization live
 * server-side); the browser receives only a short-lived lease for the
 * terminal-gateway WebSocket. No credentials ever reach this component.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';

const STATE_STYLES = {
  idle: { label: 'Idle', className: 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]' },
  connecting: { label: 'Connecting…', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  active: { label: 'Connected', className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  grace: { label: 'Reconnecting…', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  closed: { label: 'Closed', className: 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]' },
  failed: { label: 'Failed', className: 'bg-red-500/15 text-red-600 dark:text-red-400' },
};

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function wsUrlFromPath(path) {
  const url = new URL(path, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export default function TerminalClient() {
  const [targets, setTargets] = useState([]);
  const [targetsError, setTargetsError] = useState(null);
  const [hostSlug, setHostSlug] = useState(null);
  const [sessionState, setSessionState] = useState('idle');
  const [message, setMessage] = useState(null);
  const [activeSession, setActiveSession] = useState(null);

  const containerRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const socketRef = useRef(null);
  const sessionRef = useRef(null);
  const stateRef = useRef('idle');
  const graceRef = useRef(null);
  const observerRef = useRef(null);

  const setState = useCallback((next, note) => {
    stateRef.current = next;
    setSessionState(next);
    setMessage(note || null);
  }, []);

  const teardownSocket = useCallback(() => {
    if (graceRef.current) {
      clearTimeout(graceRef.current);
      graceRef.current = null;
    }
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      try {
        socket.close();
      } catch {}
    }
  }, []);

  const detachTerminal = useCallback(() => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    teardownSocket();
    termRef.current?.dispose?.();
    termRef.current = null;
    fitRef.current = null;
  }, [teardownSocket]);

  /** Exchange the current session for a fresh lease and re-attach. */
  const openSocket = useCallback(async (sessionId, wsPath, { isReconnect }) => {
    if (isReconnect) {
      const response = await fetch(
        `/api/terminal/sessions/${encodeURIComponent(sessionId)}/lease`,
        { method: 'POST' },
      );
      if (!response.ok) {
        throw new Error((await response.json().catch(() => ({}))).error || 'Lease refresh failed');
      }
      wsPath = (await response.json()).wsPath;
    }
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrlFromPath(wsPath));
      socketRef.current = socket;
      socket.onopen = () => resolve(socket);
      socket.onerror = () => reject(new Error('WebSocket connection failed'));
      socket.onmessage = (event) => {
        let frame;
        try {
          frame = JSON.parse(event.data);
        } catch {
          return;
        }
        if (frame.type === 'output' && termRef.current) {
          termRef.current.write(base64ToBytes(frame.data));
        } else if (frame.type === 'status') {
          setState(frame.state, frame.message);
        } else if (frame.type === 'exit') {
          setState('closed', `Session ended${frame.reason ? ` (${frame.reason})` : ''}`);
          sessionRef.current = null;
          setActiveSession(null);
          teardownSocket();
        } else if (frame.type === 'error') {
          setState('failed', frame.message || 'Terminal error');
          sessionRef.current = null;
          setActiveSession(null);
          teardownSocket();
        }
      };
      socket.onclose = (event) => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        if (stateRef.current === 'active' && event.code !== 1000) {
          // Browser-side drop or transport hiccup → enter grace reattach.
          setState('grace');
          graceRef.current = setTimeout(() => {
            if (stateRef.current === 'grace') {
              setState('closed', 'Reconnect window closed — start a new session');
              sessionRef.current = null;
              setActiveSession(null);
            }
          }, (sessionRef.current?.graceSeconds ?? 60) * 1000);
          return;
        }
        if (stateRef.current === 'connecting') {
          setState('failed', 'Connection rejected by the gateway');
        }
      };
    });
  }, [setState, teardownSocket]);

  const connect = useCallback(async () => {
    if (!hostSlug || stateRef.current === 'connecting' || stateRef.current === 'active') {
      return;
    }
    detachTerminal();
    setState('connecting');

    // Local xterm so cols/rows match the real viewport before attach.
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]);
    await import('@xterm/xterm/css/xterm.css');
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        "'JetBrains Mono', 'Fira Code', Menlo, Monaco, 'Courier New', monospace",
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#e6edf3',
        selectionBackground: '#264f78',
      },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fit;
    try {
      fit.fit();
    } catch {}

    const { cols, rows } = fit.proposeDimensions();

    let created;
    try {
      const response = await fetch('/api/terminal/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostSlug, cols, rows }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Session create failed (${response.status})`);
      created = payload;
    } catch (error) {
      setState('failed', error.message);
      return;
    }

    sessionRef.current = {
      id: created.sessionId,
      graceSeconds: created.limits?.graceSeconds ?? 60,
    };
    setActiveSession({
      id: created.sessionId,
      hostSlug: created.host?.slug,
      displayName: created.host?.displayName,
    });

    term.onData((data) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: 'input',
            data: bytesToBase64(new TextEncoder().encode(data)),
          }),
        );
      }
    });

    const sendResize = () => {
      const socket = socketRef.current;
      if (!fitRef.current || socket?.readyState !== WebSocket.OPEN) return;
      try {
        const dims = fitRef.current.proposeDimensions();
        if (dims.cols && dims.rows) {
          socket.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
        }
      } catch {}
    };
    term.onResize(sendResize);
    observerRef.current = new ResizeObserver(() => {
      try {
        fitRef.current?.fit();
      } catch {}
    });
    observerRef.current.observe(containerRef.current);

    try {
      await openSocket(created.sessionId, created.wsPath, { isReconnect: false });
    } catch (error) {
      setState('failed', error.message);
    }
  }, [detachTerminal, hostSlug, openSocket, setState]);

  /** Grace reattach: fresh lease → same session, same PTY. */
  useEffect(() => {
    if (sessionState !== 'grace') return undefined;
    let cancelled = false;
    (async () => {
      const session = sessionRef.current;
      if (!session) return;
      try {
        await openSocket(session.id, undefined, { isReconnect: true });
      } catch (error) {
        if (!cancelled) {
          setState('closed', `Reattach failed: ${error.message}`);
          sessionRef.current = null;
          setActiveSession(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openSocket, sessionState, setState]);

  const disconnect = useCallback(async () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    setActiveSession(null);
    setState('idle');
    termRef.current?.reset?.();
    teardownSocket();
    if (session) {
      await fetch(`/api/terminal/sessions/${encodeURIComponent(session.id)}`, {
        method: 'DELETE',
      }).catch(() => {});
    }
  }, [setState, teardownSocket]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/terminal/targets');
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'Could not load targets');
        if (cancelled) return;
        setTargets(payload.hosts || []);
        if (payload.hosts?.length === 1) setHostSlug(payload.hosts[0].slug);
      } catch (error) {
        if (!cancelled) setTargetsError(error.message);
      }
    })();
    return () => {
      cancelled = true;
      detachTerminal();
      sessionRef.current = null;
    };
  }, [detachTerminal]);

  const style = STATE_STYLES[sessionState] || STATE_STYLES.idle;
  const busy = sessionState === 'connecting' || sessionState === 'active' || sessionState === 'grace';

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Slim top bar (mirrors the Hermes Admin chrome) */}
      <div className="flex flex-none items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h1 className="truncate text-sm font-semibold text-[var(--text-primary)]">
            Terminal
          </h1>
          <Badge className={`${style.className} border-transparent`}>{style.label}</Badge>
          {activeSession?.displayName && (
            <span className="truncate text-xs text-[var(--text-secondary)]">
              {activeSession.displayName}
            </span>
          )}
        </div>
        <Select
          value={hostSlug ?? ''}
          onChange={(event) => setHostSlug(event.target.value || null)}
          disabled={busy || !targets.length}
          className="h-8 w-[180px] text-xs"
        >
          <option value="" disabled>
            {targets.length ? 'Choose a host' : 'No hosts available'}
          </option>
          {targets.map((host) => (
            <option key={host.slug} value={host.slug}>
              {host.displayName}
            </option>
          ))}
        </Select>
        {busy ? (
          <Button type="button" variant="outline" size="sm" onClick={disconnect}>
            Disconnect
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={connect}
            disabled={!hostSlug || targets.length === 0}
          >
            Connect
          </Button>
        )}
      </div>

      {(message || targetsError) && (
        <div
          className={`flex-none px-4 py-1.5 text-xs ${
            sessionState === 'failed' || targetsError
              ? 'bg-red-500/10 text-red-600 dark:text-red-400'
              : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
          }`}
        >
          {targetsError || message}
        </div>
      )}

      <div className="relative min-h-0 flex-1 bg-[#0d1117] p-1">
        <div ref={containerRef} className="h-full w-full" />
        {sessionState === 'idle' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="text-sm text-[#8b949e]">
              {targets.length
                ? 'Select a host and press Connect'
                : targetsError || 'No terminal hosts are assigned to you yet'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
