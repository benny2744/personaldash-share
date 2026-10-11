'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  formatToolStepLabel,
  summarizeToolResult,
} from '@/lib/hermes/transcriptGrouper';

const RESULT_PREVIEW_LIMIT = 1200;

function statusVariant(status) {
  if (status === 'error') return 'destructive';
  if (status === 'complete') return 'status-done';
  return 'status-doing';
}

function formatArgs(tool) {
  if (tool.args_text) return String(tool.args_text);
  if (typeof tool.args === 'string') return tool.args;
  if (tool.args != null) {
    try {
      return JSON.stringify(tool.args, null, 2);
    } catch {
      return String(tool.args);
    }
  }
  return '';
}

/**
 * Compact tool step used inside WorkTrace.
 * Full ToolCard details remain behind a nested disclosure.
 */
export default function ToolCard({
  tool,
  defaultOpen = false,
  compact = true,
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [showAllResult, setShowAllResult] = useState(false);

  if (!tool) return null;

  const label = formatToolStepLabel(tool);
  const preview = summarizeToolResult(tool);
  const argsText = formatArgs(tool);
  const resultText = String(tool.error || tool.summary || tool.result || '');
  const truncated =
    !showAllResult && resultText.length > RESULT_PREVIEW_LIMIT
      ? `${resultText.slice(0, RESULT_PREVIEW_LIMIT)}…`
      : resultText;

  if (!compact) {
    return (
      <details
        className="rounded-xl border border-[var(--border)] bg-[var(--surface-container-low)] px-3 py-2 text-xs"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-[var(--text-primary)]">
          <Badge variant={statusVariant(tool.status)} pill>
            {tool.status || 'running'}
          </Badge>
          <span className="truncate font-mono">{tool.name}</span>
          {tool.duration_s != null ? (
            <span className="ml-auto text-[var(--text-muted)]">
              {Number(tool.duration_s).toFixed(1)}s
            </span>
          ) : null}
        </summary>
        {argsText ? (
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-[var(--text-secondary)]">
            {argsText}
          </pre>
        ) : null}
        {resultText ? (
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-[var(--text-primary)]">
            {truncated}
          </pre>
        ) : null}
      </details>
    );
  }

  return (
    <div
      className={cn(
        'rounded-lg border border-[var(--border)]/70 bg-[var(--surface-card)]/60',
        tool.status === 'error' && 'border-[var(--error)]/40',
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <Badge variant={statusVariant(tool.status)} pill>
          {tool.status === 'running'
            ? 'running'
            : tool.status === 'error'
              ? 'error'
              : 'done'}
        </Badge>
        <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]">
          {label}
        </span>
        {tool.duration_s != null ? (
          <span className="shrink-0 text-[var(--text-muted)]">
            {Number(tool.duration_s).toFixed(1)}s
          </span>
        ) : null}
      </button>

      {!open && preview ? (
        <div className="border-t border-[var(--border)]/50 px-2.5 py-1.5 text-[11px] text-[var(--text-secondary)]">
          {preview}
        </div>
      ) : null}

      {open ? (
        <div className="space-y-2 border-t border-[var(--border)]/50 px-2.5 py-2">
          {argsText ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Input
              </div>
              <pre className="max-h-36 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-[var(--text-secondary)]">
                {argsText}
              </pre>
            </div>
          ) : null}
          {resultText ? (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Output
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-[var(--text-primary)]">
                {truncated}
              </pre>
              {resultText.length > RESULT_PREVIEW_LIMIT && !showAllResult ? (
                <button
                  type="button"
                  className="mt-1 text-[11px] text-[var(--primary)] hover:underline"
                  onClick={() => setShowAllResult(true)}
                >
                  Show all ({resultText.length.toLocaleString()} characters)
                </button>
              ) : null}
            </div>
          ) : (
            <div className="text-[11px] text-[var(--text-muted)]">
              {tool.status === 'running'
                ? 'Waiting on tool result…'
                : 'No output'}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
