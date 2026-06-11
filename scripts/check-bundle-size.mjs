#!/usr/bin/env node
/**
 * check-bundle-size.mjs
 *
 * Runs `next build` and parses the route size table from stdout to enforce
 * per-route bundle size budgets (gzipped First Load JS).
 *
 * Usage:
 *   node scripts/check-bundle-size.mjs
 *
 * Or pipe build output:
 *   next build | node scripts/check-bundle-size.mjs --stdin
 *
 * Exit codes:
 *   0 - All routes within budget
 *   1 - One or more routes exceed budget
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

// Per-route budgets in KB (gzipped First Load JS)
const BUDGETS = {
  "/": 150,
  "/gastos": 200,
  "/patrimonio": 200,
  "/objetivos": 120,
  "/cierre": 120,
};

/**
 * Parse a size string like "145 kB" or "89.2 kB" into a number in KB.
 */
function parseSizeKB(sizeStr) {
  const match = sizeStr.trim().match(/^([\d.]+)\s*kB$/i);
  if (!match) return null;
  return parseFloat(match[1]);
}

/**
 * Parse the Next.js build output table to extract route sizes.
 * 
 * The build output contains lines like:
 *   ┌ ○ /                     5.17 kB    145 kB
 *   ├ ○ /cierre               1.23 kB     89 kB
 *   └ ○ /patrimonio           3.45 kB    178 kB
 * 
 * Or with dynamic/static markers:
 *   ┌ ● / (SSG)              5.17 kB    145 kB
 *   ├ ƒ /gastos              3.21 kB    192 kB
 *
 * The last size column is "First Load JS" (gzipped).
 */
function parseRouteSizes(buildOutput) {
  const routeSizes = new Map();
  const lines = buildOutput.split("\n");

  // Match route lines: starts with tree chars (┌├└│) followed by route markers (○●ƒ◐)
  // and a route path, then sizes
  const routeLineRegex =
    /^[┌├└│\s]+[○●ƒ◐λ]\s+(\/\S*)\s+.*?([\d.]+\s*kB)\s*$/;

  for (const line of lines) {
    const match = line.match(routeLineRegex);
    if (match) {
      let route = match[1];
      const firstLoadJS = match[2];

      // Clean route: remove trailing markers like "(SSG)" etc.
      route = route.replace(/\s*\(.*\)$/, "").trim();

      const sizeKB = parseSizeKB(firstLoadJS);
      if (sizeKB !== null) {
        routeSizes.set(route, sizeKB);
      }
    }
  }

  return routeSizes;
}

/**
 * Get build output either from stdin (--stdin flag) or by running next build.
 */
function getBuildOutput() {
  const useStdin = process.argv.includes("--stdin");

  if (useStdin) {
    return readFileSync(0, "utf-8");
  }

  console.log("🔨 Running next build...\n");
  try {
    const output = execSync("npx next build", {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, NODE_ENV: "production" },
    });
    return output;
  } catch (error) {
    // next build may exit non-zero but still produce usable output
    if (error.stdout) {
      return error.stdout;
    }
    console.error("❌ next build failed:", error.message);
    process.exit(1);
  }
}

// --- Main ---
const buildOutput = getBuildOutput();
const routeSizes = parseRouteSizes(buildOutput);

if (routeSizes.size === 0) {
  console.error("❌ Could not parse any route sizes from build output.");
  console.error("   Make sure `next build` produces the expected route table.");
  process.exit(1);
}

console.log("📦 Bundle Size Check\n");
console.log("Route".padEnd(20) + "Size (kB)".padEnd(12) + "Budget (kB)".padEnd(13) + "Status");
console.log("─".repeat(55));

let hasFailure = false;

for (const [route, budget] of Object.entries(BUDGETS)) {
  const actual = routeSizes.get(route);

  if (actual === undefined) {
    console.log(
      `${route.padEnd(20)}${"N/A".padEnd(12)}${String(budget).padEnd(13)}⚠️  not found`
    );
    continue;
  }

  const overBudget = actual > budget;
  if (overBudget) hasFailure = true;

  const status = overBudget
    ? `❌ OVER (+${(actual - budget).toFixed(1)} kB)`
    : "✅ OK";

  console.log(
    `${route.padEnd(20)}${String(actual).padEnd(12)}${String(budget).padEnd(13)}${status}`
  );
}

console.log("─".repeat(55));

if (hasFailure) {
  console.log("\n❌ Bundle size budget exceeded! Fix before deploying.");
  process.exit(1);
} else {
  console.log("\n✅ All routes within budget.");
  process.exit(0);
}
