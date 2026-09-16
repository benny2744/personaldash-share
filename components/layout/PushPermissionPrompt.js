'use client';

import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';

export default function PushPermissionPrompt() {
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    if (
      typeof window !== 'undefined' &&
      'Notification' in window &&
      Notification.permission === 'default'
    ) {
      const timer = setTimeout(() => setShowPrompt(true), 2000);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleAllow = async () => {
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
        });
        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subscription),
        });
      }
    } catch (err) {
      console.error('Push subscription failed:', err);
    }
    setShowPrompt(false);
  };

  const handleDismiss = () => setShowPrompt(false);

  if (!showPrompt) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] max-w-sm rounded-lg border border-slate-200 bg-white p-4 shadow-xl">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-50">
          <Bell size={20} className="text-blue-600" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-slate-900">Enable notifications</p>
          <p className="mt-1 text-xs text-slate-500">
            Get reminders for task due dates and upcoming meetings.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleAllow}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              Allow
            </button>
            <button
              onClick={handleDismiss}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
