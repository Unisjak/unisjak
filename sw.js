/* UniSjak service worker – kun til push-notifikationer (ingen caching, så appen altid er frisk). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: 'UniSjak', body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'UniSjak';
  e.waitUntil(self.registration.showNotification(title, { body: d.body || '', icon: '/icon-192.png', badge: '/favicon-32.png', tag: d.tag || undefined, renotify: !!d.tag, data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.postMessage({ type: 'push-open', url }); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
