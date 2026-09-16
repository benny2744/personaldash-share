/**
 * app/layout.js — Root layout with sidebar + header shell.
 * Wraps all pages with the persistent navigation and top bar.
 */

import './globals.css';
import Sidebar from '@/components/layout/Sidebar';
import Header from '@/components/layout/Header';
import AppShell from '@/components/layout/AppShell';
import { MobileNavProvider } from '@/components/layout/MobileNavContext';
import OfflineBanner from '@/components/layout/OfflineBanner';
import PushPermissionPrompt from '@/components/layout/PushPermissionPrompt';

export const metadata = {
  title: process.env.APP_NAME || 'WorkDash',
  description: 'Self-hosted workspace: chat, DingTalk, calendar, projects, kanban, meetings',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: process.env.APP_NAME || 'WorkDash',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#0053dc' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/icons/icon-192x192.png" />
      </head>
      <body className="bg-[var(--background)] text-[var(--foreground)] min-h-screen">
        <MobileNavProvider>
          <AppShell>
            <Sidebar />
            <div className="app-main">
              <Header />
              <div className="app-content animate-fade-in">
                {children}
              </div>
            </div>
          </AppShell>
        </MobileNavProvider>
        <OfflineBanner />
        <PushPermissionPrompt />
      </body>
    </html>
  );
}
