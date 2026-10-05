'use client';

import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { buildSessionStats } from '@/lib/hermes/sessionStats';

const compactFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const costFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 4,
});

function fmtNum(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return '0';
  return compactFormatter.format(n);
}

function fmtCost(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return costFormatter.format(n);
}

function contextColor(percent) {
  if (percent >= 80) return 'var(--error)';
  if (percent >= 60) return 'var(--status-todo)';
  return 'var(--status-active)';
}

function StatRow({ label, value, title }) {
  return (
    <div className="flex items-baseline justify-between gap-2" title={title}>
      <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
        {label}
      </span>
      <span className="truncate font-mono text-[11px] text-[var(--text-secondary)]">
        {value}
      </span>
    </div>
  );
}

function StatGroup({ label, children }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function ContextBar({ stats }) {
  const hasContext = stats.contextMax > 0;
  const percent = Math.max(
    0,
    Math.min(100, stats.contextPercent || 0),
  );
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-[var(--text-muted)]">Context</span>
        <span className="font-mono text-[11px] text-[var(--text-secondary)]">
          {hasContext
            ? `${fmtNum(stats.contextUsed)} / ${fmtNum(stats.contextMax)}`
            : fmtNum(stats.contextUsed)}
          <span className="ml-2 text-[var(--text-muted)]">{percent}%</span>
          {stats.contextEstimated ? (
            <span className="ml-1 text-[10px] text-[var(--text-muted)]">est</span>
          ) : null}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--surface-container-high)]">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${hasContext ? percent : 0}%`,
            backgroundColor: hasContext ? contextColor(percent) : 'transparent',
          }}
        />
      </div>
    </div>
  );
}

/**
 * Session statistics for the chat workspace panel: context occupancy, token
 * totals, model performance, and (cold) lifetime cost/counts. Data comes from
 * the gateway's `session.usage` snapshots merged with the REST session row.
 */
export default function SessionStatsPanel({
  open,
  onToggle,
  usage,
  baseline,
  cold,
  running,
  className,
}) {
  const stats = buildSessionStats(usage, cold, baseline);
  const hasData = Boolean(
    usage || cold || stats.contextUsed > 0 || stats.total > 0,
  );
  const headerSummary = stats.contextMax > 0
    ? `${stats.contextPercent}% context`
    : stats.total > 0
      ? `${fmtNum(stats.total)} tok`
      : 'No usage yet';

  return (
    <section
      className={cn(
        'flex min-h-0 flex-col border-t border-[var(--border)] bg-[var(--surface-container-low)]',
        open ? 'min-h-[150px] flex-[1] basis-0' : 'shrink-0',
        className,
      )}
    >
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Session stats
          </span>
          <span className="truncate text-xs text-[var(--text-secondary)]">
            {headerSummary}
          </span>
          {running ? (
            <span
              className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--status-active)]"
              aria-label="turn running"
            />
          ) : null}
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          onClick={onToggle}
          aria-label={open ? 'Collapse session stats' : 'Expand session stats'}
        >
          {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </Button>
      </div>

      {open ? (
        <div className="min-h-0 flex-1 border-t border-[var(--border)] px-3 py-2">
          <ScrollArea className="h-full min-h-0">
            {!hasData ? (
              <p className="text-xs text-[var(--text-muted)]">
                No usage recorded yet. Send a message to start tracking
                tokens and context.
              </p>
            ) : (
              <div className="space-y-3">
                <ContextBar stats={stats} />

                <StatGroup label="Tokens">
                  <StatRow label="Total" value={fmtNum(stats.total)} />
                  <StatRow label="Input" value={fmtNum(stats.input)} />
                  <StatRow label="Output" value={fmtNum(stats.output)} />
                  {stats.reasoning > 0 ? (
                    <StatRow label="Reasoning" value={fmtNum(stats.reasoning)} />
                  ) : null}
                  {stats.cacheRead > 0 ? (
                    <StatRow label="Cached read" value={fmtNum(stats.cacheRead)} />
                  ) : null}
                  {stats.cacheWrite > 0 ? (
                    <StatRow label="Cached write" value={fmtNum(stats.cacheWrite)} />
                  ) : null}
                  {stats.cacheHitPct != null ? (
                    <StatRow
                      label="Cache hit"
                      value={`${Math.round(stats.cacheHitPct)}%`}
                    />
                  ) : null}
                  <StatRow label="API calls" value={fmtNum(stats.calls)} />
                </StatGroup>

                <StatGroup label="Performance">
                  <StatRow
                    label="Model"
                    value={stats.model || '—'}
                    title={stats.model}
                  />
                  {stats.avgLatencyS != null ? (
                    <StatRow
                      label="Avg latency"
                      value={`${stats.avgLatencyS.toFixed(1)}s`}
                    />
                  ) : null}
                  {stats.avgTps != null ? (
                    <StatRow label="Avg speed" value={`${stats.avgTps} tok/s`} />
                  ) : null}
                  {stats.compressions > 0 ? (
                    <StatRow
                      label="Compressions"
                      value={fmtNum(stats.compressions)}
                    />
                  ) : null}
                  {stats.activeSubagents > 0 ? (
                    <StatRow
                      label="Active subagents"
                      value={fmtNum(stats.activeSubagents)}
                    />
                  ) : null}
                </StatGroup>

                <StatGroup label="Session totals">
                  {stats.messageCount != null ? (
                    <StatRow label="Messages" value={fmtNum(stats.messageCount)} />
                  ) : null}
                  {stats.toolCallCount != null ? (
                    <StatRow
                      label="Tool calls"
                      value={fmtNum(stats.toolCallCount)}
                    />
                  ) : null}
                  {stats.estimatedCost != null ? (
                    <StatRow
                      label="Est. cost"
                      value={fmtCost(stats.estimatedCost) || '$0'}
                    />
                  ) : null}
                  {stats.actualCost != null && stats.actualCost > 0 ? (
                    <StatRow
                      label="Actual cost"
                      value={fmtCost(stats.actualCost)}
                    />
                  ) : null}
                </StatGroup>
              </div>
            )}
          </ScrollArea>
        </div>
      ) : null}
    </section>
  );
}
