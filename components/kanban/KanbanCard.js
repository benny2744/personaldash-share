import React, { useMemo, useRef } from 'react';
import { Archive, CalendarDays, Check, FolderOpen } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const PRIORITY_META = {
  high: { label: 'High', variant: 'priority-high' },
  medium: { label: 'Medium', variant: 'priority-medium' },
  low: { label: 'Low', variant: 'priority-low' },
};

function normalizeStatus(value) {
  return (value || '').toLowerCase().replace(/\s+/g, '');
}

export default function KanbanCard({
  task,
  onDragStart,
  onOpen,
  onMove,
  statusOptions = [],
}) {
  const priority = (task.priority || 'medium').toLowerCase();
  const status = (task.status || '').toLowerCase();
  const meta = PRIORITY_META[priority] || PRIORITY_META.medium;
  const normalizedStatus = normalizeStatus(task.status || 'todo');
  const hasMoveOptions =
    typeof onMove === 'function' && statusOptions.length > 0;
  const isProposed = status === 'proposed';
  const hasProposedQuickActions = isProposed && typeof onMove === 'function';
  const moveValue = useMemo(
    () =>
      statusOptions.some((option) => option.value === normalizedStatus)
        ? normalizedStatus
        : statusOptions[0]?.value || normalizedStatus,
    [normalizedStatus, statusOptions],
  );

  const isOverdue =
    task.whenDate &&
    new Date(task.whenDate) < new Date() &&
    !['done', 'archived'].includes(status);

  const dateStr = task.whenDate
    ? new Date(task.whenDate).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      })
    : null;

  // Distinguish a drag gesture from a click so opening the drawer
  // does not interfere with DnD.
  const dragStartPos = useRef(null);
  const didDrag = useRef(false);

  const handleMouseDown = (e) => {
    dragStartPos.current = { x: e.clientX, y: e.clientY };
    didDrag.current = false;
  };

  const handleDragStart = (e) => {
    didDrag.current = true;
    onDragStart(e);
  };

  const handleClick = (e) => {
    // If the user moved more than 4px treat it as a drag, not a click
    if (didDrag.current) {
      didDrag.current = false;
      return;
    }
    if (dragStartPos.current) {
      const dx = Math.abs(e.clientX - dragStartPos.current.x);
      const dy = Math.abs(e.clientY - dragStartPos.current.y);
      if (dx > 4 || dy > 4) return;
    }
    e.stopPropagation();
    onOpen?.(task);
  };

  const stopQuickActionPropagation = (event) => {
    event.stopPropagation();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      draggable="true"
      onMouseDown={handleMouseDown}
      onDragStart={handleDragStart}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen?.(task);
        }
      }}
      className={cn(
        'group relative cursor-grab select-none rounded-xl bg-[var(--kanban-card-bg)] p-6',
        'border-b-2 border-transparent',
        'shadow-[var(--ambient-shadow)] transition-all duration-150',
        'hover:-translate-y-px hover:bg-[var(--surface-card-hover)] hover:shadow-[var(--ambient-shadow-hover)] hover:border-b-[var(--accent)]/20',
        'active:cursor-grabbing active:opacity-60',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
      )}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <Badge variant={isOverdue ? 'destructive' : meta.variant} pill>
          {isOverdue ? 'Overdue' : meta.label}
        </Badge>
        {hasProposedQuickActions && (
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              draggable={false}
              aria-label="Move to Todo"
              title="Move to Todo"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-[color:color-mix(in_srgb,var(--tertiary-fixed)_30%,transparent)] text-[var(--on-tertiary-fixed)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              onMouseDown={stopQuickActionPropagation}
              onDragStart={stopQuickActionPropagation}
              onClick={(event) => {
                event.stopPropagation();
                onMove(task.id, 'todo');
              }}
            >
              <Check size={14} />
            </button>
            <button
              type="button"
              draggable={false}
              aria-label="Archive proposed task"
              title="Archive proposed task"
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-[color:color-mix(in_srgb,var(--error-container)_20%,transparent)] px-2 text-xs font-semibold text-[var(--on-error-container)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              onMouseDown={stopQuickActionPropagation}
              onDragStart={stopQuickActionPropagation}
              onClick={(event) => {
                event.stopPropagation();
                onMove(task.id, 'archived');
              }}
            >
              <Archive size={13} />
              Archive
            </button>
          </div>
        )}
      </div>

      <h3 className="mb-2 text-base font-semibold leading-tight text-[var(--text-primary)] transition-colors duration-100 group-hover:text-[var(--accent)]">
        {task.title}
      </h3>

      {(task.context || task.area) && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {task.context && <Badge variant="secondary">{task.context}</Badge>}
          {task.area && <Badge variant="outline">{task.area}</Badge>}
        </div>
      )}

      <p className="mb-4 text-sm leading-relaxed text-[var(--text-secondary)] line-clamp-2">
        {task.description || task.project || 'No project'}
      </p>

      <div className="flex items-center justify-between mt-auto">
        <span className="flex min-w-0 items-center gap-1.5 text-[var(--text-secondary)]">
          <FolderOpen size={14} className="shrink-0" />
          <span className="truncate text-[11px] font-medium">
            {task.project || 'No project'}
          </span>
        </span>

        {dateStr ? (
          <span
            className={cn(
              'flex shrink-0 items-center gap-1.5 text-[var(--text-secondary)]',
              isOverdue && 'font-semibold text-[var(--error)]',
            )}
          >
            <CalendarDays size={14} className="shrink-0" />
            <span className="text-[11px] font-medium">{dateStr}</span>
          </span>
        ) : (
          <span className="shrink-0 text-[11px] italic text-[var(--text-muted)]">
            No date
          </span>
        )}
      </div>

      {hasMoveOptions && (
        <label className="mt-3 flex items-center gap-2 md:hidden">
          <span className="text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">
            Move
          </span>
          <select
            value={moveValue}
            className="h-8 min-w-0 flex-1 rounded-md border border-[color:color-mix(in_srgb,var(--outline)_12%,transparent)] bg-[var(--surface-container-low)] px-2 text-xs text-[var(--text-primary)]"
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => {
              event.stopPropagation();
              onMove(task.id, event.target.value);
            }}
          >
            {statusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
