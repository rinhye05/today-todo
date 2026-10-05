self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const appUrl = new URL('./?show=today', self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find((item) => item.url.startsWith(self.registration.scope));
    if (client) {
      client.postMessage({ type: 'show-today' });
      await client.focus();
    } else await self.clients.openWindow(appUrl);
  })());
});
