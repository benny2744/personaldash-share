'use client';

import { usePathname } from 'next/navigation';
import { useSidebarCollapsed } from './MobileNavContext';

export default function AppShell({ children }) {
  const { collapsed } = useSidebarCollapsed();
  const pathname = usePathname();
  const isChat = pathname === '/chat' || pathname?.startsWith('/chat/');
  const isHermesFrame = pathname === '/hermes-frame';

  return (
    <div
      className="app-shell"
      data-layout="app-shell"
      data-sidebar-collapsed={collapsed ? 'true' : 'false'}
      data-route={isChat ? 'chat' : isHermesFrame ? 'hermes-frame' : 'default'}
    >
      {children}
    </div>
  );
}
