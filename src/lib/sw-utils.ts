/**
 * Service Worker utility functions — extracted for testability.
 *
 * These are pure functions mirroring the logic in public/sw.js.
 * The SW uses its own copy (cannot import ES modules), but tests
 * validate these equivalents to ensure correctness.
 */

/**
 * Returns true if a cached response with the given timestamp has expired.
 * @param cacheTimestamp - Unix ms when the response was cached
 * @param maxAgeMs - Maximum age in milliseconds
 */
export function isCacheExpired(cacheTimestamp: number, maxAgeMs: number): boolean {
  return Date.now() - cacheTimestamp > maxAgeMs;
}

export type RouteCategory = "static" | "api" | "navigation" | "cross-origin" | "other";

/**
 * Classifies a URL into a route category for caching strategy selection.
 * @param url - The parsed URL object
 * @param origin - The service worker's origin (e.g. "https://maquinita.app")
 * @param mode - The request mode (e.g. "navigate", "cors", "no-cors")
 */
export function matchRoute(url: URL, origin: string, mode?: RequestMode): RouteCategory {
  if (url.origin !== origin) return "cross-origin";
  if (url.pathname.startsWith("/_next/static/")) return "static";
  if (url.pathname.startsWith("/api/")) return "api";
  if (mode === "navigate") return "navigation";
  return "other";
}

/**
 * Returns true if a cache name belongs to the current build version.
 * Cache names follow the pattern: `maquinita-{type}-{version}`
 * @param cacheName - The cache name to check
 * @param version - The current build version
 */
export function isCurrentVersion(cacheName: string, version: string): boolean {
  return cacheName.endsWith(`-${version}`);
}
