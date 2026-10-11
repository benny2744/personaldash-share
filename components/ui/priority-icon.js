import React from 'react';
import { ArrowDown, Minus, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

const PRIORITY_META = {
  high: {
    label: 'High',
    className: 'text-[color:#b42318]',
    Icon: TriangleAlert,
  },
  medium: {
    label: 'Medium',
    className: 'text-[color:#b45309]',
    Icon: Minus,
  },
  low: {
    label: 'Low',
    className: 'text-[var(--text-secondary)]',
    Icon: ArrowDown,
  },
};

export function PriorityIcon({ priority, className, size = 14 }) {
  const key = (priority || 'medium').toLowerCase();
  const meta = PRIORITY_META[key] || PRIORITY_META.medium;

  return <meta.Icon size={size} className={cn(meta.className, className)} aria-label={`${meta.label} priority`} />;
}

export function priorityLabel(priority) {
  const key = (priority || 'medium').toLowerCase();
  return (PRIORITY_META[key] || PRIORITY_META.medium).label;
}
