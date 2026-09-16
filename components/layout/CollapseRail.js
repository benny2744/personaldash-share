'use client';

import { cn } from '@/lib/utils';

export default function CollapseRail({
  label,
  icon: Icon,
  onExpand,
  side = 'left',
  className,
}) {
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label={`Expand ${label}`}
      title={`Expand ${label}`}
      className={cn(
        'flex h-full min-h-40 w-full flex-col items-center justify-start gap-3 rounded-xl bg-[var(--surface-card)] px-2 py-4 text-[var(--text-secondary)] shadow-[var(--ambient-shadow)] transition-all',
        'hover:bg-[var(--surface-card-hover)] hover:text-[var(--accent)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]',
        side === 'right' && 'border-r-2 border-transparent hover:border-r-[var(--accent)]/20',
        side === 'left' && 'border-l-2 border-transparent hover:border-l-[var(--accent)]/20',
        className
      )}
    >
      {Icon && <Icon size={18} className="shrink-0" />}
      <span className="text-xs font-semibold uppercase tracking-widest [writing-mode:vertical-rl]">
        {label}
      </span>
    </button>
  );
}
