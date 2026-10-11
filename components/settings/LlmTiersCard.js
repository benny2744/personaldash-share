'use client';

import { useCallback, useEffect, useState } from 'react';
import { RotateCcw, Save, SlidersHorizontal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

const TIER_ORDER = [
  'cheap',
  'fast',
  'balanced',
  'deep',
  'advanced',
  'multi',
  'translation',
  'asr',
  'tts',
];

function sortTiers(tiers) {
  return [...tiers].sort(
    (a, b) =>
      TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) ||
      a.tier.localeCompare(b.tier),
  );
}

export default function LlmTiersCard() {
  const [rows, setRows] = useState(null); // [{tier, model, baseUrl, source}]
  const [busyTier, setBusyTier] = useState(null);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/llm-tiers', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRows(sortTiers(data.tiers || []));
    } catch (e) {
      setError(e?.message || 'failed to load tiers');
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => setError('failed to load tiers'));
  }, [refresh]);

  function updateField(tier, field, value) {
    setRows((prev) =>
      prev.map((r) => (r.tier === tier ? { ...r, [field]: value } : r)),
    );
  }

  async function handleSave(row) {
    setBusyTier(row.tier);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch('/api/llm-tiers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier: row.tier,
          model: row.model?.trim(),
          baseUrl: row.baseUrl?.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setMessage(`Saved ${row.tier} — applies to this app now; syncs to the global registry within ~5 min.`);
      await refresh();
    } catch (e) {
      setError(e?.message || 'save failed');
    } finally {
      setBusyTier(null);
    }
  }

  async function handleReset(row) {
    setBusyTier(row.tier);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/llm-tiers?tier=${encodeURIComponent(row.tier)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMessage(`Reset ${row.tier} to the global registry value.`);
      await refresh();
    } catch (e) {
      setError(e?.message || 'reset failed');
    } finally {
      setBusyTier(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SlidersHorizontal size={18} />
          LLM tiers
          {rows ? (
            <Badge variant="secondary">
              {rows.filter((r) => r.source === 'override').length} overridden
            </Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-[var(--text-muted)]">
          Endpoint + model per tier. Save applies to this app immediately and
          syncs to the global registry within ~5 min (other apps pick it up on
          restart; history in vps-infra git). Reset restores this app to the
          registry value. Opencode-engine flows (formatter/linker) follow the
          registry, not overrides.
        </p>
        {!rows && !error ? (
          <p className="text-sm text-[var(--text-muted)]">Loading…</p>
        ) : null}
        {error ? (
          <p className="text-sm text-[var(--status-error, #ef4444)]">{error}</p>
        ) : null}
        {rows
          ? rows.map((row) => (
              <div
                key={row.tier}
                className="space-y-2 rounded-xl border border-[var(--border-subtle)] p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm font-medium text-[var(--text-primary)]">
                    {row.tier}
                  </span>
                  {row.source === 'override' ? (
                    <Badge variant="status-done">override</Badge>
                  ) : (
                    <Badge variant="secondary">registry</Badge>
                  )}
                </div>
                <div className="space-y-2">
                  <Input
                    value={row.baseUrl ?? ''}
                    onChange={(e) => updateField(row.tier, 'baseUrl', e.target.value)}
                    placeholder="https://endpoint/v1"
                    className="font-mono text-xs"
                    aria-label={`${row.tier} endpoint`}
                  />
                  <Input
                    value={row.model ?? ''}
                    onChange={(e) => updateField(row.tier, 'model', e.target.value)}
                    placeholder="model-name"
                    className="font-mono text-xs"
                    aria-label={`${row.tier} model`}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => handleSave(row)}
                    disabled={busyTier === row.tier}
                  >
                    <Save size={14} className="mr-1.5" />
                    Save
                  </Button>
                  {row.source === 'override' ? (
                    <Button
                      variant="ghost"
                      onClick={() => handleReset(row)}
                      disabled={busyTier === row.tier}
                    >
                      <RotateCcw size={14} className="mr-1.5" />
                      Reset
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          : null}
        {message ? <p className="text-xs text-[var(--text-secondary)]">{message}</p> : null}
      </CardContent>
    </Card>
  );
}
