import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { body: event.data.text() };
    }
  }

  const title = payload.title || 'MacroLens Reminder';
  const body =
    payload.body || 'Time to log your meal.';
  const url = payload.url || '/?action=snap';
  const tag = payload.tag || 'macrolens-reminder';
  const icon = payload.icon || '/icon-192.png?v=mono1';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge: '/icon-192.png?v=mono1',
      tag,
      data: { url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const rawUrl =
    (event.notification.data && event.notification.data.url) || '/?action=snap';
  const targetUrl = new URL(rawUrl, self.location.origin).href;

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(async (clientList) => {
        for (const client of clientList) {
          if (client.url.startsWith(self.location.origin)) {
            if ('navigate' in client && client.url !== targetUrl) {
              try {
                await client.navigate(targetUrl);
              } catch {
                // Ignore navigation failures on focused tab
              }
            }
            try {
              client.postMessage({
                type: 'MACROLENS_NOTIFICATION_CLICK',
                url: targetUrl,
              });
            } catch {
              // Ignore postMessage failure
            }
            if ('focus' in client) {
              return client.focus();
            }
          }
        }
        return self.clients.openWindow(targetUrl);
      })
  );
});
