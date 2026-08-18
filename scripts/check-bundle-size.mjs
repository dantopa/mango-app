#!/usr/bin/env node
/**
 * check-bundle-size.mjs
 *
 * Enforces per-route budgets on gzipped First Load JS.
 *
 * Next 16 removed the `size` and `First Load JS` columns from the `next build`
 * output (they undercounted the Client Components payload), so the sizes are
 * computed here from the build manifests instead: the shared runtime
 * (rootMainFiles + polyfillFiles) plus every client chunk the route's RSC
 * manifest lists as an entry, deduplicated and gzipped.
 *
 * Usage (after `next build`):
 *   node scripts/check-bundle-size.mjs
 *
 * Exit codes:
 *   0 - All routes within budget
 *   1 - One or more routes exceed budget, or the build output is missing
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const ROOT = resolve(import.meta.dirname, "..");
const BUILD_DIR = resolve(ROOT, ".next");

// Per-route budgets in KB (gzipped First Load JS). Baselined against the real
// chunk sizes — raise only with a deliberate decision, never to make CI pass.
const BUDGETS = {
  "/": 320,
  "/gastos": 360,
  "/patrimonio": 420,
  "/objetivos": 320,
  "/cierre": 320,
};

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(BUILD_DIR, relativePath), "utf-8"));
}

/**
 * Total gzipped size, in KB, of a set of chunk paths relative to `.next/`.
 */
function gzippedKB(chunkPaths) {
  let bytes = 0;
  for (const chunk of chunkPaths) {
    bytes += gzipSync(readFileSync(resolve(BUILD_DIR, chunk))).length;
  }
  return bytes / 1024;
}

/**
 * Client chunks a route loads on first paint: the shared runtime plus every
 * entry in the route's RSC manifest (its own page and each enclosing layout).
 *
 * The manifest is a CJS file that assigns to `globalThis.__RSC_MANIFEST`, so it
 * is required rather than parsed.
 */
function firstLoadChunks(appPath, sharedChunks) {
  const require = createRequire(import.meta.url);
  globalThis.__RSC_MANIFEST = {};
  require(resolve(BUILD_DIR, "server/app", `.${appPath}_client-reference-manifest.js`));

  const manifest = globalThis.__RSC_MANIFEST[appPath];
  const chunks = new Set(sharedChunks);
  for (const entryChunks of Object.values(manifest.entryJSFiles)) {
    for (const chunk of entryChunks) chunks.add(chunk);
  }
  return chunks;
}

// --- Main ---
let routeToAppPath;
let sharedChunks;
try {
  const appPathRoutes = readJson("app-path-routes-manifest.json");
  routeToAppPath = new Map(Object.entries(appPathRoutes).map(([appPath, route]) => [route, appPath]));

  const buildManifest = readJson("build-manifest.json");
  sharedChunks = [...buildManifest.rootMainFiles, ...buildManifest.polyfillFiles];
} catch (error) {
  console.error("❌ Could not read the build manifests from .next/");
  console.error(`   Run \`next build\` first. (${error.message})`);
  process.exit(1);
}

console.log("📦 Bundle Size Check (gzipped First Load JS)\n");
console.log("Route".padEnd(20) + "Size (kB)".padEnd(12) + "Budget (kB)".padEnd(13) + "Status");
console.log("─".repeat(55));

let hasFailure = false;

for (const [route, budget] of Object.entries(BUDGETS)) {
  const appPath = routeToAppPath.get(route);

  if (appPath === undefined) {
    console.log(`${route.padEnd(20)}${"N/A".padEnd(12)}${String(budget).padEnd(13)}⚠️  not in build`);
    continue;
  }

  const actual = gzippedKB(firstLoadChunks(appPath, sharedChunks));
  const overBudget = actual > budget;
  if (overBudget) hasFailure = true;

  const status = overBudget ? `❌ OVER (+${(actual - budget).toFixed(1)} kB)` : "✅ OK";

  console.log(`${route.padEnd(20)}${actual.toFixed(1).padEnd(12)}${String(budget).padEnd(13)}${status}`);
}

console.log("─".repeat(55));

if (hasFailure) {
  console.log("\n❌ Bundle size budget exceeded! Fix before deploying.");
  process.exit(1);
}

console.log("\n✅ All routes within budget.");
