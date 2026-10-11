'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

function formatDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  const minutes = Math.round(s / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US');
}

const STATUS_TONE = {
  healthy: 'var(--status-active)',
  degraded: 'var(--status-todo)',
  unhealthy: 'var(--error)',
  unreachable: 'var(--error)',
};

const INTEGRITY_TONE = {
  clean: 'var(--status-active)',
  warn: 'var(--status-todo)',
  fail: 'var(--error)',
};

function Field({ label, value, tone, mono }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--border-color)] py-1.5 last:border-b-0">
      <span className="text-xs text-[var(--text-secondary)]">{label}</span>
      <span
        className="text-xs font-semibold text-[var(--text-primary)]"
        style={tone ? { color: tone } : undefined}
      >
        {value}
        {mono ? '' : ''}
      </span>
    </div>
  );
}

export default function GbrainStatusCard() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/gbrain/status', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setHealth(data.health || null);
      if (!data.health) throw new Error('health composite unavailable');
    } catch (err) {
      setError(err?.message || 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const integrityLabel =
    health?.canonicalIntegrity === 'clean'
      ? '✓ Clean'
      : health?.canonicalIntegrity === 'warn'
        ? '⚠ Stale check'
        : '✗ Compromised';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">GBrain</CardTitle>
            <CardDescription>
              Retrieval index health for ~/brain — canonical authority is Personal Dash / Hermes; gbrain is read-only
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant={health?.status === 'healthy' ? 'status-active' : 'destructive'}
              dot
            >
              {loading ? '…' : health?.status || 'unknown'}
            </Badge>
            <Button variant="ghost" size="icon" onClick={load} disabled={loading} aria-label="Refresh GBrain status">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {error && (
          <p className="text-sm" style={{ color: 'var(--error)' }}>
            Failed to load GBrain status: {error}
          </p>
        )}

        {health && (
          <>
            <div>
              <Field label="Status" value={health.status} tone={STATUS_TONE[health.status]} />
              <Field label="Canonical authority" value={health.canonicalAuthority} />
              <Field
                label="Managed gbrain writes"
                value="## Takes fence only (review on Knowledge page)"
              />
              <Field
                label="Canonical integrity"
                value={integrityLabel}
                tone={INTEGRITY_TONE[health.canonicalIntegrity]}
              />
              <Field label="write_through" value={health.writeThrough} tone={health.writeThrough === 'false' ? undefined : 'var(--error)'} />
              <Field
                label="Working-tree sync"
                value={health.workingTreeSync === 'true' ? 'enabled' : health.workingTreeSync}
                tone={health.workingTreeSync === 'true' ? undefined : 'var(--error)'}
              />
              <Field
                label="Dream"
                value={health.dream.profile === 'safe' ? '✓ safe profile' : health.dream.profile}
                tone={health.dream.profile === 'safe' ? undefined : 'var(--error)'}
              />
              <Field label="Last dream" value={health.dream.lastRun} />
              <Field label="Dream duration" value={formatDuration(health.dream.durationS)} />
              <Field
                label="Jobs pending"
                value={String(health.jobs.pending)}
                tone={health.jobs.pending > 10 ? 'var(--status-todo)' : undefined}
              />
              <Field
                label="Jobs failed"
                value={String(health.jobs.failed)}
                tone={health.jobs.failed > 0 ? 'var(--error)' : undefined}
              />
              <Field label="Embeddings" value={health.embeddings} tone={health.embeddings === 'current' ? undefined : 'var(--status-todo)'} />
              <Field
                label="Unexpected vault writes"
                value={health.unexpectedVaultWrites === null ? 'unknown' : String(health.unexpectedVaultWrites)}
                tone={health.unexpectedVaultWrites ? 'var(--error)' : 'var(--status-active)'}
              />
            </div>

            {health.integrityReasons.length > 0 && (
              <div className="rounded-lg bg-[var(--bg-tertiary)] p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                  Integrity findings
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-[var(--text-primary)]">
                  {health.integrityReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                Invariant check
              </p>
              <div className="mt-1">
                <Field
                  label="Last check"
                  value={health.invariant.lastCheck
                    ? `${health.invariant.lastCheck.replace('T', ' ').slice(0, 16)}${health.invariant.stale ? ' (stale)' : ''}`
                    : 'never'}
                  tone={health.invariant.stale ? 'var(--status-todo)' : undefined}
                />
                <Field label="Files verified" value={formatTokens(health.invariant.fileCount)} />
                <Field label="Sync failures" value={String(health.syncFailures)} tone={health.syncFailures > 0 ? 'var(--error)' : undefined} />
                <Field
                  label="Vault sync queue"
                  value={health.syncQueue ? `${health.syncQueue.pending} pending${health.syncQueue.isPaused ? ' (paused)' : ''}` : '—'}
                />
                <Field
                  label="Vault indexer"
                  value={health.indexer ? `${health.indexer.running ? 'watching' : 'stopped'}${health.indexer.initialScanDone ? '' : ', scanning'}` : '—'}
                />
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                propose_takes watch (LLM cost/latency)
              </p>
              <div className="mt-1">
                <Field label="Duration" value={formatDuration(health.proposeTakes.durationS)} />
                <Field
                  label="Window"
                  value={health.proposeTakes.windowStart
                    ? `${health.proposeTakes.windowStart.replace('T', ' ').slice(11, 16)} → ${health.proposeTakes.windowEnd?.replace('T', ' ').slice(11, 16) || '?'}`
                    : 'no run recorded'}
                />
                {health.proposeTakes.llm.map((call) => (
                  <Field
                    key={call.model}
                    label={`${call.model} (${call.calls} calls)`}
                    value={`${formatTokens(call.input_tokens)} in / ${formatTokens(call.output_tokens)} out · cost —`}
                  />
                ))}
                {health.proposeTakes.llm.length === 0 && <Field label="LLM calls" value="no calls in last run" />}
                <Field
                  label="Proposals (pending/rejected)"
                  value={`${health.proposeTakes.proposalsPending} / ${health.proposeTakes.proposalsRejected}`}
                />
                {health.proposeTakes.proposalsPending > 0 && (
                  <p className="mt-1 text-[11px]">
                    <a href="/knowledge#take-proposals" className="text-[var(--primary)] hover:underline">
                      Review {health.proposeTakes.proposalsPending} take proposal{health.proposeTakes.proposalsPending === 1 ? '' : 's'} →
                    </a>
                  </p>
                )}
              </div>
              <p className="mt-2 text-[11px] text-[var(--text-muted)]">
                Watch over coming weeks: as the brain grows this phase becomes the dominant dream cost. Cost shows
                &ldquo;&mdash;&rdquo; until litellm models get canonical pricing (chat_usage_log.cost_usd is null).
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
