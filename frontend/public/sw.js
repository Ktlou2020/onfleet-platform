self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'OnFleet', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'OnFleet';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/logo.png',
    badge: '/logo.png',
    data: { url: data.url || '/' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

// ── Uploaded images: cache once, serve for ever after ───────────────────────
//
// A workshop is a bad place for a phone signal, and the parts picker is now
// image-led: a technician scrolling the catalogue pulls a photo for every row.
// Without this, each scroll re-fetches over the same bad connection, and a
// dropped request leaves a blank square where the answer was supposed to be.
//
// Cache-first is right here specifically because these bytes never change.
// An uploaded photo has an unguessable, single-use filename — a new photo is a
// new URL — so a cached copy can never be stale, only unnecessary. Everything
// else the app fetches is left alone; this handler deliberately declines to
// touch API calls or the app shell, which have their own freshness rules.
const IMAGE_CACHE = 'onfleet-uploads-v1';

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((n) => n.startsWith('onfleet-uploads-') && n !== IMAGE_CACHE)
        .map((n) => caches.delete(n))
    ))
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/uploads/')) return;

  event.respondWith((async () => {
    const cache = await caches.open(IMAGE_CACHE);
    const hit = await cache.match(request);
    if (hit) return hit;
    try {
      const response = await fetch(request);
      // Only keep a real answer. A 404 or an auth redirect cached here would
      // be a blank square that never recovers.
      if (response.ok && response.status === 200) cache.put(request, response.clone());
      return response;
    } catch (e) {
      // Offline and never fetched: let the browser show its own broken image
      // rather than inventing one.
      return Response.error();
    }
  })());
});
