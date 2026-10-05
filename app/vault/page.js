'use client';

import React, { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';

const MilkdownEditor = dynamic(
  () => import('@/components/vault/MilkdownEditor'),
  { ssr: false },
);

function VaultViewer() {
  const searchParams = useSearchParams();
  const path = searchParams.get('path');
  const [state, setState] = useState({ loading: true, error: null, content: '' });

  useEffect(() => {
    if (!path) {
      setState({ loading: false, error: 'No note selected.', content: '' });
      return;
    }
    let cancelled = false;
    setState({ loading: true, error: null, content: '' });
    fetch(`/api/vault/note?path=${encodeURIComponent(path)}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Failed to load note (${res.status})`);
        }
        return res.json();
      })
      .then((data) => {
        if (!cancelled) {
          setState({ loading: false, error: null, content: data.content || '' });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState({ loading: false, error: error.message, content: '' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div className="flex h-full flex-col gap-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)] sm:text-2xl">
          {path ? path.split('/').pop().replace(/\.md$/i, '') : 'Vault'}
        </h1>
        {path ? (
          <p className="mt-1 text-xs text-[var(--text-secondary)] sm:text-sm">{path}</p>
        ) : null}
      </div>
      {state.loading ? (
        <p className="text-sm text-[var(--text-secondary)]">Loading…</p>
      ) : state.error ? (
        <p className="text-sm text-[var(--error)]">{state.error}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <MilkdownEditor content={state.content} readOnly />
        </div>
      )}
    </div>
  );
}

export default function VaultPage() {
  return (
    <Suspense>
      <VaultViewer />
    </Suspense>
  );
}
