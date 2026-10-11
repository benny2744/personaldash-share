import React from 'react';
import { cn } from '@/lib/utils';

const variants = {
  default:
    'bg-gradient-to-br from-[var(--primary)] to-[var(--primary-container)] text-white shadow-[var(--shadow-sm)] inner-glow hover:opacity-90',
  secondary: 'bg-[var(--surface-container-low)] text-[var(--text-primary)] hover:bg-[var(--surface-container-high)]',
  ghost: 'text-[var(--text-secondary)] hover:bg-[var(--surface-container-high)] hover:text-[var(--text-primary)]',
  outline:
    'border border-[color:color-mix(in_srgb,var(--outline)_15%,transparent)] text-[var(--text-primary)] hover:bg-[var(--surface-container-high)]',
  destructive: 'bg-[var(--error)] text-white hover:opacity-90',
};

const sizes = {
  default: 'h-9 px-4 py-2 text-sm',
  sm: 'h-8 px-3 text-xs',
  lg: 'h-10 px-6 text-sm',
  icon: 'h-9 w-9',
};

export function Button({
  className,
  variant = 'default',
  size = 'default',
  type = 'button',
  ...props
}) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg font-medium transition-all',
        'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]',
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    />
  );
}
