import { defaultCache } from '@serwist/next/worker';
import {
  Serwist,
  NetworkFirst,
  NetworkOnly,
  StaleWhileRevalidate,
  CacheFirst,
  ExpirationPlugin,
  CacheableResponsePlugin,
} from 'serwist';

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      // Must come before defaultCache so Hermes is never intercepted/cached.
      matcher: /\/hermes(\/.*)?$/i,
      handler: new NetworkOnly(),
    },
    {
      // Native chat page + bootstrap token must always be fresh.
      matcher: /\/chat(\/.*)?$/i,
      handler: new NetworkOnly(),
    },
    {
      matcher: /\/api\/hermes(\/.*)?$/i,
      handler: new NetworkOnly(),
    },
    {
      // Application data owned by the client-side LocalStore (IndexedDB).
      // Excluded from generic response caching to avoid double-cache
      // consistency bugs (stale SW responses overwriting fresher renders).
      matcher: /\/api\/(dingtalk|knowledge)(\/.*)?$/i,
      handler: new NetworkOnly(),
    },
    ...defaultCache,
    {
      matcher: /\/api\/.*/i,
      method: 'GET',
      handler: new NetworkFirst({
        cacheName: 'api-cache',
        networkTimeoutSeconds: 10,
        plugins: [
          new CacheableResponsePlugin({ statuses: [0, 200] }),
          new ExpirationPlugin({
            maxEntries: 100,
            maxAgeSeconds: 60 * 60 * 24 * 30,
          }),
        ],
      }),
    },
    {
      matcher: /\/(projects|kanban|calendar|meetings)\/.*/i,
      handler: new StaleWhileRevalidate({
        cacheName: 'pages-cache',
        plugins: [
          new CacheableResponsePlugin({ statuses: [0, 200] }),
          new ExpirationPlugin({
            maxEntries: 50,
            maxAgeSeconds: 60 * 60 * 24 * 30,
          }),
        ],
      }),
    },
    {
      matcher: /\.(?:png|jpg|jpeg|svg|gif|webp|ico)$/i,
      handler: new CacheFirst({
        cacheName: 'images-cache',
        plugins: [
          new ExpirationPlugin({
            maxEntries: 100,
            maxAgeSeconds: 60 * 60 * 24 * 7,
          }),
        ],
      }),
    },
  ],
});

self.addEventListener('push', (event) => {
  let data = { title: 'WorkDash', body: 'You have a notification' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-192x192.png',
    vibrate: [100, 50, 100],
    data: data.url || '/',
    actions: data.actions || [],
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data || '/';
  event.waitUntil(self.clients.openWindow(url));
});

serwist.addEventListeners();
