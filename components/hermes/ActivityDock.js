'use client';

import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

function levelVariant(level) {
  if (level === 'error') return 'destructive';
  if (level === 'warning') return 'priority-medium';
  return 'secondary';
}

const DIAGNOSTIC_KINDS = new Set([
  'connection',
  'approval',
  'clarify',
  'background',
  'error',
  'prompt',
  'status',
]);

/**
 * Diagnostics/recovery dock.
 * Tool lifecycle lives in the inline WorkTrace — keep this quiet.
 */
export default function ActivityDock({
  open,
  height,
  onToggle,
  activity,
  statusText,
  className,
}) {
  const recentActivity = [...activity]
    .filter((item) => DIAGNOSTIC_KINDS.has(item.kind) && item.kind !== 'tool')
    .slice(-30)
    .reverse();

  return (
    <section
      className={cn(
        'border-t border-[var(--border)] bg-[var(--surface-container-low)]',
        className,
      )}
      style={open ? { height } : undefined}
    >
      <div className="flex h-10 items-center justify-between gap-2 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Diagnostics
          </span>
          {statusText ? (
            <span className="truncate text-xs text-[var(--text-secondary)]">
              {statusText}
            </span>
          ) : (
            <span className="truncate text-xs text-[var(--text-muted)]">
              Connection, approvals, and recovery events
            </span>
          )}
        </div>
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onToggle}>
          {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </Button>
      </div>

      {open ? (
        <div className="h-[calc(100%-2.5rem)] border-t border-[var(--border)] px-3 py-2">
          <ScrollArea className="h-full min-h-0">
            <div className="space-y-2">
              {recentActivity.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">
                  No diagnostic events yet. Tool activity appears inline above
                  the answer.
                </p>
              ) : (
                recentActivity.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-lg bg-[var(--surface-card)] px-2 py-1.5 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant={levelVariant(item.level)}>{item.kind}</Badge>
                      <span className="text-[var(--text-muted)]">
                        {item.at
                          ? new Date(item.at).toLocaleTimeString()
                          : ''}
                      </span>
                    </div>
                    <div className="mt-1 text-[var(--text-secondary)]">{item.text}</div>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </div>
      ) : null}
    </section>
  );
}
