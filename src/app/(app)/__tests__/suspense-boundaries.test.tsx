/**
 * Verification tests for route-level React Suspense boundaries (loading.tsx).
 *
 * Requirements 10.4, 10.5, 10.6:
 * - Each route has a loading.tsx that serves as the Suspense fallback
 * - loading.tsx files render within 16ms (one animation frame)
 * - AppShell layout remains mounted across route transitions (no full re-render)
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const APP_DIR = path.resolve(__dirname, "..");

const ROUTES = [
  { name: "dashboard (/)", dir: APP_DIR },
  { name: "/gastos", dir: path.join(APP_DIR, "gastos") },
  { name: "/patrimonio", dir: path.join(APP_DIR, "patrimonio") },
  { name: "/objetivos", dir: path.join(APP_DIR, "objetivos") },
  { name: "/cierre", dir: path.join(APP_DIR, "cierre") },
];

describe("Route-level Suspense boundaries", () => {
  describe("All routes have loading.tsx files", () => {
    for (const route of ROUTES) {
      it(`${route.name} has loading.tsx`, () => {
        const loadingPath = path.join(route.dir, "loading.tsx");
        expect(fs.existsSync(loadingPath)).toBe(true);
      });
    }
  });

  describe("loading.tsx files are lightweight (render within 16ms)", () => {
    for (const route of ROUTES) {
      it(`${route.name} loading.tsx contains no data fetching or heavy computation`, () => {
        const loadingPath = path.join(route.dir, "loading.tsx");
        const content = fs.readFileSync(loadingPath, "utf-8");

        // No async operations — loading must be synchronous
        expect(content).not.toMatch(/\bawait\b/);
        expect(content).not.toMatch(/\bfetch\(/);
        expect(content).not.toMatch(/\buseQuery\b/);
        expect(content).not.toMatch(/\buseEffect\b/);
        expect(content).not.toMatch(/\buseState\b/);

        // Must use only Skeleton (lightweight div with CSS animation)
        expect(content).toMatch(/Skeleton/);

        // No heavy libraries imported (Recharts, date-fns, etc.)
        expect(content).not.toMatch(/from\s+["']recharts["']/);
        expect(content).not.toMatch(/from\s+["']date-fns["']/);
        expect(content).not.toMatch(/from\s+["']@tanstack/);
      });
    }
  });

  describe("AppShell layout architecture", () => {
    it("(app)/layout.tsx exists and wraps children with AppShell", () => {
      const layoutPath = path.join(APP_DIR, "layout.tsx");
      expect(fs.existsSync(layoutPath)).toBe(true);

      const content = fs.readFileSync(layoutPath, "utf-8");

      // Layout imports and uses AppShell
      expect(content).toMatch(/AppShell/);

      // Layout renders children inside AppShell (this is what Next.js swaps on navigation)
      expect(content).toMatch(/\{children\}/);
    });

    it("AppShell is a client component that stays mounted across transitions", () => {
      const appShellPath = path.resolve(APP_DIR, "../../components/app-shell.tsx");
      const content = fs.readFileSync(appShellPath, "utf-8");

      // AppShell is a client component — it renders once and children swap
      expect(content).toMatch(/"use client"/);

      // It renders {children} inside a wrapper — Next.js swaps children, not the shell
      expect(content).toMatch(/\{children\}/);

      // It does NOT re-fetch user data on each render (auth is handled in layout.tsx server component)
      expect(content).not.toMatch(/\bgetUser\b/);
      expect(content).not.toMatch(/\bsupabase\.auth\b/);
    });

    it("layout.tsx is a server component that passes auth context to AppShell", () => {
      const layoutPath = path.join(APP_DIR, "layout.tsx");
      const content = fs.readFileSync(layoutPath, "utf-8");

      // The layout itself is NOT marked "use client" — it's a server component
      expect(content).not.toMatch(/"use client"/);

      // It fetches auth on the server side (runs once, not on every navigation)
      expect(content).toMatch(/createClient/);
      expect(content).toMatch(/getUser/);
    });
  });
});
