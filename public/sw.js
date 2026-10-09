// Content Lens service worker: app shell works offline; data (/api) always goes to the network.
const CACHE = 'cl-shell-v1';
const SHELL = ['/', '/app.js', '/base.css', '/app.css', '/manifest.webmanifest', '/icon-192.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__'))) return;
  const isLib = url.hostname === 'cdn.jsdelivr.net';
  if (url.origin !== location.origin && !isLib) return;
  if (isLib) { // versioned CDN libraries: cache-first
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })));
    return;
  }
  // own files: network-first so updates arrive, cache as offline fallback
  e.respondWith(fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy)); } return res; })
    .catch(() => caches.match(req.mode === 'navigate' ? '/' : req)));
});
