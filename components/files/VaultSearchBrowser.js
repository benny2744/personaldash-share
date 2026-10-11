'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Clock, Loader2, Search, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import NotePreviewDrawer from '@/components/files/NotePreviewDrawer';

const MODES = [
  {
    value: 'auto',
    label: 'Semantic',
    hint: 'Embedding search over note bodies',
  },
  { value: 'fts', label: 'Text', hint: 'Full-text + title match' },
];

const MODE_BADGE = {
  semantic: { label: 'semantic', variant: 'default' },
  fts: { label: 'full-text', variant: 'secondary' },
  local: { label: 'local index', variant: 'outline' },
  unconfigured: { label: 'local index', variant: 'outline' },
  none: null,
};

function formatWhen(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function VaultSearchBrowser() {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('auto');
  const [results, setResults] = useState([]);
  const [resultMeta, setResultMeta] = useState({
    mode: 'none',
    degraded: null,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [previewPath, setPreviewPath] = useState(null);
  const debounceRef = useRef(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setResultMeta({ mode: 'none', degraded: null });
      setLoading(false);
      setError(null);
      return undefined;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const seq = (seqRef.current += 1);
      try {
        const res = await fetch(
          `/api/vault/search?q=${encodeURIComponent(trimmed)}&mode=${mode}`,
        );
        if (!res.ok) throw new Error('Search failed');
        const data = await res.json();
        if (seq !== seqRef.current) return;
        setResults(data.results || []);
        setResultMeta({ mode: data.mode, degraded: data.degraded || null });
        setError(null);
      } catch (err) {
        if (seq === seqRef.current) setError(err.message);
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    }, 350);
    return () => clearTimeout(debounceRef.current);
  }, [query, mode]);

  const badge = MODE_BADGE[resultMeta.mode] || null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the vault — meaning, not just keywords…"
            className="pl-9"
            aria-label="Search vault notes"
          />
          {loading && (
            <Loader2
              size={15}
              className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-[var(--text-tertiary)]"
            />
          )}
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-[var(--surface-container-low)] p-1">
          {MODES.map((option) => (
            <button
              key={option.value}
              type="button"
              title={option.hint}
              onClick={() => setMode(option.value)}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-semibold transition',
                mode === option.value
                  ? 'bg-[var(--surface-card)] text-[var(--primary)] shadow-sm'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--surface-container-high)]',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {resultMeta.degraded && (
        <p className="text-xs text-[var(--text-tertiary)]">
          {resultMeta.degraded}
        </p>
      )}

      <Card className="flex h-[62vh] flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col p-2">
          {query.trim().length < 2 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-[var(--text-secondary)]">
              <Sparkles size={20} className="text-[var(--text-tertiary)]" />
              <p className="max-w-md">
                Ask for ideas, not filenames — e.g. “budget decisions for the
                school app” or “那个关于招生的讨论”.
              </p>
            </div>
          ) : loading && results.length === 0 ? (
            <div className="space-y-2 p-1">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-14 w-full" />
              ))}
            </div>
          ) : error ? (
            <p className="rounded-lg bg-[var(--error-container)]/20 p-4 text-sm text-[var(--on-error-container)]">
              {error}
            </p>
          ) : results.length === 0 ? (
            <p className="p-6 text-center text-sm text-[var(--text-secondary)]">
              No matching notes.
            </p>
          ) : (
            <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
              {results.map((result) => (
                <li key={`${result.path}-${result.slug}`}>
                  <button
                    type="button"
                    onClick={() => setPreviewPath(result.path)}
                    className="w-full rounded-lg px-3 py-2.5 text-left transition hover:bg-[var(--bg-hover)]"
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-primary)]">
                        {result.title}
                      </span>
                      {result.type && (
                        <Badge
                          variant="outline"
                          className="shrink-0 text-[10px]"
                        >
                          {result.type}
                        </Badge>
                      )}
                      {formatWhen(result.updatedAt) && (
                        <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--text-tertiary)]">
                          <Clock size={10} />
                          {formatWhen(result.updatedAt)}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-[var(--text-tertiary)]">
                      {result.path}
                    </div>
                    {result.snippet && (
                      <p className="mt-1 line-clamp-2 text-xs text-[var(--text-secondary)]">
                        {result.snippet}
                      </p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {badge && (
        <p className="text-[11px] text-[var(--text-tertiary)]">
          Served by gbrain · <span className="font-medium">{badge.label}</span>{' '}
          search
        </p>
      )}

      {previewPath && (
        <NotePreviewDrawer
          filepath={previewPath}
          onClose={() => setPreviewPath(null)}
        />
      )}
    </div>
  );
}
