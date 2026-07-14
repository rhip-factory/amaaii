// Minimal app-shell service worker for the Amaaii Next.js PWA. Adapted
// from public/sw.js's strategy (cache the shell, network-first for
// anything dynamic) for a static-export Next.js build:
//  - Next build assets (/_next/static/*) and font files are hashed and
//    immutable per build, so they're safe to cache-first.
//  - Navigations are network-first with an offline fallback page, since
//    the whole point of a maternal-health app is not showing stale
//    guidance if a fresher version is reachable.
//  - No offline outbox yet (queued /chat sends while offline) — that's a
//    later package; this SW only keeps the shell viewable offline.

const VERSION = "amaaii-web-shell-v1";
const SHELL = [
  "/",
  "/login",
  "/offline",
  "/manifest.webmanifest",
  "/img/logo-lockup-purple.png",
  "/img/logo-mark-purple.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {
        /* best effort — a slow/offline first install shouldn't hard-fail */
      })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // /chat, /auth/login, PUT /me are all non-GET → straight to network
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Navigations (typing a URL, following a link, reload): network-first
  // so users always get the latest shell when online, with an offline
  // fallback page when they aren't.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/offline").then((hit) => hit || caches.match("/")))
    );
    return;
  }

  // Hashed, immutable build assets + self-hosted fonts: cache-first.
  if (url.pathname.startsWith("/_next/static/") || /\.(woff2?|ttf)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const clone = res.clone();
            caches.open(VERSION).then((cache) => cache.put(req, clone));
            return res;
          })
      )
    );
    return;
  }

  // Everything else (icons, manifest, etc.): cache-first, network fallback.
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req).catch(() => caches.match("/offline"))));
});
