/* ClickNPuff service worker: opens instantly, survives a bad connection,
   and shows push notifications. Live data (/api) always goes to the
   network — prices, stock and order status are never served stale. */
const VERSION = 'cnp-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/favicon.svg'];

const OFFLINE_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClickNPuff — offline</title><body style="margin:0;font-family:system-ui,sans-serif;background:#0f2a1d;color:#e8f0ea;display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px">
<div><div style="font-size:48px">💨</div><h1 style="margin:8px 0">You're offline</h1><p style="opacity:.8">Check your data or Wi-Fi, then try again.</p>
<button onclick="location.reload()" style="margin-top:12px;padding:12px 20px;border:0;border-radius:12px;background:#48bb78;color:#06210f;font-weight:700;font-size:16px">Try again</button></div>`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Pages: newest from the network, the cached app if offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put('/', copy)); return res; })
        .catch(() => caches.match('/').then((r) => r || new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))),
    );
    return;
  }
  // Built assets have content hashes in their names, so a cached copy is
  // always the right one. Icons and the manifest refresh in the background.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req);
      const fresh = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || fresh;
    }));
  }
});

self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { title: 'ClickNPuff', body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    // If ClickNPuff is open on screen at that page, the app already shows
    // and sounds it — don't double up.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = m.url || '/';
    if (wins.some((w) => w.visibilityState === 'visible' && new URL(w.url).pathname.startsWith(target.split('?')[0]))) return;
    await self.registration.showNotification(m.title || 'ClickNPuff', {
      body: m.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/maskable-192.png',
      tag: m.tag,
      renotify: !!m.tag,
      requireInteraction: !!m.offer,
      vibrate: m.urgent ? [300, 120, 300, 120, 500] : [200],
      data: { url: target },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) { await w.focus(); if ('navigate' in w) await w.navigate(target).catch(() => {}); return; }
    }
    await self.clients.openWindow(target);
  })());
});
