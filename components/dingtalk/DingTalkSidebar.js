'use client';

import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

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

export function conversationTitle(conversation) {
  if (conversation.title) return conversation.title;
  if (conversation.lastMessageSender && conversation.type === 'single') {
    return conversation.lastMessageSender;
  }
  return conversation.type === 'group' ? 'Group chat' : 'Direct message';
}

export default function DingTalkSidebar({
  conversations,
  loading,
  error,
  activeId,
  query,
  onQueryChange,
  onSearch,
  onSelect,
  className,
  style,
}) {
  return (
    <aside
      style={style}
      className={cn(
        'flex h-full min-w-0 flex-col border-r border-[var(--border)] bg-[var(--bg-secondary)]',
        className,
      )}
    >
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
            placeholder="Search conversations"
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
              Loading conversations…
            </li>
          ) : null}
          {error ? (
            <li className="px-3 py-2 text-xs text-[var(--error)]">{error}</li>
          ) : null}
          {!loading && !error && conversations.length === 0 ? (
            <li className="px-3 py-2 text-xs text-[var(--text-muted)]">
              No conversations yet
            </li>
          ) : null}
          {conversations.map((conversation) => {
            const id = conversation.openConversationId;
            const active = activeId === id;
            return (
              <li key={id}>
                <button
                  type="button"
                  className={cn(
                    'flex min-h-[3.25rem] w-full min-w-0 items-start rounded-lg px-2 py-2.5 text-left transition',
                    active
                      ? 'bg-[var(--surface-container-high)] text-[var(--accent)]'
                      : 'hover:bg-[var(--surface-container-high)]',
                  )}
                  onClick={() => onSelect?.(id)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="line-clamp-1 break-words text-sm font-medium leading-snug">
                        {conversationTitle(conversation)}
                      </span>
                      <Badge
                        variant="secondary"
                        className="shrink-0 text-[10px]"
                      >
                        {conversation.type === 'group' ? 'group' : 'dm'}
                      </Badge>
                    </div>
                    {conversation.lastMessagePreview ? (
                      <div className="mt-1 line-clamp-1 text-[11px] text-[var(--text-muted)]">
                        {conversation.lastMessageSender
                          ? `${conversation.lastMessageSender}: `
                          : ''}
                        {conversation.lastMessagePreview}
                      </div>
                    ) : null}
                    <div className="mt-1 text-[11px] text-[var(--text-muted)]">
                      {formatWhen(conversation.lastMessageAt)}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </aside>
  );
}
