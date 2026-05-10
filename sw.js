// TTC ChipDrop service worker
// Cache-first for the app shell (so the app loads instantly even on bad signal)
// Network-first for live data (so customer list stays fresh when online,
// falls back to last known good version offline)
// Bypass entirely for Apps Script POSTs (drops/undos must always hit the network)

// Bump this version any time index.html (or any cached shell file) changes.
// On next visit the new SW activates, the old cache is purged in the
// activate handler, and the new shell is fetched fresh from GitHub.
const CACHE_NAME = 'ttc-chipdrop-v2';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never cache POST (Apps Script writes)

  const url = new URL(req.url);

  // Apps Script web app — always live, no caching
  if (url.host.includes('script.google.com')) return;

  // Sheet CSV + Drive thumbnails — network-first, fall back to cache
  if (
    url.host.includes('docs.google.com') ||
    url.host.includes('drive.google.com') ||
    url.pathname.endsWith('.csv')
  ) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // App shell — cache-first
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req).then((res) => {
          if (res.ok && url.origin === location.origin) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
    )
  );
});
