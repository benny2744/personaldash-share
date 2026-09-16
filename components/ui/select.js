import React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Select = React.forwardRef(function Select({ className, wrapperClassName, children, ...props }, ref) {
  return (
    <div className={cn('relative', wrapperClassName ?? 'w-full')}>
      <select
        ref={ref}
        className={cn(
          'flex h-9 w-full appearance-none rounded-lg border border-[color:color-mix(in_srgb,var(--outline)_10%,transparent)] bg-[var(--surface-container-low)] px-3 py-1.5 pr-8 text-sm text-[var(--text-primary)] outline-none transition-all',
          'focus:bg-[var(--surface-container-lowest)] focus:border-b-2 focus:border-b-[var(--primary)] focus:ring-0',
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
        aria-hidden="true"
      />
    </div>
  );
});
