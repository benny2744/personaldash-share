'use client';

import { WifiOff, Wifi } from 'lucide-react';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';

export default function OfflineBanner() {
  const { isOnline, wasOffline } = useNetworkStatus();

  if (isOnline && !wasOffline) return null;

  return (
    <div
      className={`fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium shadow-lg transition-all duration-300 ${
        isOnline
          ? 'bg-green-600 text-white'
          : 'bg-slate-800 text-white'
      }`}
    >
      {isOnline ? (
        <>
          <Wifi size={16} />
          Back online
        </>
      ) : (
        <>
          <WifiOff size={16} />
          Offline — viewing cached data
        </>
      )}
    </div>
  );
}
