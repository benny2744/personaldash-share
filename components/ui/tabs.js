import React from 'react';
import { cn } from '@/lib/utils';

export function Tabs({ className, children }) {
  return <div className={cn('w-full', className)}>{children}</div>;
}

export function TabsList({ className, ...props }) {
  return (
    <div
      className={cn(
        'inline-flex h-9 items-center rounded-lg bg-[var(--surface-container-low)] p-1 text-[var(--text-secondary)]',
        className
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, active = false, ...props }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center rounded-md px-3 py-1.5 text-xs font-semibold transition',
        active ? 'bg-[var(--surface-card)] text-[var(--primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-container-high)]',
        className
      )}
      {...props}
    />
  );
}
