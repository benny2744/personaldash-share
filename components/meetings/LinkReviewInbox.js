'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Inbox, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

const TYPE_DIR = {
  person: 'people',
  project: 'projects',
  area: 'areas',
};

const TYPE_LABEL = {
  person: 'Person',
  project: 'Project',
  area: 'Area',
  fuzzy: 'Near-match',
};

function typeLabel(suggestedType) {
  if (suggestedType?.startsWith('profile_update:')) return 'Profile update';
  return TYPE_LABEL[suggestedType] || suggestedType;
}

function dateLabel(value) {
  if (!value) return '';
  return new Date(value).toLocaleDateString();
}

export default function LinkReviewInbox({ open, onClose, onPendingCount }) {
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [entityCache, setEntityCache] = useState({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/link-suggestions?status=pending');
      if (res.ok) {
        const data = await res.json();
        setSuggestions(data.suggestions || []);
        onPendingCount?.((data.suggestions || []).length);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [onPendingCount]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const row of suggestions) {
      const key = row.filepath;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    return [...map.entries()];
  }, [suggestions]);

  const loadEntities = useCallback(
    async (type) => {
      const dir = TYPE_DIR[type];
      if (!dir || entityCache[type]) return entityCache[type] || [];
      try {
        const res = await fetch(
          `/api/vault/files?path=${encodeURIComponent(dir)}`,
        );
        if (res.ok) {
          const files = await res.json();
          const names = (Array.isArray(files) ? files : [])
            .map((f) => (typeof f === 'string' ? f : f?.name || f?.title))
            .filter(Boolean)
            .map((n) => n.replace(/\.md$/i, ''));
          setEntityCache((cache) => ({ ...cache, [type]: names }));
          return names;
        }
      } catch {
        /* ignore */
      }
      return [];
    },
    [entityCache],
  );

  const act = useCallback(
    async (id, action, extra = {}) => {
      setBusyId(id);
      try {
        const res = await fetch(`/api/link-suggestions/${id}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, ...extra }),
        });
        if (res.ok) {
          await refresh();
        } else {
          const data = await res.json().catch(() => ({}));
          console.error('[link-review] action failed', data);
        }
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Inbox size={15} />
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              Link Review
            </h2>
            <Badge variant="secondary">{suggestions.length} pending</Badge>
          </div>
          <Button
            variant="ghost"
            className="min-h-11 px-3 text-xs"
            onClick={onClose}
            aria-label="Close Link Review"
          >
            <X size={13} />
          </Button>
        </div>

        {loading && suggestions.length === 0 ? (
          <p className="empty-state">Loading…</p>
        ) : suggestions.length === 0 ? (
          <p className="empty-state">
            No unresolved mentions. You&apos;re all caught up.
          </p>
        ) : (
          <div className="space-y-4">
            {grouped.map(([filepath, rows]) => (
              <section key={filepath} className="space-y-2">
                <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
                  <span className="truncate font-semibold">
                    {rows[0].meetingTitle}
                    {rows[0].meetingType ? ` · ${rows[0].meetingType}` : ''}
                  </span>
                  <span>{dateLabel(rows[0].meetingDate)}</span>
                </div>
                <div className="grid gap-2">
                  {rows.map((row) => (
                    <SuggestionRow
                      key={row.id}
                      row={row}
                      busy={busyId === row.id}
                      entityNames={entityCache}
                      onLoadEntities={loadEntities}
                      onAct={act}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SuggestionRow({ row, busy, entityNames, onLoadEntities, onAct }) {
  const [mode, setMode] = useState(null); // null | 'map'
  const [target, setTarget] = useState(row.suggestedExistingNote || '');
  const isProfileUpdate = row.suggestedType?.startsWith('profile_update:');
  const type = row.suggestedType === 'fuzzy' ? 'person' : row.suggestedType;

  useEffect(() => {
    if (mode === 'map') onLoadEntities(type);
  }, [mode, onLoadEntities, type]);

  const options = entityNames[type] || [];

  if (isProfileUpdate) {
    return (
      <div className="rounded-lg border border-[color:color-mix(in_srgb,var(--outline)_15%,transparent)] bg-[var(--surface-container-low)] p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-[var(--text-primary)]">
                {row.suggestedExistingNote || row.mention}
              </span>
              <Badge variant="outline">{typeLabel(row.suggestedType)}</Badge>
            </div>
            {row.evidence && (
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                {row.evidence}
              </p>
            )}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            variant="default"
            className="h-8 px-3 text-xs"
            disabled={busy}
            onClick={() => onAct(row.id, 'apply')}
          >
            Apply to note
          </Button>
          <Button
            variant="ghost"
            className="h-8 px-3 text-xs text-[var(--text-muted)]"
            disabled={busy}
            onClick={() => onAct(row.id, 'dismiss')}
          >
            Dismiss
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[color:color-mix(in_srgb,var(--outline)_15%,transparent)] bg-[var(--surface-container-low)] p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-[var(--text-primary)]">
              {row.mention}
            </span>
            <Badge variant="outline">{typeLabel(row.suggestedType)}</Badge>
          </div>
          {row.evidence && (
            <p className="mt-1 text-xs text-[var(--text-secondary)]">
              {row.evidence}
            </p>
          )}
        </div>
      </div>

      {mode === 'map' ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input
            list={`entities-${row.id}`}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="Search existing note…"
            className="h-8 text-xs"
          />
          <datalist id={`entities-${row.id}`}>
            {options.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <Button
            variant="default"
            className="h-8 px-3 text-xs"
            disabled={busy || !target.trim()}
            onClick={() =>
              onAct(row.id, 'map', { targetNote: target.trim(), type })
            }
          >
            Map
          </Button>
          <Button
            variant="ghost"
            className="h-8 px-3 text-xs"
            disabled={busy}
            onClick={() => setMode(null)}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {row.suggestedType !== 'fuzzy' && (
            <Button
              variant="default"
              className="h-8 px-3 text-xs"
              disabled={busy}
              onClick={() => onAct(row.id, 'create', { type })}
            >
              Create note
            </Button>
          )}
          <Button
            variant="outline"
            className="h-8 px-3 text-xs"
            disabled={busy}
            onClick={() => setMode('map')}
          >
            Map to existing
          </Button>
          <Button
            variant="ghost"
            className="h-8 px-3 text-xs text-[var(--text-muted)]"
            disabled={busy}
            onClick={() => onAct(row.id, 'dismiss')}
          >
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}
