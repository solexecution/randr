// Service worker: cache-first so the whole app — including the WASM kernel —
// runs with no network after the first visit. The cache name carries a version
// so a new deploy cleanly replaces the old shell.
//
// Note: the precache list is the app shell. Hashed build assets (JS/CSS/WASM)
// are cached on first fetch via the runtime handler below, which keeps this
// file stable across builds.

const CACHE = 'randr-v1';
// Relative paths so the app works whether it's served from the domain root or a
// project subpath like /forge-cad/ (GitHub Pages). Resolved against the SW scope.
const SHELL = [
  './',
  './index.html',
  './favicon.svg',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './fonts/SpaceGrotesk-400.woff2',
  './fonts/SpaceGrotesk-500.woff2',
  './fonts/SpaceGrotesk-700.woff2',
  './fonts/IBMPlexMono-400.woff2',
  './fonts/IBMPlexMono-500.woff2',
  './fonts/IBMPlexMono-600.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Don't try to cache cross-origin font requests opaquely forever; let them
  // fall through to network and cache what we can.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // Cache same-origin assets (app code, wasm) for offline reuse.
        if (res.ok && new URL(req.url).origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
