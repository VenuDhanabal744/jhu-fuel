// Offline support. App files: stale-while-revalidate (instant launch, updates on the next
// open). Menu data: network-first with offline fallback. Pinned CDN libraries: cache-first.
// The recognition model is cached separately by transformers.js itself.

const APP = 'jhu-fuel-app-v1';
const DATA = 'jhu-fuel-data-v1';
const LIBS = 'jhu-fuel-libs-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('jhu-fuel-') && ![APP, DATA, LIBS].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(DATA);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    return (await cache.match(request)) ?? Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(APP);
  const cached = await cache.match(request, { ignoreSearch: true });
  const fresh = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => cached ?? Response.error());
  return cached ?? fresh;
}

async function cacheFirst(request) {
  const cache = await caches.open(LIBS);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    event.respondWith(url.pathname.includes('/data/') ? networkFirst(request) : staleWhileRevalidate(request));
  } else if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(cacheFirst(request));
  }
});
