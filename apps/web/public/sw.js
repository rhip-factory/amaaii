// Minimal app-shell service worker for the Amaaii Next.js PWA. Adapted
// from public/sw.js's strategy (cache the shell, network-first for
// anything dynamic) for a static-export Next.js build:
//  - Next build assets (/_next/static/*) and font files (self-hosted via
//    next/font — see src/app/fonts.ts — which land under
//    /_next/static/media/*) are hashed and immutable per build, so
//    they're safe to cache-first.
//  - Navigations are network-first with a cache fallback, since the
//    whole point of a maternal-health app is not showing stale guidance
//    if a fresher version is reachable — but a successful navigation
//    response is also cached, so a page visited once while online stays
//    viewable offline even outside the precached SHELL list, and the
//    dedicated /offline page is the last-resort fallback when neither
//    the network nor the cache has anything for that URL.
//  - Offline outbox (P2-D): queued /journal/entries submissions are
//    handled entirely by the app layer (src/lib/outbox.ts +
//    OutboxContext.tsx), NOT here — that's what makes it work in
//    `next dev`, where this SW is never registered (see
//    ServiceWorkerRegister.tsx). This SW's only involvement is the
//    Background Sync listener below, which is a progressive-enhancement
//    wake trigger, not the guaranteed sync path.

const VERSION = "amaaii-web-shell-v2";
const OUTBOX_SYNC_TAG = "amaaii-flush-outbox";
const SHELL = [
  "/",
  "/home",
  "/journal",
  "/chat",
  "/insights",
  "/profile",
  "/login",
  "/offline",
  "/manifest.webmanifest",
  "/img/logo-lockup-purple.png",
  "/img/logo-mark-purple.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) =>
      // Fetch+cache each shell URL independently (not cache.addAll, which
      // is all-or-nothing) so one route being unreachable at install time
      // — a cold CDN cache, a host that doesn't resolve an extensionless
      // path — doesn't silently leave the ENTIRE shell uncached.
      Promise.allSettled(
        SHELL.map((url) =>
          fetch(url).then((res) => (res.ok ? cache.put(url, res) : undefined))
        )
      )
    )
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

// GET API endpoints (see next.config.ts's rewrite table for the same
// path list) — deliberately bypassed below, straight to network, no SW
// caching. Offline behavior for these is owned by IndexedDB
// (src/lib/offlineCache.ts's stale-while-revalidate cache), which checks
// navigator.onLine BEFORE ever calling fetch — so it never reaches this
// SW while genuinely offline. Without this bypass, the generic
// cache-first/network-fallback branch further down would catch a failed
// fetch to e.g. /me and hand back the cached /offline PAGE as a fake 200
// response, which api.ts would then try (and fail) to parse as JSON —
// wrong for a data endpoint, right only for a navigation.
const API_GET_PATHS = [/^\/me(\/|$)/, /^\/history$/, /^\/journal\/entries/, /^\/journal\/today$/];

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // /chat, /auth/login, PUT /me are all non-GET → straight to network
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (API_GET_PATHS.some((re) => re.test(url.pathname))) return;

  // Navigations (typing a URL, following a link, reload): network-first
  // so users always get the latest shell when online. On success, also
  // cache the response so this exact page still renders offline later
  // even if it wasn't in the precached SHELL list. On failure, fall back
  // to whatever's cached for this URL, then the shell root, then the
  // dedicated offline page as the last resort.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, clone));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("/offline").then((h2) => h2 || caches.match("/"))))
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

// Background Sync (P2-D) — progressive enhancement, not the guaranteed
// path. Chrome/Edge/Android only; feature-detected client-side before
// ever registering (src/lib/outbox.ts's registerBackgroundSync). A
// service worker has no access to localStorage, so it can't read the
// bearer token the outbox's authenticated POST needs (see api.ts) — it
// would have to duplicate auth handling in plain JS to submit directly.
// Instead, on 'sync' it just wakes any open tab to run the SAME
// authenticated flush the app already runs on 'online' / app start (see
// OutboxContext.tsx's message listener). If no tab is open, this is a
// no-op — the flush still runs unconditionally the next time the app is
// opened, which is the actual correctness guarantee here.
self.addEventListener("sync", (event) => {
  if (event.tag !== OUTBOX_SYNC_TAG) return;
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      clients.forEach((client) => client.postMessage({ type: "amaaii-flush-outbox" }));
    })
  );
});
