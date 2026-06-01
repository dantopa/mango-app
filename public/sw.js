// Maquinita service worker — conservative, data-safe caching.
// - Hashed Next static assets: cache-first (immutable).
// - Navigations & everything else same-origin: network-first, cache fallback.
// - Cross-origin (Supabase API, etc.): never intercepted.
const CACHE = "maquinita-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // leave Supabase & co. alone

  // Immutable build assets: cache-first.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      }),
    );
    return;
  }

  // Everything else: network-first so deploys & data stay fresh.
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(request);
        if (res.ok && request.mode === "navigate") {
          const cache = await caches.open(CACHE);
          cache.put(request, res.clone());
        }
        return res;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw new Error("offline");
      }
    })(),
  );
});
