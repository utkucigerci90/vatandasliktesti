/* Einbürgerungstest Türkçe — offline support.
   Pages: network first (always fresh when online), cached copy offline.
   Icons/fonts: cache first. /api/* and payment scripts are never cached. */
const VERSION = 'einb-v1';
const PRECACHE = ['/', '/fiyat', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  // Each file on its own: one missing file must not abort the whole install.
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin && url.pathname.startsWith('/api/')) return;
  const isFont = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!sameOrigin && !isFont) return; // Paddle, analytics: straight to network

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(url.pathname === '/fiyat' ? '/fiyat' : '/', copy)); }
        return res;
      }).catch(() => caches.match(url.pathname === '/fiyat' ? '/fiyat' : '/'))
    );
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }))
  );
});
