import React, { useMemo, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Lightbulb, Target, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';

const STATUS_VARIANT = {
  backburner: 'status-backburner',
  exploring: 'status-exploring',
  inprogress: 'status-doing',
  done: 'status-done',
  abandoned: 'status-abandoned',
};

export default function IdeaCard({ idea, onDragStart, onOpen, onMove, statusOptions = [] }) {
  const hasMoveOptions = typeof onMove === 'function' && statusOptions.length > 0;
  const normalizedStatus = (idea.status || 'backburner').toLowerCase().replace(/\s+/g, '');
  const moveValue = useMemo(
    () => (statusOptions.some((option) => option.value === normalizedStatus) ? normalizedStatus : statusOptions[0]?.value || normalizedStatus),
    [normalizedStatus, statusOptions]
  );
  const statusKey = (idea.status || 'backburner').toLowerCase().replace(/\s+/g, '');
  const statusVariant = STATUS_VARIANT[statusKey] || 'secondary';
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
    onOpen?.(idea);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      draggable="true"
      onMouseDown={handleMouseDown}
      onDragStart={handleDragStart}
      onClick={handleClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen?.(idea); } }}
      className={cn(
        'group relative cursor-grab select-none rounded-xl bg-[var(--kanban-card-bg)] p-6',
        'border-b-2 border-transparent',
        'shadow-[var(--ambient-shadow)] transition-all duration-150',
        'hover:-translate-y-px hover:bg-[var(--surface-card-hover)] hover:shadow-[var(--ambient-shadow-hover)] hover:border-b-[var(--accent)]/20',
        'active:cursor-grabbing active:opacity-60',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]'
      )}
    >
      <div className="mb-3">
        <Badge variant={statusVariant} dot>{idea.status || 'Backburner'}</Badge>
      </div>

      <h3 className="mb-3 text-base font-semibold leading-tight text-[var(--text-primary)] transition-colors duration-100 group-hover:text-[var(--accent)]">
        {idea.title}
      </h3>

      <div className="space-y-2 text-xs text-[var(--text-secondary)]">
        <div className="flex items-center gap-1.5">
          <Lightbulb size={13} className="shrink-0" />
          <span className="truncate">{idea.domain || 'No domain'}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <TrendingUp size={13} className="shrink-0" />
          <span className="truncate">Impact: {idea.impact || 'Unspecified'}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Target size={13} className="shrink-0" />
          <span className="truncate">Effort: {idea.effort || 'Unspecified'}</span>
        </div>
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
              onMove(idea.id, event.target.value);
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
