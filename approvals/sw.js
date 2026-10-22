/* VaPiq Approvals service worker — push notifications only.
   Nothing is cached: patient data is always fetched fresh after sign-in. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.title || 'VaPiq', {
    body: d.body || 'New assignment to review',   // counts only — never patient details
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: 'vapiq-intake',
    renotify: true,
    data: { url: d.url || './' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.startsWith(self.registration.scope));
    if (open) { open.postMessage('refresh'); return open.focus(); }
    return self.clients.openWindow(url);
  }));
});
