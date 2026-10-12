'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink } from 'lucide-react';

const RETURN_TO_KEY = 'personaldash.opencode.returnTo';

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

// The dashboard image is shared by every VM, so the OpenCode origin cannot be
// baked in. code-<label> is the same site with the first label prefixed.
function opencodeOrigin() {
  const host = window.location.hostname;
  const dot = host.indexOf('.');
  if (dot <= 0) return '';
  const label = host.slice(0, dot);
  if (!label || label.startsWith('code-')) return '';
  return `https://code-${label}${host.slice(dot)}`;
}

export default function OpencodeFrameClient() {
  const [returnTo, setReturnTo] = useState(null);
  const [openUrl, setOpenUrl] = useState('');

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
    setOpenUrl(opencodeOrigin());
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--background)]">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--surface-container-low)] px-3 sm:px-4">
        <button
          type="button"
          onClick={() => window.location.assign(returnTo || '/')}
          className="inline-flex min-h-9 items-center gap-2 rounded-md px-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-container-high)] hover:text-[var(--text-primary)]"
          aria-label="Back to WorkDash"
        >
          <ArrowLeft size={16} />
          <span>Back</span>
        </button>
        {openUrl && (
          <a
            href={openUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-9 items-center gap-2 rounded-md px-2 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-container-high)] hover:text-[var(--text-primary)]"
          >
            <span>Open full page</span>
            <ExternalLink size={15} />
          </a>
        )}
      </div>
      {openUrl ? (
        <iframe
          src={openUrl}
          title="OpenCode"
          className="block min-h-0 w-full flex-1 border-0 bg-white"
          allow="clipboard-read; clipboard-write"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-[var(--text-secondary)]">
          Open this dashboard from its public hostname to load OpenCode.
        </div>
      )}
    </div>
  );
}
