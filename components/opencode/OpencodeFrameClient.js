'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink, RotateCw } from 'lucide-react';
import { getOpencodeHosts } from '@/lib/opencodeFrameUrl';

const RETURN_TO_KEY = 'personaldash.opencode.returnTo';
const HOSTS = getOpencodeHosts(
  process.env.NEXT_PUBLIC_OPENCODE_HOSTS,
  process.env.NEXT_PUBLIC_OPENCODE_URL,
);

function safeInternalPath(value) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//')
  ) {
    return null;
  }
  return value;
}

export default function OpencodeFrameClient() {
  const [returnTo, setReturnTo] = useState(null);
  const [active, setActive] = useState(HOSTS[0]?.id);
  const [visited, setVisited] = useState(
    () => new Set(HOSTS[0] ? [HOSTS[0].id] : []),
  );
  const [revisions, setRevisions] = useState({});
  const host = HOSTS.find((item) => item.id === active);

  function selectHost(id) {
    setActive(id);
    setVisited((previous) => new Set([...previous, id]));
  }

  function reloadHost() {
    if (host)
      setRevisions((previous) => ({
        ...previous,
        [host.id]: (previous[host.id] || 0) + 1,
      }));
  }

  useEffect(() => {
    let target = null;
    try {
      target = safeInternalPath(sessionStorage.getItem(RETURN_TO_KEY));
      sessionStorage.removeItem(RETURN_TO_KEY);
    } catch {
      // Fall through to a same-origin referrer or the WorkDash landing page.
    }

    if (!target && document.referrer) {
      try {
        const referrer = new URL(document.referrer);
        if (referrer.origin === window.location.origin) {
          target = `${referrer.pathname}${referrer.search}${referrer.hash}`;
        }
      } catch {
        // Invalid referrers are ignored.
      }
    }
    setReturnTo(target || '/');
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--background)]">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-1 border-b border-[var(--border-subtle)] bg-[var(--surface-container-low)] px-3 sm:px-4">
        <button
          type="button"
          onClick={() => window.location.assign(returnTo || '/')}
          className="inline-flex min-h-9 items-center gap-2 rounded-md px-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-container-high)] hover:text-[var(--text-primary)]"
          aria-label="Back to WorkDash"
        >
          <ArrowLeft size={16} />
          <span>Back</span>
        </button>
        {host && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={reloadHost}
              className="inline-flex min-h-11 items-center gap-1 px-2 text-sm"
              title="Reload after signing in. This reloads only the selected server."
            >
              <RotateCw size={15} /> Reload
            </button>
            <a
              href={host.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-9 items-center gap-2 rounded-md px-2 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-container-high)] hover:text-[var(--text-primary)]"
            >
              <span>Sign in / Open full page</span>
              <ExternalLink size={15} />
            </a>
          </div>
        )}
      </div>
      {HOSTS.length > 0 && (
        <div
          role="tablist"
          aria-label="OpenCode servers"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border-subtle)] px-3"
        >
          {HOSTS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`tab-${item.id}`}
              aria-controls={`panel-${item.id}`}
              aria-selected={active === item.id}
              onClick={() => selectHost(item.id)}
              className={`min-h-11 shrink-0 border-b-2 px-3 text-sm ${active === item.id ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-[var(--text-secondary)]'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      {host && (
        <p className="shrink-0 px-4 py-1 text-xs text-[var(--text-secondary)]">
          {new URL(host.url).hostname} · Blank or disconnected? Sign in above,
          then Reload.
        </p>
      )}
      {HOSTS.length ? (
        HOSTS.filter((item) => visited.has(item.id)).map((item) => (
          <div
            key={item.id}
            id={`panel-${item.id}`}
            role="tabpanel"
            aria-labelledby={`tab-${item.id}`}
            hidden={active !== item.id}
            className={
              active === item.id ? 'flex min-h-0 flex-1 flex-col' : 'hidden'
            }
          >
            <iframe
              key={revisions[item.id] || 0}
              src={item.url}
              title={`OpenCode — ${item.label}`}
              className="block min-h-0 w-full flex-1 border-0 bg-white"
              allow="clipboard-read; clipboard-write"
            />
          </div>
        ))
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-[var(--text-secondary)]">
          Configure <code className="mx-1">NEXT_PUBLIC_OPENCODE_URL</code> and
          rebuild the dashboard to enable the OpenCode frame.
        </div>
      )}
    </div>
  );
}
