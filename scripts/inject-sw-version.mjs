#!/usr/bin/env node
/**
 * inject-sw-version.mjs
 *
 * Injects a build version into public/sw.js, replacing the __BUILD_ID__ and
 * __PRECACHE_URLS__ placeholders, so every deploy ships a byte-different SW
 * (the browser only installs a new one then) with its own cache names.
 *
 * Runs as `prebuild`, not `postbuild`: on Vercel, `next build` already copies
 * public/ into the output when it finishes, so a file changed afterwards is
 * never deployed. The version is the commit being deployed
 * (VERCEL_GIT_COMMIT_SHA), the same value that busts the persisted query
 * cache; outside Vercel it falls back to the last Next BUILD_ID or a timestamp.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const BUILD_ID_PATH = join(ROOT, ".next", "BUILD_ID");
const SW_PATH = join(ROOT, "public", "sw.js");

// --- Resolve the version ---
const buildId =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  (existsSync(BUILD_ID_PATH) ? readFileSync(BUILD_ID_PATH, "utf-8").trim() : `local-${Date.now()}`);
console.log(`✔ BUILD_ID: ${buildId}`);

// --- Resolve precache URLs ---
// Include the app shell route and manifest. Static assets are content-hashed
// and handled by the cache-first strategy, so we only precache navigation URLs.
const precacheUrls = ["/"];

// --- Inject into sw.js ---
if (!existsSync(SW_PATH)) {
  console.error("❌ public/sw.js not found.");
  process.exit(1);
}

let sw = readFileSync(SW_PATH, "utf-8");

// Replace the dev-safe BUILD_ID line with the actual build ID
const buildIdLine = /const BUILD_ID = .*?;/;
if (buildIdLine.test(sw)) {
  sw = sw.replace(buildIdLine, `const BUILD_ID = "${buildId}";`);
} else {
  console.warn("⚠ BUILD_ID declaration not found in sw.js");
}

// Replace the dev-safe PRECACHE_URLS line with the actual URLs
const precacheUrlsLine = /const PRECACHE_URLS = .*?;/;
if (precacheUrlsLine.test(sw)) {
  sw = sw.replace(precacheUrlsLine, `const PRECACHE_URLS = ${JSON.stringify(precacheUrls)};`);
} else {
  console.warn("⚠ PRECACHE_URLS declaration not found in sw.js");
}

writeFileSync(SW_PATH, sw, "utf-8");
console.log(`✔ Injected build ID and precache manifest into public/sw.js`);
