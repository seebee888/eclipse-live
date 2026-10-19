// Offline fallback for the dashboards: always try the network first (numbers change every 15 minutes), and fall back
// to the last copy this device saw when there is no connection. Data files stay encrypted in the cache.
const CACHE = 'eclipse-live-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const key = url.origin + url.pathname;
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return res;
  }).catch(async () => (await caches.match(key)) || Response.error()));
});
