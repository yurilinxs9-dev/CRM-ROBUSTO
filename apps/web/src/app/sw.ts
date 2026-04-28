/// <reference lib="webworker" />
import { defaultCache } from '@serwist/next/worker';
import { Serwist } from 'serwist';

declare const self: ServiceWorkerGlobalScope & {
  __SW_MANIFEST: (string | { url: string; revision: string | null })[];
};

// Bump on any SW behavior change to force install/activate on every client.
// Old caches are nuked in `activate` so users never get stuck on stale assets.
const SW_VERSION = 'v3-2026-04-28';

// Hard-bypass the service worker for realtime + API traffic. Registered
// before serwist so its respondWith wins and serwist never sees the
// request — this is the only reliable way to prevent the SW from buffering
// long-poll xhr or interfering with WS upgrades on flaky networks.
self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
  }
});

// On every activate, drop every existing cache. Combined with skipWaiting +
// clientsClaim this guarantees a PWA session picks up the latest bundle as
// soon as a new SW ships, so users don't see "some features not loading"
// because of stale precache hits. Serwist will refill its own precache on
// the next request (small one-time hit, then back to instant).
self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    })(),
  );
});

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: defaultCache,
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
