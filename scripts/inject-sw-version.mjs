#!/usr/bin/env node
/**
 * inject-sw-version.mjs
 *
 * Post-build script that reads the Next.js BUILD_ID and injects it into
 * public/sw.js, replacing the __BUILD_ID__ and __PRECACHE_URLS__ placeholders.
 *
 * Run automatically via the `postbuild` npm script after `next build`.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const BUILD_ID_PATH = join(ROOT, ".next", "BUILD_ID");
const SW_PATH = join(ROOT, "public", "sw.js");

// --- Read BUILD_ID ---
if (!existsSync(BUILD_ID_PATH)) {
  console.error("❌ .next/BUILD_ID not found. Run `next build` first.");
  process.exit(1);
}

const buildId = readFileSync(BUILD_ID_PATH, "utf-8").trim();
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

if (!sw.includes("__BUILD_ID__")) {
  console.warn("⚠ __BUILD_ID__ placeholder not found in sw.js — already injected?");
} else {
  sw = sw.replace(/__BUILD_ID__/g, buildId);
}

if (!sw.includes("__PRECACHE_URLS__")) {
  console.warn("⚠ __PRECACHE_URLS__ placeholder not found in sw.js — already injected?");
} else {
  sw = sw.replace("__PRECACHE_URLS__", JSON.stringify(precacheUrls));
}

writeFileSync(SW_PATH, sw, "utf-8");
console.log(`✔ Injected build ID and precache manifest into public/sw.js`);
