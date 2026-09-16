'use client';

import { useEffect, useLayoutEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDingTalkChat } from '@/hooks/useDingTalkChat';
import DingTalkComposer from './DingTalkComposer';
import DingTalkSidebar from './DingTalkSidebar';
import DingTalkThread from './DingTalkThread';

function useMediaQuery(query) {
  const [matches, setMatches] = useState(false);
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export default function DingTalkClient({ sidebarWidth, initialActiveId }) {
  const dingtalk = useDingTalkChat();
  const isMobile = useMediaQuery('(max-width: 900px)');
  const showSidebar = !isMobile || !dingtalk.activeId;

  useEffect(() => {
    if (!initialActiveId || dingtalk.activeId === initialActiveId) return;
    if (dingtalk.conversationsLoading && !dingtalk.conversations.length) return;
    dingtalk.selectConversation(initialActiveId);
  }, [initialActiveId, dingtalk]);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {showSidebar ? (
        <DingTalkSidebar
          className="shrink-0"
          style={{ width: isMobile ? '100%' : sidebarWidth }}
          conversations={dingtalk.conversations}
          loading={dingtalk.conversationsLoading}
          error={dingtalk.conversationsError}
          activeId={dingtalk.activeId}
          query={dingtalk.query}
          onQueryChange={dingtalk.setQuery}
          onSearch={dingtalk.searchConversations}
          onSelect={dingtalk.selectConversation}
        />
      ) : null}
      {!showSidebar || !isMobile ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {isMobile ? (
            <div className="flex items-center gap-2 border-b border-[var(--border)] px-2 py-1.5">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => dingtalk.selectConversation(null)}
              >
                <ArrowLeft size={16} />
                Back
              </Button>
            </div>
          ) : null}
          <DingTalkThread
            messages={dingtalk.messages}
            loading={dingtalk.messagesLoading}
            olderLoading={dingtalk.olderLoading}
            hasMoreOlder={dingtalk.hasMoreOlder}
            onLoadOlder={dingtalk.loadOlderMessages}
            self={dingtalk.self}
          />
          <DingTalkComposer
            value={dingtalk.draft}
            onChange={dingtalk.setDraft}
            onSend={dingtalk.sendMessage}
            sending={dingtalk.sending}
            disabled={!dingtalk.activeId}
            error={dingtalk.sendError}
          />
        </div>
      ) : null}
    </div>
  );
}
