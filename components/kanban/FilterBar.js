'use client';

import React, { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export default function FilterBar({
  searchValue,
  onSearchChange,
  searchPlaceholder,
  onClear,
  activeFilterCount = 0,
  resultCount = 0,
  totalCount = 0,
  children,
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const resultLabel = useMemo(() => `${resultCount}/${totalCount}`, [resultCount, totalCount]);
  const mobileFilterLabel = activeFilterCount > 0 ? `Filters (${activeFilterCount})` : 'Filters';

  return (
    <div className="rounded-lg bg-[var(--surface-container-low)] p-2">
      <div className="hidden flex-wrap items-center gap-2 md:flex">
        <span className="px-1 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
          Filters
        </span>
        <Input
          value={searchValue}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          className="h-8 w-full sm:w-52 shrink-0 text-xs"
        />
        {children}
        <Button
          variant="ghost"
          className="ml-auto h-8 px-3 text-xs text-[var(--text-secondary)]"
          onClick={onClear}
        >
          Clear
        </Button>
        <span className="text-[0.7rem] text-[var(--text-muted)]">{resultLabel}</span>
      </div>

      <div className="space-y-2 md:hidden">
        <Input
          value={searchValue}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          className="h-8 w-full text-xs"
        />
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)] hover:bg-[var(--surface-container-high)]"
            onClick={() => setMobileOpen((previous) => !previous)}
            aria-expanded={mobileOpen}
          >
            {mobileFilterLabel}
            <ChevronDown
              size={14}
              className={cn('transition-transform', mobileOpen && 'rotate-180')}
            />
          </button>
          <span className="text-[0.7rem] text-[var(--text-muted)]">{resultLabel}</span>
        </div>
        {mobileOpen && (
          <div className="space-y-2">
            {React.Children.map(children, (child) => (
              <div className="w-full">{child}</div>
            ))}
            <Button
              variant="ghost"
              className="h-8 w-full justify-center px-3 text-xs text-[var(--text-secondary)]"
              onClick={onClear}
            >
              Clear filters
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
