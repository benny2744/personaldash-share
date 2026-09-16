import React from 'react';
import { cn } from '@/lib/utils';

const variants = {
  default: 'bg-[var(--accent-muted)] text-[var(--accent)]',
  secondary: 'bg-[var(--surface-container-high)] text-[var(--text-secondary)]',
  outline:
    'border border-[color:color-mix(in_srgb,var(--outline)_15%,transparent)] text-[var(--text-secondary)]',
  destructive: 'bg-[color:color-mix(in_srgb,var(--error-container)_20%,transparent)] text-[var(--on-error-container)]',
  dot: 'bg-[var(--surface-container-high)] text-[var(--text-secondary)]',
  'status-todo': 'bg-[color:color-mix(in_srgb,var(--status-todo)_18%,transparent)] text-[var(--status-todo)]',
  'status-doing': 'bg-[color:color-mix(in_srgb,var(--primary)_18%,transparent)] text-[var(--primary)]',
  'status-done': 'bg-[color:color-mix(in_srgb,var(--tertiary-fixed)_30%,transparent)] text-[var(--on-tertiary-fixed)]',
  'status-backburner': 'bg-[var(--surface-container-high)] text-[var(--text-secondary)]',
  'status-exploring': 'bg-[color:color-mix(in_srgb,var(--primary)_18%,transparent)] text-[var(--primary)]',
  'status-active': 'bg-[color:color-mix(in_srgb,var(--status-active)_18%,transparent)] text-[var(--status-active)]',
  'status-onhold': 'bg-[var(--surface-container-high)] text-[var(--text-secondary)]',
  'status-complete': 'bg-[color:color-mix(in_srgb,var(--tertiary-fixed)_30%,transparent)] text-[var(--on-tertiary-fixed)]',
  'priority-high': 'bg-[color:color-mix(in_srgb,var(--error-container)_20%,transparent)] text-[var(--on-error-container)]',
  'priority-medium': 'bg-[color:color-mix(in_srgb,var(--priority-medium)_18%,transparent)] text-[var(--priority-medium)]',
  'priority-low': 'bg-[var(--surface-container-high)] text-[var(--text-secondary)]',
};

export function Badge({ className, variant = 'default', dot = false, pill = false, children, ...props }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full',
        pill
          ? 'px-2.5 py-1 text-[0.6875rem] font-bold uppercase tracking-wider'
          : 'px-2 py-0.5 text-xs font-semibold',
        variants[variant],
        className
      )}
      {...props}
    >
      {dot && <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}
