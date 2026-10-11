import React from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }) {
  const interactive = props['data-interactive'] === true || props['data-interactive'] === 'true';

  return (
    <div
      className={cn(
        'min-w-0 overflow-hidden rounded-xl bg-[var(--surface-card)] text-[var(--text-primary)] shadow-[var(--ambient-shadow)]',
        'border-b-2 border-transparent',
        interactive &&
          'transition-all hover:bg-[var(--surface-card-hover)] hover:shadow-[var(--ambient-shadow-hover)] hover:border-b-[var(--accent)]/20',
        className
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }) {
  return <div className={cn('p-6 pb-4', className)} {...props} />;
}

export function CardTitle({ className, ...props }) {
  return <h3 className={cn('text-[var(--title-sm)] font-semibold tracking-tight', className)} {...props} />;
}

export function CardDescription({ className, ...props }) {
  return <p className={cn('text-[var(--body-md)] text-[var(--text-secondary)]', className)} {...props} />;
}

export function CardContent({ className, ...props }) {
  return <div className={cn('p-6 pt-0', className)} {...props} />;
}

export function CardFooter({ className, ...props }) {
  return <div className={cn('flex items-center p-6 pt-0', className)} {...props} />;
}

export function CardAction({ className, ...props }) {
  return <div className={cn('ml-auto flex items-center gap-2', className)} {...props} />;
}
