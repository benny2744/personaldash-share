'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw, Save, Settings2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

/**
 * Generic registry-driven settings cards. Renders every group from
 * GET /api/settings; per-row Save/Reset like LlmTiersCard. Secret rows are
 * write-only: the server never returns the stored value, only isSet.
 *
 * Unsaved edits live in a separate `drafts` map, so saving/resetting one row
 * (and the refresh it triggers) never discards drafts typed into other rows.
 * Writes are serialized per key, so autosave toggles can never land
 * out of order.
 */
export default function SettingsGroupsCard() {
  const [groups, setGroups] = useState(null); // [{name, rows:[...]}]
  const [drafts, setDrafts] = useState({}); // key -> unsaved value
  const [busyKeys, setBusyKeys] = useState(() => new Set());
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  // Per-key write chains: each new write waits for the previous one on the
  // same key, so two rapid toggles apply in order.
  const writeChains = useRef({});

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/settings', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const byGroup = new Map();
      for (const row of data.settings || []) {
        if (!byGroup.has(row.group)) byGroup.set(row.group, []);
        byGroup.get(row.group).push(row);
      }
      setGroups(
        (data.groups || [...byGroup.keys()]).map((name) => ({
          name,
          rows: byGroup.get(name) || [],
        })),
      );
    } catch (e) {
      setError(e?.message || 'failed to load settings');
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => setError('failed to load settings'));
    window.addEventListener('settings-updated', refresh);
    return () => window.removeEventListener('settings-updated', refresh);
  }, [refresh]);

  function setDraft(key, value) {
    setDrafts((prev) => ({ ...prev, [key]: value }));
  }

  function clearDraft(key) {
    setDrafts((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function updateRow(key, patch) {
    setDraft(key, patch.value);
  }

  function markBusy(key, busy) {
    setBusyKeys((prev) => {
      const next = new Set(prev);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  /** Run one write for a key, serialized after any pending write on it. */
  function enqueueWrite(key, operation) {
    const previous = writeChains.current[key] || Promise.resolve();
    markBusy(key, true);
    writeChains.current[key] = previous
      .then(operation)
      .catch(() => {}) // operation reports its own error state
      .finally(() => markBusy(key, false));
  }

  async function save(row, explicitValue) {
    setMessage(null);
    setError(null);
    const value =
      explicitValue !== undefined
        ? explicitValue
        : (drafts[row.key] ?? row.value);
    if (row.type === 'secret' && !value) {
      setMessage(`${row.label}: nothing to save.`);
      return;
    }
    await enqueueWrite(row.key, async () => {
      try {
        let payload = value;
        if (row.type === 'csv' && typeof payload === 'string') {
          payload = payload
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean);
        }
        const res = await fetch(
          `/api/settings/${encodeURIComponent(row.key)}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: payload }),
          },
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        clearDraft(row.key);
        setMessage(`Saved ${row.label}.`);
        await refresh();
      } catch (e) {
        setError(e?.message || 'save failed');
      }
    });
  }

  async function reset(row) {
    setMessage(null);
    setError(null);
    await enqueueWrite(row.key, async () => {
      try {
        const res = await fetch(
          `/api/settings/${encodeURIComponent(row.key)}`,
          {
            method: 'DELETE',
          },
        );
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data?.error || `HTTP ${res.status}`);
        }
        clearDraft(row.key);
        setMessage(`Reset ${row.label} to default.`);
        await refresh();
      } catch (e) {
        setError(e?.message || 'reset failed');
      }
    });
  }

  const renderScopeBadge = (scope) =>
    scope === 'boot' ? (
      <Badge variant="secondary" title="Applies after the app restarts">
        restart
      </Badge>
    ) : null;

  function renderInput(row) {
    const value = row.key in drafts ? drafts[row.key] : row.value;
    switch (row.type) {
      case 'boolean':
        return (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(value)}
              onChange={(event) => {
                updateRow(row.key, { value: event.target.checked });
                save(row, event.target.checked);
              }}
              disabled={busyKeys.has(row.key)}
              className="size-4 accent-[var(--primary)]"
            />
            {value ? 'On' : 'Off'}
          </label>
        );
      case 'select':
        return (
          <Select
            value={String(value ?? '')}
            onChange={(event) => {
              updateRow(row.key, { value: event.target.value });
              save(row, event.target.value);
            }}
            disabled={busyKeys.has(row.key)}
            className="w-56"
          >
            {(row.options || []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        );
      case 'number':
        return (
          <Input
            type="number"
            value={value ?? ''}
            min={row.min}
            max={row.max}
            onChange={(event) =>
              updateRow(row.key, {
                value:
                  event.target.value === ''
                    ? ''
                    : Number.parseFloat(event.target.value),
              })
            }
            className="w-40"
          />
        );
      case 'csv':
        return (
          <Input
            type="text"
            value={Array.isArray(value) ? value.join(', ') : (value ?? '')}
            placeholder={row.placeholder}
            onChange={(event) =>
              updateRow(row.key, { value: event.target.value })
            }
            className="w-72"
          />
        );
      case 'secret':
        return (
          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={value ?? ''}
              placeholder={
                row.isSet ? 'Configured — type to replace' : row.placeholder
              }
              onChange={(event) =>
                updateRow(row.key, { value: event.target.value })
              }
              className="w-72"
            />
            {row.isSet ? <Badge variant="status-done">set</Badge> : null}
          </div>
        );
      case 'textarea':
        return (
          <textarea
            value={value ?? ''}
            placeholder={row.placeholder}
            onChange={(event) =>
              updateRow(row.key, { value: event.target.value })
            }
            className="min-h-20 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-container-low)] p-2 text-sm"
          />
        );
      default:
        return (
          <Input
            type="text"
            value={value ?? ''}
            placeholder={row.placeholder}
            onChange={(event) =>
              updateRow(row.key, { value: event.target.value })
            }
            className="w-72"
          />
        );
    }
  }

  return (
    <div className="space-y-6">
      {error ? <p className="text-sm text-[var(--error)]">{error}</p> : null}
      {!groups ? (
        <Card>
          <CardContent className="py-6 text-sm text-[var(--text-muted)]">
            Loading settings…
          </CardContent>
        </Card>
      ) : (
        groups.map((group) => (
          <Card key={group.name}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings2 size={18} />
                {group.name}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {group.rows.map((row) => (
                <div
                  key={row.key}
                  className="flex flex-col gap-1.5 border-b border-[var(--border-subtle)] pb-3 last:border-b-0 last:pb-0"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--text-primary)]">
                      {row.label}
                    </span>
                    {renderScopeBadge(row.scope)}
                    {row.key in drafts ? (
                      <Badge
                        variant="secondary"
                        title="Unsaved edit — Save keeps it, Reset discards it"
                      >
                        unsaved
                      </Badge>
                    ) : null}
                    <span className="font-mono text-[10px] text-[var(--text-muted)]">
                      {row.key}
                    </span>
                  </div>
                  <p className="text-xs text-[var(--text-muted)]">
                    {row.description}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    {renderInput(row)}
                    {row.type !== 'boolean' && row.type !== 'select' ? (
                      <Button
                        size="sm"
                        onClick={() => save(row)}
                        disabled={busyKeys.has(row.key)}
                      >
                        <Save size={14} className="mr-1" />
                        Save
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => reset(row)}
                      disabled={busyKeys.has(row.key)}
                      title="Remove the override (falls back to env/default)"
                    >
                      <RotateCcw size={14} className="mr-1" />
                      Reset
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ))
      )}
      {message ? (
        <p className="text-xs text-[var(--text-secondary)]">{message}</p>
      ) : null}
    </div>
  );
}
