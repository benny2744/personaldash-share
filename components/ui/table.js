import React from 'react';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Table({ className, ...props }) {
  return <table className={cn('w-full caption-bottom text-sm', className)} {...props} />;
}

export function TableHeader({ className, ...props }) {
  return <thead className={cn('[&_tr]:bg-[var(--surface-container-low)]', className)} {...props} />;
}

export function TableBody({ className, ...props }) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

export function TableRow({ className, ...props }) {
  return (
    <tr
      className={cn(
        'transition-colors hover:bg-[var(--surface-container-high)]',
        className
      )}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }) {
  return (
    <th
      className={cn(
        'h-12 px-4 text-left align-middle text-[var(--label-sm)] font-semibold uppercase tracking-[0.05em] text-[var(--text-secondary)]',
        className
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }) {
  return <td className={cn('px-4 py-3 align-middle', className)} {...props} />;
}

export function SortableTableHead({ className, children, direction = null, onClick, ...props }) {
  const Icon = direction === 'asc' ? ChevronUp : direction === 'desc' ? ChevronDown : ChevronsUpDown;

  return (
    <TableHead className={className} {...props}>
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1.5 text-inherit hover:text-[var(--text-primary)]"
      >
        <span>{children}</span>
        <Icon size={13} className="opacity-80" />
      </button>
    </TableHead>
  );
}
