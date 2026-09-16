'use client';

import { usePathname } from 'next/navigation';
import { Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMobileNav } from './MobileNavContext';

const PAGE_TITLES = {
  '/chat': 'Chat',
  '/projects': 'Projects',
  '/kanban': 'Kanban',
  '/calendar': 'Calendar',
  '/meetings': 'Meetings',
};

function getPageTitle(pathname) {
  for (const [prefix, title] of Object.entries(PAGE_TITLES)) {
    if (pathname.startsWith(prefix)) return title;
  }
  return 'WorkDash';
}

export default function Header() {
  const pathname = usePathname();
  const title = getPageTitle(pathname);
  const { setOpen, collapsed, setCollapsed } = useMobileNav();

  return (
    <header className="fixed left-0 right-0 top-0 z-50 flex h-[var(--header-height)] items-center justify-between bg-[var(--surface-container-low)]/80 px-4 backdrop-blur-xl">
      <div className="flex items-center gap-3">
        {/* Hamburger — mobile only */}
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden min-h-11 min-w-11 shrink-0"
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
        >
          <Menu size={20} />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="hidden min-h-11 min-w-11 shrink-0 md:inline-flex"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <PanelLeftOpen size={20} />
          ) : (
            <PanelLeftClose size={20} />
          )}
        </Button>

        <span className="hidden text-lg font-bold tracking-tight text-[var(--text-primary)] md:inline-flex">
          WorkDash
        </span>
        <span className="text-base font-semibold text-[var(--primary)] md:text-sm">
          {title}
        </span>
      </div>
      <div className="text-xs font-medium uppercase tracking-widest text-[var(--text-muted)]">
        {new Date().toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
        })}
      </div>
    </header>
  );
}
