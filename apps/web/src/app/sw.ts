/// <reference lib="webworker" />
import { defaultCache } from '@serwist/next/worker';
import { NetworkOnly, Serwist } from 'serwist';

declare const self: ServiceWorkerGlobalScope & {
  __SW_MANIFEST: (string | { url: string; revision: string | null })[];
};

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      matcher: ({ url }) => url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/'),
      handler: new NetworkOnly(),
      method: 'GET',
    },
    {
      matcher: ({ url }) => url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/'),
      handler: new NetworkOnly(),
      method: 'POST',
    },
    ...defaultCache,
  ],
});

serwist.addEventListeners();

interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
  data?: Record<string, unknown>;
}

self.addEventListener('push', (event: PushEvent) => {
  const payload: PushPayload = (() => {
    if (!event.data) return {};
    try {
      return event.data.json() as PushPayload;
    } catch {
      return { body: event.data.text() };
    }
  })();
  const title = payload.title ?? 'CRM';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body ?? '',
      icon: '/icons/icon-192.svg',
      badge: '/icons/icon-192.svg',
      tag: payload.tag,
      data: { url: payload.url ?? '/', ...(payload.data ?? {}) },
    }),
  );
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if ('focus' in c) {
          await c.focus();
          if ('navigate' in c) await (c as WindowClient).navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
