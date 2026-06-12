// Maquinita Service Worker v2 — versioned caches, differentiated strategies, Web Push.
//
// Caching strategies:
// - /_next/static/** → cache-first (immutable, content-hashed)
// - Navigation requests → network-first with App Shell fallback
// - /api/* (same-origin) → network-first with 5-minute max-age
// - Cross-origin → pass-through (no event.respondWith())
//
// Push notifications: show notification from backend payload.

// =============================================================================
// Build-time injected values (replaced by scripts/inject-sw-version.mjs)
// In dev mode these placeholders are not replaced, so we use safe defaults.
// =============================================================================
const BUILD_ID = typeof "__BUILD_ID__" === "string" && "__BUILD_ID__".startsWith("__") ? "dev" : "__BUILD_ID__";
const PRECACHE_URLS = typeof self.__PRECACHE_URLS__ !== "undefined" ? self.__PRECACHE_URLS__ : ["/"];

// =============================================================================
// Versioned cache names
// =============================================================================
const CACHE_SHELL = `maquinita-shell-${BUILD_ID}`;
const CACHE_STATIC = `maquinita-static-${BUILD_ID}`;
const CACHE_API = `maquinita-api-${BUILD_ID}`;

// =============================================================================
// Utility functions (pure, extracted for testability — tested in sw-utils.test.ts)
// =============================================================================

/**
 * Returns true if a cached response with the given timestamp has expired.
 * @param {number} cacheTimestamp - Unix ms when the response was cached
 * @param {number} maxAgeMs - Maximum age in milliseconds
 * @returns {boolean}
 */
function isCacheExpired(cacheTimestamp, maxAgeMs) {
  return Date.now() - cacheTimestamp > maxAgeMs;
}

/**
 * Classifies a URL into a route category for caching strategy selection.
 * @param {URL} url - The parsed URL
 * @param {string} origin - The service worker's origin
 * @returns {"static" | "api" | "navigation" | "cross-origin" | "other"}
 */
function matchRoute(url, origin) {
  if (url.origin !== origin) return "cross-origin";
  if (url.pathname.startsWith("/_next/static/")) return "static";
  if (url.pathname.startsWith("/api/")) return "api";
  return "other";
}

/**
 * Returns true if a cache name belongs to the current build version.
 * @param {string} cacheName - The cache name to check
 * @param {string} version - The current build version
 * @returns {boolean}
 */
function isCurrentVersion(cacheName, version) {
  return cacheName.endsWith(`-${version}`);
}

// Export utilities for testing (globalThis allows access in test environments)
if (typeof globalThis !== "undefined") {
  globalThis.__swUtils = { isCacheExpired, matchRoute, isCurrentVersion };
}

// =============================================================================
// Constants
// =============================================================================
const API_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

// =============================================================================
// Install — precache App Shell URLs (NO self.skipWaiting(), controlled by update toast)
// =============================================================================
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_SHELL).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
});

// =============================================================================
// Activate — delete old caches not matching current BUILD_ID, claim clients
// =============================================================================
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !isCurrentVersion(k, BUILD_ID))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// =============================================================================
// Message handler — supports SKIP_WAITING from update toast
// =============================================================================
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// =============================================================================
// Web Push — preserved from previous implementation
// =============================================================================
self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Maquinita", body: event.data.text() };
  }

  const { title, body, icon, tag, data } = payload;

  event.waitUntil(
    self.registration.showNotification(title || "Maquinita", {
      body: body || "",
      icon: icon || "/icon-192.png",
      badge: "/icon-192.png",
      tag: tag || "maquinita-default",
      data: data || {},
      vibrate: [200, 100, 200],
    }),
  );
});

// Tap on notification → open/focus the app
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus existing tab if open
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      // Otherwise open new tab
      return self.clients.openWindow(url);
    }),
  );
});

// =============================================================================
// Fetch — differentiated caching strategies
// =============================================================================
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const route = matchRoute(url, self.location.origin);

  // Cross-origin: do NOT call event.respondWith() — pass through to network
  if (route === "cross-origin") return;

  // --- Static assets (/_next/static/**): cache-first (immutable, content-hashed) ---
  if (route === "static") {
    event.respondWith(
      caches.open(CACHE_STATIC).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      }),
    );
    return;
  }

  // --- API routes (/api/*): network-first with 5-minute max-age ---
  if (route === "api") {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(request);
          if (res.ok) {
            // Clone and inject cache timestamp header
            const headers = new Headers(res.headers);
            headers.set("X-Cache-Time", String(Date.now()));
            const cachedResponse = new Response(await res.clone().blob(), {
              status: res.status,
              statusText: res.statusText,
              headers,
            });
            const cache = await caches.open(CACHE_API);
            cache.put(request, cachedResponse);
          }
          return res;
        } catch {
          // Network failed — try cache
          const cache = await caches.open(CACHE_API);
          const cached = await cache.match(request);
          if (cached) {
            const cacheTime = Number(cached.headers.get("X-Cache-Time"));
            if (cacheTime && !isCacheExpired(cacheTime, API_MAX_AGE_MS)) {
              return cached;
            }
            // Stale cache — delete it and return error
            await cache.delete(request);
          }
          return new Response("Network error", { status: 503, statusText: "Service Unavailable" });
        }
      })(),
    );
    return;
  }

  // --- Navigation requests: network-first with App Shell fallback ---
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(request);
          if (res.ok) {
            const cache = await caches.open(CACHE_SHELL);
            cache.put(request, res.clone());
          }
          return res;
        } catch {
          // Offline — serve cached shell
          const cache = await caches.open(CACHE_SHELL);
          const cached = await cache.match(request);
          if (cached) return cached;
          // Fall back to root shell (precached during install)
          const shellFallback = await cache.match("/");
          if (shellFallback) return shellFallback;
          return new Response("Offline", { status: 503, statusText: "Service Unavailable" });
        }
      })(),
    );
    return;
  }

  // --- Other same-origin requests: network-first with cache fallback ---
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(request);
        return res;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;
        return new Response("Offline", { status: 503, statusText: "Service Unavailable" });
      }
    })(),
  );
});
