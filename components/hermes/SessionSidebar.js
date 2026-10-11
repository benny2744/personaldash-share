'use client';

import { useMemo } from 'react';
import { MoreHorizontal, Pin, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import ProfilePicker from './ProfilePicker';
import { orderSessionsByPin } from '@/lib/hermes/sessionOrder';
import { cn } from '@/lib/utils';

function sessionTitle(session) {
  return (
    session.title ||
    session.preview ||
    session.id ||
    'Untitled session'
  );
}

function formatWhen(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export default function SessionSidebar({
  sessions,
  loading,
  error,
  activeId,
  query,
  onQueryChange,
  onSearch,
  onNew,
  onSelect,
  onRename,
  onDelete,
  pinnedIds,
  onTogglePin,
  searching,
  profiles,
  activeProfile,
  onSelectProfile,
  className,
  style,
}) {
  // Pins only affect the default recent view; search results stay ranked by
  // the server.
  const orderedSessions = useMemo(
    () => (searching ? sessions : orderSessionsByPin(sessions, pinnedIds)),
    [searching, sessions, pinnedIds],
  );
  return (
    <aside
      style={style}
      className={cn(
        'flex h-full min-w-0 flex-col border-r border-[var(--border)] bg-[var(--bg-secondary)]',
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-[var(--border)] p-3">
        <ProfilePicker
          profiles={profiles}
          activeProfile={activeProfile}
          onSelect={onSelectProfile}
        />
        <Button
          size="icon"
          className="shrink-0"
          onClick={onNew}
          aria-label="New chat"
          title="New chat"
        >
          <Plus size={18} />
        </Button>
      </div>
      <div className="flex gap-2 border-b border-[var(--border)] p-3">
        <div className="relative flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
          />
          <Input
            value={query}
            onChange={(event) => onQueryChange?.(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSearch?.(query);
            }}
            placeholder="Search sessions"
            className="pl-8"
          />
        </div>
        <Button size="sm" variant="secondary" onClick={() => onSearch?.(query)}>
          Go
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <ul className="space-y-1 p-2">
          {loading ? (
            <li className="px-3 py-2 text-xs text-[var(--text-muted)]">
              Loading sessions…
            </li>
          ) : null}
          {error ? (
            <li className="px-3 py-2 text-xs text-[var(--error)]">{error}</li>
          ) : null}
          {!loading && !error && orderedSessions.length === 0 ? (
            <li className="px-3 py-2 text-xs text-[var(--text-muted)]">
              No sessions yet
            </li>
          ) : null}
          {orderedSessions.map((session) => {
            const id = session.id || session.session_id;
            const active = activeId && (activeId === id || activeId === session.stored_session_id);
            const pinned = !searching && pinnedIds?.includes(id);
            return (
              <li key={id}>
                <div
                  className={cn(
                    'group flex min-h-[3.25rem] items-start gap-1 rounded-lg px-2 py-2.5 transition',
                    active
                      ? 'bg-[var(--surface-container-high)] text-[var(--accent)]'
                      : 'hover:bg-[var(--surface-container-high)]',
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => onSelect?.(id)}
                  >
                    <div className="line-clamp-2 break-words text-sm font-medium leading-snug">
                      {sessionTitle(session)}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                      <span>{formatWhen(session.last_active || session.started_at)}</span>
                      {pinned ? (
                        <Pin size={11} className="shrink-0 fill-current text-[var(--accent)]" />
                      ) : null}
                      {session.is_active ? (
                        <Badge variant="status-doing" className="text-[10px]">
                          live
                        </Badge>
                      ) : null}
                    </div>
                  </button>
                  <div className="flex shrink-0 self-start opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                    <Button
                      size="icon"
                      variant="ghost"
                      className={cn('h-8 w-8', pinned && 'text-[var(--accent)]')}
                      title={pinned ? 'Unpin' : 'Pin'}
                      onClick={() => onTogglePin?.(id)}
                    >
                      <Pin size={14} className={pinned ? 'fill-current' : undefined} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      title="Rename"
                      onClick={() => {
                        const next = window.prompt(
                          'Rename session',
                          sessionTitle(session),
                        );
                        if (next != null && next.trim()) onRename?.(id, next.trim());
                      }}
                    >
                      <MoreHorizontal size={14} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 text-[var(--error)]"
                      title="Delete"
                      onClick={() => {
                        if (window.confirm('Delete this session?')) {
                          onDelete?.(id);
                        }
                      }}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </aside>
  );
}
