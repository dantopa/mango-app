import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import {
  isCacheExpired,
  matchRoute,
  isCurrentVersion,
} from "../sw-utils";

// **Validates: Requirements 4.4, 4.5, 4.7**

// --- Property 2: SW API cache expiry enforcement ---

describe("Property 2: SW API cache expiry enforcement", () => {
  const FIVE_MINUTES_MS = 5 * 60 * 1000; // 300_000

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("isCacheExpired returns true iff elapsed time exceeds maxAge", () => {
    fc.assert(
      fc.property(
        // Generate a "now" reference point
        fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }),
        // Generate elapsed time 0–10 minutes in ms
        fc.integer({ min: 0, max: 10 * 60 * 1000 }),
        (now, elapsedMs) => {
          vi.setSystemTime(now);
          const cacheTimestamp = now - elapsedMs;
          const result = isCacheExpired(cacheTimestamp, FIVE_MINUTES_MS);
          const expected = elapsedMs > FIVE_MINUTES_MS;
          expect(result).toBe(expected);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("cache at exactly maxAge boundary is NOT expired (elapsed === maxAge)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }),
        (now) => {
          vi.setSystemTime(now);
          const cacheTimestamp = now - FIVE_MINUTES_MS;
          // elapsed === maxAge → not expired (> not >=)
          expect(isCacheExpired(cacheTimestamp, FIVE_MINUTES_MS)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("cache 1ms past maxAge IS expired", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }),
        (now) => {
          vi.setSystemTime(now);
          const cacheTimestamp = now - FIVE_MINUTES_MS - 1;
          expect(isCacheExpired(cacheTimestamp, FIVE_MINUTES_MS)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// --- Property 3: Versioned cache cleanup ---

describe("Property 3: Versioned cache cleanup", () => {
  it("isCurrentVersion returns true iff cacheName ends with -{version}", () => {
    // Generate version strings (alphanumeric build IDs)
    const versionArb = fc.stringMatching(/^[a-zA-Z0-9]{4,16}$/);
    // Generate cache prefixes (e.g. "maquinita-shell", "maquinita-api")
    const prefixArb = fc.stringMatching(/^[a-z]{3,12}(-[a-z]{3,10})?$/);

    fc.assert(
      fc.property(prefixArb, versionArb, (prefix, version) => {
        const matchingName = `${prefix}-${version}`;
        expect(isCurrentVersion(matchingName, version)).toBe(true);
      }),
      { numRuns: 200 }
    );
  });

  it("cache names with non-matching versions are rejected", () => {
    const versionArb = fc.stringMatching(/^[a-zA-Z0-9]{4,16}$/);
    const prefixArb = fc.stringMatching(/^[a-z]{3,12}(-[a-z]{3,10})?$/);

    fc.assert(
      fc.property(
        prefixArb,
        versionArb,
        versionArb,
        (prefix, currentVersion, cacheVersion) => {
          fc.pre(currentVersion !== cacheVersion);
          const cacheName = `${prefix}-${cacheVersion}`;
          expect(isCurrentVersion(cacheName, currentVersion)).toBe(false);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("from a set of cache names, only those ending with -{version} survive", () => {
    const versionArb = fc.stringMatching(/^[a-zA-Z0-9]{4,16}$/);
    const prefixArb = fc.stringMatching(/^[a-z]{3,10}(-[a-z]{3,8})?$/);

    fc.assert(
      fc.property(
        versionArb,
        fc.array(prefixArb, { minLength: 1, maxLength: 5 }),
        fc.array(versionArb, { minLength: 1, maxLength: 3 }),
        (currentVersion, prefixes, oldVersions) => {
          // Build cache names: some with current version, some with old versions
          const currentCaches = prefixes.map((p) => `${p}-${currentVersion}`);
          const oldCaches = oldVersions
            .filter((v) => v !== currentVersion)
            .flatMap((v) => prefixes.map((p) => `${p}-${v}`));

          const allCaches = [...currentCaches, ...oldCaches];
          const survivors = allCaches.filter((name) =>
            isCurrentVersion(name, currentVersion)
          );

          // All survivors should be from currentCaches
          for (const s of survivors) {
            expect(s.endsWith(`-${currentVersion}`)).toBe(true);
          }
          // All currentCaches should survive
          for (const c of currentCaches) {
            expect(survivors).toContain(c);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// --- Property 4: Cross-origin passthrough ---

describe("Property 4: Cross-origin passthrough", () => {
  it("URLs with a different origin are classified as cross-origin", () => {
    const schemeArb = fc.constantFrom("https", "http");
    const domainArb = fc.stringMatching(/^[a-z]{3,10}\.[a-z]{2,4}$/);
    const pathArb = fc
      .array(fc.stringMatching(/^[a-z0-9]{1,8}$/), {
        minLength: 0,
        maxLength: 3,
      })
      .map((parts) => "/" + parts.join("/"));

    fc.assert(
      fc.property(
        schemeArb,
        domainArb,
        schemeArb,
        domainArb,
        pathArb,
        (swScheme, swDomain, urlScheme, urlDomain, urlPath) => {
          const swOrigin = `${swScheme}://${swDomain}`;
          const urlOrigin = `${urlScheme}://${urlDomain}`;
          fc.pre(swOrigin !== urlOrigin);

          const url = new URL(`${urlOrigin}${urlPath}`);
          expect(matchRoute(url, swOrigin)).toBe("cross-origin");
        }
      ),
      { numRuns: 200 }
    );
  });

  it("same-origin URLs are NOT classified as cross-origin", () => {
    const originArb = fc
      .stringMatching(/^[a-z]{3,10}\.[a-z]{2,4}$/)
      .map((domain) => `https://${domain}`);
    const pathArb = fc
      .array(fc.stringMatching(/^[a-z0-9]{1,8}$/), {
        minLength: 1,
        maxLength: 3,
      })
      .map((parts) => "/" + parts.join("/"));

    fc.assert(
      fc.property(originArb, pathArb, (origin, path) => {
        // Avoid paths that match static or api to test general case
        fc.pre(!path.startsWith("/_next/static/") && !path.startsWith("/api/"));
        const url = new URL(`${origin}${path}`);
        expect(matchRoute(url, origin)).not.toBe("cross-origin");
      }),
      { numRuns: 200 }
    );
  });

  it("Supabase API calls (different origin) pass through as cross-origin", () => {
    const swOrigin = "https://maquinita.app";
    const supabaseUrls = [
      "https://abc123.supabase.co/rest/v1/accounts",
      "https://abc123.supabase.co/auth/v1/token",
      "https://abc123.supabase.co/storage/v1/object/avatars",
    ];

    for (const raw of supabaseUrls) {
      const url = new URL(raw);
      expect(matchRoute(url, swOrigin)).toBe("cross-origin");
    }
  });
});
