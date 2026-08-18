import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Not Next.js code — mirrors the "exclude" in tsconfig.json.
    // Deno (Supabase Edge Functions), a Chrome extension and build scripts:
    // Next/React rules produce only false positives here.
    "supabase/functions/**",
    "tools/**",
    "scripts/**",
  ]),
]);

export default eslintConfig;
