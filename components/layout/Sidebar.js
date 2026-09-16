'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import {
  Calendar,
  Columns3,
  FolderKanban,
  MessageSquare,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  X,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useMobileNav } from './MobileNavContext';

const NAV_ITEMS = [
  { href: '/chat', label: 'Chat', icon: MessagesSquare },
  { href: '/projects', label: 'Projects', icon: FolderKanban },
  { href: '/calendar', label: 'Calendar', icon: Calendar },
  { href: '/kanban', label: 'Kanban', icon: Columns3 },
  { href: '/meetings', label: 'Meetings', icon: MessageSquare },
];

export default function Sidebar() {
  const pathname = usePathname();
  const {
    open: mobileOpen,
    setOpen: setMobileOpen,
    collapsed,
    setCollapsed,
  } = useMobileNav();

  // Close drawer on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname, setMobileOpen]);

  // Lock body scroll when mobile drawer is open
  useEffect(() => {
    if (mobileOpen) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  }, [mobileOpen]);

  const isActive = (href) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <>
      {/* Backdrop — mobile only */}
      {mobileOpen && (
        <button
          className="fixed inset-0 z-[45] bg-black/40 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation"
        />
      )}

      <nav
        aria-label="Main navigation"
        className={cn(
          // Base: fixed column with transition
          'fixed left-0 z-[48] flex flex-col bg-[var(--bg-secondary)]',
          // Mobile: full height from top, slide over header, sidebar-width
          'top-0 h-[100dvh] w-[var(--sidebar-width)] px-4 py-6',
          // md+: positioned below header, always visible, standard sidebar
          'md:top-[var(--header-height)] md:h-[calc(100vh-var(--header-height))]',
          collapsed && 'md:px-3',
          mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        )}
      >
        {/* Drawer header (mobile: close button; desktop: hidden close, just logo) */}
        <div className={cn('mb-6 px-4', collapsed && 'md:px-0')}>
          <div
            className={cn(
              'flex items-center gap-3',
              collapsed && 'md:justify-center',
            )}
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)] text-white shadow-sm">
              <Zap size={18} />
            </div>
            <div className={cn('flex-1', collapsed && 'md:hidden')}>
              <h2 className="text-sm font-bold text-[var(--text-primary)]">
                WorkDash
              </h2>
              <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-secondary)]">
                Workspace
              </p>
            </div>
            {/* Close button inside drawer — mobile only */}
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden min-h-11 min-w-11 shrink-0"
              onClick={() => setMobileOpen(false)}
              aria-label="Close navigation"
            >
              <X size={18} />
            </Button>
          </div>
        </div>

        <ul
          className="flex-1 flex flex-col gap-1 text-sm font-medium overflow-y-auto"
          data-scroll-region
        >
          {NAV_ITEMS.map((item) => (
            <li key={item.href}>
              {item.external ? (
                <a
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-4 py-3 text-[var(--text-secondary)] transition-all duration-200',
                    'hover:bg-[var(--surface-container-high)] hover:text-[var(--text-primary)] hover:translate-x-1',
                    'min-h-[44px] touch-manipulation',
                    collapsed &&
                      'md:justify-center md:px-0 md:hover:translate-x-0',
                    isActive(item.href) &&
                      'bg-[var(--surface-container-high)] text-[var(--accent)]',
                  )}
                >
                  <item.icon size={18} className="shrink-0" />
                  <span className={cn('flex-1', collapsed && 'md:hidden')}>
                    {item.label}
                  </span>
                </a>
              ) : (
                <Link
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-4 py-3 text-[var(--text-secondary)] transition-all duration-200',
                    'hover:bg-[var(--surface-container-high)] hover:text-[var(--text-primary)] hover:translate-x-1',
                    'min-h-[44px] touch-manipulation',
                    collapsed &&
                      'md:justify-center md:px-0 md:hover:translate-x-0',
                    isActive(item.href) &&
                      'bg-[var(--surface-container-high)] text-[var(--accent)]',
                  )}
                >
                  <item.icon size={18} className="shrink-0" />
                  <span className={cn('flex-1', collapsed && 'md:hidden')}>
                    {item.label}
                  </span>
                </Link>
              )}
            </li>
          ))}
        </ul>

        <div className="hidden pt-4 md:flex md:justify-center">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? (
              <PanelLeftOpen size={18} />
            ) : (
              <PanelLeftClose size={18} />
            )}
          </Button>
        </div>

        <div
          className={cn(
            'mt-auto border-t border-[color:color-mix(in_srgb,var(--outline-variant)_15%,transparent)] pt-6 sidebar-safe-bottom',
            collapsed && 'md:items-center',
          )}
        />
      </nav>
    </>
  );
}
