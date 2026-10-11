'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, ListFilter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

function formatSyncAge(iso) {
  if (!iso) return 'never synced';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return new Date(iso).toLocaleString();
}

function SourcesFilter({ sources, hiddenSourceIds, onToggle }) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handleClick = (event) => {
      if (panelRef.current && !panelRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const hiddenCount = sources.filter((s) => hiddenSourceIds.has(s.id)).length;
  const label =
    hiddenCount > 0
      ? `Calendars · ${sources.length - hiddenCount}/${sources.length}`
      : 'Calendars';

  return (
    <div className="relative">
      <Button
        variant={open ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => setOpen((v) => !v)}
        className="h-8"
        disabled={sources.length === 0}
        title="Show or hide DingTalk calendars"
      >
        <ListFilter size={14} />
        <span className="ml-1.5">{label}</span>
      </Button>
      {open && (
        <div
          ref={panelRef}
          className="absolute left-0 top-full z-50 mt-2 w-64 rounded-xl border border-[var(--border)] bg-[var(--surface-card)] p-2 shadow-[var(--shadow-md)]"
        >
          {sources.length === 0 ? (
            <p className="px-2 py-1 text-xs text-[var(--text-secondary)]">
              No calendars found.
            </p>
          ) : (
            <div className="space-y-1">
              {sources.map((source) => {
                const checked = !hiddenSourceIds.has(source.id);
                return (
                  <label
                    key={source.id}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition hover:bg-[var(--surface-container-low)]"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggle(source.id)}
                      className="h-4 w-4 rounded border-[var(--border)] bg-[var(--surface-container-low)] text-[var(--accent)] focus:ring-[var(--accent)]"
                    />
                    <span className="truncate">
                      {source.displayName || source.url}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CalendarToolbar({
  title,
  view,
  onViewChange,
  onPrev,
  onNext,
  onToday,
  showExternal,
  onToggleExternal,
  caldavSources = [],
  hiddenSourceIds = new Set(),
  onToggleSource,
  syncStatus,
  refreshing,
  onRefresh,
}) {
  const configured = Boolean(syncStatus?.configured);
  const error = syncStatus?.lastSyncError;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1">
          <Button variant="secondary" size="icon" className="shrink-0" onClick={onPrev} aria-label="Previous">
            <ChevronLeft size={16} />
          </Button>
          <h2 className="min-w-0 flex-1 text-center text-base font-semibold leading-snug sm:flex-none sm:text-xl sm:min-w-[10rem] lg:min-w-[14rem]">
            {title}
          </h2>
          <Button variant="secondary" size="icon" className="shrink-0" onClick={onNext} aria-label="Next">
            <ChevronRight size={16} />
          </Button>
          <Button variant="ghost" onClick={onToday} className="shrink-0 px-2 text-sm">
            Today
          </Button>
        </div>
        <Tabs>
          <TabsList>
            <TabsTrigger
              active={view === 'month'}
              onClick={() => onViewChange('month')}
            >
              Month
            </TabsTrigger>
            <TabsTrigger
              active={view === 'week'}
              onClick={() => onViewChange('week')}
            >
              Week
            </TabsTrigger>
            <TabsTrigger
              active={view === 'day'}
              onClick={() => onViewChange('day')}
            >
              Day
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
        <Button
          variant={showExternal ? 'secondary' : 'ghost'}
          size="sm"
          onClick={onToggleExternal}
          className="h-8"
          disabled={!configured && !(syncStatus?.objectCount > 0)}
        >
          DingTalk
          <Badge
            variant={showExternal ? 'default' : 'outline'}
            className="ml-1.5"
          >
            {showExternal ? 'On' : 'Off'}
          </Badge>
        </Button>
        <SourcesFilter
          sources={caldavSources}
          hiddenSourceIds={hiddenSourceIds}
          onToggle={onToggleSource}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={!configured || refreshing}
          className="h-8"
          title="Refresh DingTalk calendar"
        >
          <RefreshCw size={14} className={cn(refreshing && 'animate-spin')} />
          <span className="ml-1.5">Refresh</span>
        </Button>
        <span>
          {configured
            ? `Last sync ${formatSyncAge(syncStatus?.lastSyncAt)}`
            : 'DingTalk sync not configured'}
        </span>
        {error ? (
          <span className="text-[var(--error)]" title={error}>
            Sync error
          </span>
        ) : null}
      </div>
    </div>
  );
}
