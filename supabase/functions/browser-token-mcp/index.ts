// =============================================================================
// browser-token-mcp — Entry point router
// =============================================================================
// Supabase Edge Function entry point using Deno.serve().
// Handles CORS preflight, method validation, and path-based routing.
// Requirements: 1.6, 1.7, 1.8, 3.1
// =============================================================================

import { mcpHandler } from "./mcp.ts";
import { refreshHandler } from "./refresh.ts";
import { register } from "./registry.ts";
import { nexoProvider } from "./providers/nexo.ts";
import { bancolombiaProvider } from "./providers/bancolombia.ts";

// --- Register provider modules -----------------------------------------------
register(nexoProvider);
register(bancolombiaProvider);

// --- CORS headers applied to ALL responses -----------------------------------
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/**
 * Wraps a Response with CORS headers merged in.
 * Preserves existing headers from the original response.
 */
function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// --- Deno.serve entry point --------------------------------------------------
Deno.serve(async (req: Request): Promise<Response> => {
  // OPTIONS preflight → 204 + CORS (Req 1.7)
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Reject non-POST/OPTIONS → 405 (Req 1.8)
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: CORS });
  }

  // Path-based routing (Req 3.1)
  const url = new URL(req.url);
  const path = url.pathname;

  let response: Response;

  if (path.endsWith("/refresh")) {
    response = await refreshHandler(req);
  } else {
    response = await mcpHandler(req);
  }

  // Apply CORS headers to handler responses (Req 1.6)
  return withCors(response);
});
