import React from 'react';
import KanbanCard from './KanbanCard';
import { cn } from '@/lib/utils';

const STATUS_META = {
  proposed: { label: 'Proposed', color: 'var(--status-todo)' },
  todo: { label: 'To Do', color: 'var(--status-todo)' },
  doing: { label: 'Doing', color: 'var(--status-doing)' },
  done: { label: 'Done', color: 'var(--status-done)' },
};

export default function KanbanColumn({
  status,
  tasks,
  onDragStart,
  onDrop,
  onDragOver,
  onCardOpen,
  statusMeta = STATUS_META,
  CardComponent = KanbanCard,
  singleColumn = false,
  headerRight = null,
  cardProps = {},
}) {
  const meta = statusMeta[status] || { label: status, color: 'var(--text-secondary)' };

  return (
    <div
      className={cn(
        'flex flex-col gap-6 bg-[var(--kanban-col-bg)]',
        singleColumn ? 'w-full min-w-0 flex-1' : 'w-80 flex-none'
      )}
    >
      <div className="flex items-center justify-between px-2 pt-4">
        <div className="flex items-center gap-3">
          <h3 className="text-xl font-semibold text-[var(--text-primary)]">{meta.label}</h3>
          <span
            className="min-w-[1.5rem] rounded-full bg-[var(--surface-container-highest)] px-2 py-0.5 text-center text-xs font-bold uppercase tracking-widest tabular-nums"
            style={{ backgroundColor: `color-mix(in srgb, ${meta.color} 18%, transparent)`, color: meta.color }}
          >
            {tasks.length}
          </span>
        </div>
        {headerRight}
      </div>

      <div
        className="flex flex-1 flex-col gap-4 overflow-y-auto pr-2"
        onDrop={onDrop}
        onDragOver={onDragOver}
      >
        {tasks.length === 0 && (
          <div className="rounded-xl bg-[var(--surface-container-high)] px-3 py-4 text-center text-sm font-medium text-[var(--text-muted)]">
            Drop a task here
          </div>
        )}
        {tasks.map((task) => (
          <CardComponent
            key={task.id}
            task={task}
            onDragStart={(e) => onDragStart(e, task.id)}
            onOpen={onCardOpen}
            {...cardProps}
          />
        ))}
      </div>
    </div>
  );
}
