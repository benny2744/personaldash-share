'use client';

import { useHermesChat } from '@/hooks/useHermesChat';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import ChatWorkspace from './ChatWorkspace';

export default function HermesChatClient() {
  const chat = useHermesChat();
  const { isOnline } = useNetworkStatus();
  return <ChatWorkspace chat={chat} isOnline={isOnline} />;
}
