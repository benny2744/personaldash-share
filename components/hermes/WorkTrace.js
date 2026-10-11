'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import ToolCard from './ToolCard';

/**
 * Compact expandable work summary for contiguous reasoning/tool activity.
 * Collapsed by default (including while running) to avoid chat spam.
 */
export default function WorkTrace({
  summary,
  reasoning = '',
  tools = [],
  running = false,
  interrupted = false,
}) {
  const hasError =
    interrupted || tools.some((tool) => tool.status === 'error');
  const [open, setOpen] = useState(hasError);
  const [reasoningOpen, setReasoningOpen] = useState(false);

  // Auto-expand when a failure/interruption appears after mount.
  useEffect(() => {
    if (hasError) setOpen(true);
  }, [hasError]);

  if (!summary && !reasoning && tools.length === 0) return null;

  const reasoningLabel = running && !tools.length
    ? 'Thinking…'
    : reasoning
      ? 'Thought'
      : '';

  return (
    <div
      className={cn(
        'w-full max-w-[min(1000px,92%)] rounded-xl border bg-[var(--surface-container-low)] text-xs shadow-sm',
        hasError
          ? 'border-[var(--error)]/35'
          : 'border-[var(--border)]',
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {running ? (
          <Loader2
            size={14}
            className="shrink-0 animate-spin text-[var(--primary)]"
          />
        ) : open ? (
          <ChevronDown size={14} className="shrink-0 text-[var(--text-muted)]" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-[var(--text-muted)]" />
        )}
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-medium',
            hasError
              ? 'text-[var(--on-error-container)]'
              : 'text-[var(--text-secondary)]',
          )}
        >
          {summary || (running ? 'Working…' : 'Work')}
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
          {open ? 'Hide' : 'Details'}
        </span>
      </button>

      {open ? (
        <div className="space-y-2 border-t border-[var(--border)]/70 px-2.5 py-2">
          {reasoning ? (
            <div className="rounded-lg border border-[var(--border)]/60 bg-[color:color-mix(in_srgb,var(--primary)_6%,transparent)]">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs font-medium text-[var(--text-secondary)]"
                onClick={() => setReasoningOpen((value) => !value)}
                aria-expanded={reasoningOpen}
              >
                {reasoningOpen ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )}
                <span>{reasoningLabel || 'Thought'}</span>
              </button>
              {reasoningOpen ? (
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap border-t border-[var(--border)]/50 px-2.5 py-2 font-mono text-[11px] text-[var(--text-secondary)]">
                  {reasoning}
                </pre>
              ) : null}
            </div>
          ) : null}

          {tools.map((tool) => (
            <ToolCard
              key={tool.tool_id}
              tool={tool}
              compact
              defaultOpen={tool.status === 'error'}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
