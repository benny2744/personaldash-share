'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  HardDrive,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getLocalStore } from '@/lib/cache/localStore';
import { getCacheStatus, pruneIfNeeded } from '@/lib/cache/manager';
import { getDiagnostics } from '@/lib/cache/diagnostics';
import {
  CACHE_SCHEMA_VERSION,
  CONFIGURED_BUDGET_BYTES,
} from '@/lib/cache/config';
import LlmTiersCard from '@/components/settings/LlmTiersCard';
import GbrainStatusCard from '@/components/settings/GbrainStatusCard';
import TerminalHostsCard from '@/components/settings/TerminalHostsCard';
import SettingsGroupsCard from '@/components/settings/SettingsGroupsCard';
import SetupAssistant from '@/components/settings/SetupAssistant';

const CATEGORY_LABELS = {
  kb: 'Knowledge base',
  dingtalk: 'DingTalk',
  agent: 'Agent chats',
  other: 'Other',
};

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10));
  return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

export default function SettingsClient() {
  const [status, setStatus] = useState(null);
  const [diag, setDiag] = useState(null);
  const [showDiag, setShowDiag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const refresh = useCallback(async () => {
    const store = getLocalStore();
    const [nextStatus, nextDiag] = await Promise.all([
      getCacheStatus(store),
      getDiagnostics(store),
    ]);
    setStatus(nextStatus);
    setDiag(nextDiag);
  }, []);

  useEffect(() => {
    refresh().catch(() => setStatus({ supported: false }));
  }, [refresh]);

  async function handlePrune() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await pruneIfNeeded(getLocalStore());
      setMessage(
        result && result.evicted > 0
          ? `Pruned ${result.evicted} item${result.evicted === 1 ? '' : 's'}, freed ${formatBytes(result.removedBytes)}.`
          : 'Cache is within budget — nothing to prune.',
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleClear() {
    if (
      !window.confirm(
        'Clear all locally cached data? Everything re-downloads from the server on next view.',
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await getLocalStore().clearAll();
      setMessage('Local cache cleared.');
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const estimate = status?.quotaBytes ?? null;
  const usagePct =
    status?.budgetBytes && status.trackedBytes
      ? Math.min(
          100,
          Math.round((status.trackedBytes / status.budgetBytes) * 100),
        )
      : 0;

  return (
    <div className="max-w-2xl space-y-6">
      <SetupAssistant />
      <SettingsGroupsCard />

      <TerminalHostsCard />

      <GbrainStatusCard />

      <LlmTiersCard />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive size={18} />
            Local storage
            {status && !status.supported ? (
              <Badge variant="destructive">unavailable</Badge>
            ) : status?.persisted ? (
              <Badge variant="status-done">persistent</Badge>
            ) : (
              <Badge variant="secondary">best-effort</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!status ? (
            <p className="text-sm text-[var(--text-muted)]">Loading…</p>
          ) : !status.supported ? (
            <p className="text-sm text-[var(--text-muted)]">
              IndexedDB is unavailable in this browser. The app works normally;
              nothing is cached locally.
            </p>
          ) : (
            <>
              <div className="space-y-1.5">
                {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                  <div
                    key={key}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-[var(--text-secondary)]">
                      {label}
                    </span>
                    <span className="font-mono text-[var(--text-primary)]">
                      {formatBytes(status.byCategory?.[key] || 0)}
                    </span>
                  </div>
                ))}
              </div>

              <div className="border-t border-[var(--border-subtle)] pt-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium text-[var(--text-primary)]">
                    Total
                  </span>
                  <span className="font-mono text-[var(--text-primary)]">
                    {formatBytes(status.trackedBytes)} /{' '}
                    {formatBytes(status.budgetBytes)}
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--surface-container-high)]">
                  <div
                    className="h-full rounded-full bg-[var(--primary)] transition-all"
                    style={{ width: `${usagePct}%` }}
                  />
                </div>
                <p className="mt-2 text-xs text-[var(--text-muted)]">
                  Target budget {formatBytes(CONFIGURED_BUDGET_BYTES)}
                  {estimate ? ` · browser quota ${formatBytes(estimate)}` : ''}
                  {' · '}effective budget is the smaller of the two minus
                  headroom.
                </p>
              </div>

              <div className="flex gap-2 pt-1">
                <Button
                  variant="secondary"
                  onClick={handlePrune}
                  disabled={busy}
                >
                  <RefreshCw size={14} className="mr-1.5" />
                  Prune now
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleClear}
                  disabled={busy}
                >
                  <Trash2 size={14} className="mr-1.5" />
                  Clear cache
                </Button>
              </div>
              {message ? (
                <p className="text-xs text-[var(--text-secondary)]">
                  {message}
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <button
          type="button"
          onClick={() => setShowDiag((v) => !v)}
          className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-[var(--text-secondary)]"
        >
          {showDiag ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          Cache diagnostics
        </button>
        {showDiag && diag ? (
          <CardContent className="space-y-3 pt-0">
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
              <span className="text-[var(--text-muted)]">Schema version</span>
              <span className="font-mono">{CACHE_SCHEMA_VERSION}</span>
              <span className="text-[var(--text-muted)]">IndexedDB</span>
              <span className="font-mono">
                {typeof indexedDB !== 'undefined' ? 'yes' : 'no'}
              </span>
              <span className="text-[var(--text-muted)]">OPFS</span>
              <span className="font-mono">
                {typeof navigator !== 'undefined' &&
                navigator.storage?.getDirectory
                  ? 'yes'
                  : 'no'}
              </span>
              <span className="text-[var(--text-muted)]">Storage estimate</span>
              <span className="font-mono">
                {typeof navigator !== 'undefined' && navigator.storage?.estimate
                  ? 'yes'
                  : 'no'}
              </span>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-[var(--text-secondary)]">
                Counters
              </p>
              <pre className="max-h-48 overflow-auto rounded-lg bg-[var(--surface-container-low)] p-3 text-[11px] text-[var(--text-secondary)]">
                {JSON.stringify(diag.counters, null, 2)}
              </pre>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-[var(--text-secondary)]">
                Last events
              </p>
              <pre className="max-h-48 overflow-auto rounded-lg bg-[var(--surface-container-low)] p-3 text-[11px] text-[var(--text-secondary)]">
                {JSON.stringify(diag.events, null, 2)}
              </pre>
            </div>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
