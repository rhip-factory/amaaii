// Minimal app-shell service worker for the Amaaii PWA demo.
// Caches static assets so the chrome loads offline; /chat always
// hits the network (it needs the live model + DB).

const VERSION = 'amaaii-shell-v5';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/img/logo-lockup-purple.png',
  '/img/logo-mark-purple.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // /chat is POST → straight to network
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // ignore cross-origin (fonts)

  // Cache-first for the app shell, network-fallback otherwise.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).catch(() => caches.match('/')))
  );
});
