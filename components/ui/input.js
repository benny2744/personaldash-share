import React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef(function Input({ className, type = 'text', ...props }, ref) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-9 w-full rounded-lg border border-[color:color-mix(in_srgb,var(--outline)_10%,transparent)] bg-[var(--surface-container-low)] px-3 py-1.5 text-sm text-[var(--text-primary)] outline-none transition-all',
        'placeholder:text-[var(--text-muted)]',
        'focus:bg-[var(--surface-container-lowest)] focus:border-b-2 focus:border-b-[var(--primary)] focus:ring-0',
        className
      )}
      {...props}
    />
  );
});
