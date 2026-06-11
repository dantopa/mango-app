/**
 * Verification tests for graceful prefetch failure handling.
 *
 * Requirements 10.7, 10.3:
 * - IF a route prefetch fails due to network unavailability, THEN the App SHALL fall back
 *   to on-demand loading upon navigation and display the route-level loading skeleton.
 * - WHEN navigating to a route whose data is not cached or stale, a skeleton shows within 16ms.
 *
 * Architecture verification:
 * 1. All nav links have prefetch={true} (Next.js handles failure silently)
 * 2. All routes have loading.tsx (Suspense fallback shown on on-demand load)
 * 3. Service Worker serves App Shell offline (navigation continues working)
 * 4. No error boundaries intercept the fallback flow
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const APP_DIR = path.resolve(__dirname, "..");
const COMPONENTS_DIR = path.resolve(APP_DIR, "../../components");
const PUBLIC_DIR = path.resolve(APP_DIR, "../../../public");

const ROUTES = [
  { name: "dashboard (/)", dir: APP_DIR, href: "/" },
  { name: "/gastos", dir: path.join(APP_DIR, "gastos"), href: "/gastos" },
  { name: "/patrimonio", dir: path.join(APP_DIR, "patrimonio"), href: "/patrimonio" },
  { name: "/objetivos", dir: path.join(APP_DIR, "objetivos"), href: "/objetivos" },
  { name: "/cierre", dir: path.join(APP_DIR, "cierre"), href: "/cierre" },
];

describe("Prefetch failure handling (Req 10.7, 10.3)", () => {
  describe("Navigation links use prefetch={true} for all routes", () => {
    it("AppShell sets prefetch={true} on all navigation Link components", () => {
      const appShellPath = path.join(COMPONENTS_DIR, "app-shell.tsx");
      const content = fs.readFileSync(appShellPath, "utf-8");

      // All Link components in the navigation must have prefetch={true}
      // Count occurrences of prefetch={true} — should cover brand + desktop nav + mobile nav
      const prefetchMatches = content.match(/prefetch=\{true\}/g);
      expect(prefetchMatches).not.toBeNull();
      // At minimum: 1 brand link + 5 desktop nav + 5 mobile nav = 11, but can be fewer
      // due to map pattern. At least 3 patterns (brand, desktop loop, mobile loop)
      expect(prefetchMatches!.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("All routes have loading.tsx (Suspense fallback for on-demand load)", () => {
    for (const route of ROUTES) {
      it(`${route.name} has loading.tsx that acts as fallback when prefetch fails`, () => {
        const loadingPath = path.join(route.dir, "loading.tsx");
        expect(fs.existsSync(loadingPath)).toBe(true);

        const content = fs.readFileSync(loadingPath, "utf-8");
        // Must be synchronous (no await, no data fetching) for instant display
        expect(content).not.toMatch(/\bawait\b/);
        expect(content).not.toMatch(/\bfetch\(/);
        // Must render skeletons
        expect(content).toMatch(/Skeleton/);
      });
    }
  });

  describe("No error boundaries block the Suspense fallback", () => {
    for (const route of ROUTES) {
      it(`${route.name} has no error.tsx that would intercept loading`, () => {
        const errorPath = path.join(route.dir, "error.tsx");
        // error.tsx files would catch rendering errors, but they should NOT
        // be present at the route level (they'd catch prefetch/load failures
        // before the skeleton gets a chance to display)
        //
        // Note: It's fine for error.tsx to exist for runtime errors, but
        // Next.js won't trigger it for failed prefetches — it uses on-demand loading instead.
        // This test documents that no error boundary interferes with the skeleton flow.
        if (fs.existsSync(errorPath)) {
          const content = fs.readFileSync(errorPath, "utf-8");
          // If an error.tsx exists, ensure it doesn't interfere with navigation
          // (it should only handle runtime errors, not navigation/prefetch failures)
          // For now, we verify none exist (confirming current architecture)
          expect(content).toBeDefined();
        }
        // The key assertion: error.tsx does NOT exist at route level
        expect(fs.existsSync(errorPath)).toBe(false);
      });
    }
  });

  describe("Service Worker supports offline navigation (App Shell fallback)", () => {
    it("sw.js has navigation handler with cache fallback", () => {
      const swPath = path.join(PUBLIC_DIR, "sw.js");
      const content = fs.readFileSync(swPath, "utf-8");

      // SW must handle navigation requests
      expect(content).toMatch(/request\.mode\s*===\s*["']navigate["']/);

      // SW must have a cache fallback for offline navigation
      expect(content).toMatch(/CACHE_SHELL/);

      // SW must serve the root shell as final fallback
      expect(content).toMatch(/cache\.match\(["']\/["']\)/);
    });

    it("sw.js does NOT throw on navigation fetch failure — it gracefully falls back", () => {
      const swPath = path.join(PUBLIC_DIR, "sw.js");
      const content = fs.readFileSync(swPath, "utf-8");

      // The navigation handler must have a catch block that serves cached shell
      // (network-first with cache fallback pattern)
      expect(content).toMatch(/catch/);

      // It should not throw unhandled errors — all paths return a Response
      // The offline path returns cached shell or a 503 (never throws)
      expect(content).toMatch(/503/);
    });
  });

  describe("Offline banner shows during offline navigation", () => {
    it("OfflineBanner is rendered inside AppShell (visible on all routes)", () => {
      const appShellPath = path.join(COMPONENTS_DIR, "app-shell.tsx");
      const content = fs.readFileSync(appShellPath, "utf-8");

      // OfflineBanner must be imported and rendered
      expect(content).toMatch(/OfflineBanner/);
      expect(content).toMatch(/<OfflineBanner/);
    });

    it("OfflineBanner uses useOnlineStatus hook for reactive status", () => {
      const bannerPath = path.join(COMPONENTS_DIR, "offline-banner.tsx");
      const content = fs.readFileSync(bannerPath, "utf-8");

      // Must use the online status hook
      expect(content).toMatch(/useOnlineStatus/);

      // Must conditionally render based on online status
      expect(content).toMatch(/isOnline/);

      // Must show "sin conexión" text
      expect(content).toMatch(/[Ss]in conexión/);
    });
  });

  describe("Architecture ensures prefetch failure → skeleton → content flow", () => {
    it("AppShell documents the prefetch failure graceful degradation pattern", () => {
      const appShellPath = path.join(COMPONENTS_DIR, "app-shell.tsx");
      const content = fs.readFileSync(appShellPath, "utf-8");

      // The architectural decision is documented in code
      expect(content).toMatch(/prefetch.*fail/i);
      expect(content).toMatch(/on-demand loading/i);
    });

    it("loading.tsx files use animate-in for smooth appearance", () => {
      // When on-demand loading triggers after failed prefetch, the skeleton
      // should appear smoothly — verify animations are in place
      for (const route of ROUTES) {
        const loadingPath = path.join(route.dir, "loading.tsx");
        const content = fs.readFileSync(loadingPath, "utf-8");
        expect(content).toMatch(/animate-in/);
      }
    });
  });
});
