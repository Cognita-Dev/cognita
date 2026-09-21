// pwa/sw.js
// Only job: show a push notification when one arrives, and take the
// person to the right place in the app when they tap it. No offline
// caching — that's a separate feature this project doesn't need yet.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: 'Cognita', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Cognita';
  const options = {
    body: data.body || '',
    icon: '/pwa/icons/cognita.png',
    badge: '/pwa/icons/cognita.png',
    data: { url: data.url || '/app.html?view=reminders' },
    tag: data.tag || undefined,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/app.html?view=reminders';

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of allClients) {
        const clientUrl = new URL(client.url);
        if (clientUrl.pathname === new URL(targetUrl, self.location.origin).pathname && 'focus' in client) {
          client.postMessage({ type: 'cognita:navigate', url: targetUrl });
          return client.focus();
        }
      }
      // No matching window open — open a new one.
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })()
  );
});
