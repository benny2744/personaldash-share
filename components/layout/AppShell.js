'use client';

import { usePathname } from 'next/navigation';
import { useSidebarCollapsed } from './MobileNavContext';

export default function AppShell({ children }) {
  const { collapsed } = useSidebarCollapsed();
  const pathname = usePathname();
  const isChat = pathname === '/chat' || pathname?.startsWith('/chat/');
  const isHermesFrame = pathname === '/hermes-frame';
  const isOpencodeFrame = pathname === '/opencode-frame';
  const isTerminal = pathname === '/terminal';

  return (
    <div
      className="app-shell"
      data-layout="app-shell"
      data-sidebar-collapsed={collapsed ? 'true' : 'false'}
      data-route={
        isChat
          ? 'chat'
          : isHermesFrame
            ? 'hermes-frame'
            : isOpencodeFrame
              ? 'opencode-frame'
              : isTerminal
                ? 'terminal'
                : 'default'
      }
    >
      {children}
    </div>
  );
}
