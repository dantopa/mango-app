// =============================================================================
// browser-token-mcp — Token refresh endpoint handler
// =============================================================================
// Handles POST /refresh requests from the Token Extractor (bookmarklet).
// Validates authentication, input, and stores the token in Vault.
// Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10
// =============================================================================

import type { RefreshRequest, RefreshResponse } from "./types.ts";
import { VaultWriteError } from "./types.ts";
import { writeToken } from "./vault.ts";
import { isValidProvider, validProviderNames } from "./registry.ts";
import { timingSafeEqual } from "./security.ts";

/** Maximum request body size in bytes (10 KB) */
const MAX_BODY_SIZE = 10 * 1024;

/** Maximum token length in characters */
const MAX_TOKEN_LENGTH = 8192;

/**
 * Handle a token refresh request.
 * CORS headers are NOT added here — they are handled by index.ts.
 *
 * @param req - The incoming HTTP request (already routed to /refresh)
 * @returns A Response with appropriate status and JSON body
 */
export async function refreshHandler(req: Request): Promise<Response> {
  // --- Auth: validate BROWSER_MCP_REFRESH_SECRET (Req 3.3, 3.4, 3.8) ---
  const refreshSecret = Deno.env.get("BROWSER_MCP_REFRESH_SECRET");
  if (!refreshSecret) {
    return jsonResponse(500, { error: "Server configuration error" });
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : "";

  if (!bearer) {
    return jsonResponse(401, { error: "Unauthorized" });
  }

  // Reject Shared_Secret on the refresh endpoint (Req 3.8).
  // This must be checked BEFORE the refresh secret comparison so that even if
  // both secrets are accidentally set to the same value, we enforce separation.
  const sharedSecret = Deno.env.get("BROWSER_MCP_SECRET") ?? "";
  if (sharedSecret && timingSafeEqual(bearer, sharedSecret)) {
    return jsonResponse(401, { error: "Unauthorized" });
  }

  // Validate against the refresh-specific secret (Req 3.3, 3.4)
  if (!timingSafeEqual(bearer, refreshSecret)) {
    return jsonResponse(401, { error: "Unauthorized" });
  }

  // --- Content-Type validation (Req 3.1) ---
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return jsonResponse(415, { error: "Content-Type must be application/json" });
  }

  // --- Body size and JSON parsing (Req 3.10) ---
  let rawBody: string;
  try {
    const bodyBytes = await req.arrayBuffer();
    if (bodyBytes.byteLength > MAX_BODY_SIZE) {
      return jsonResponse(400, { error: "Request body exceeds maximum size of 10KB" });
    }
    rawBody = new TextDecoder().decode(bodyBytes);
  } catch {
    return jsonResponse(400, { error: "Failed to read request body" });
  }

  let body: RefreshRequest;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON in request body" });
  }

  // --- Validate provider (Req 3.5) ---
  const provider = body.provider;
  if (!provider || typeof provider !== "string" || !isValidProvider(provider)) {
    return jsonResponse(400, {
      error: `Unknown provider: '${String(provider ?? "")}'`,
      valid_providers: validProviderNames(),
    });
  }

  // --- Validate token (Req 3.6) ---
  const token = body.token;
  if (!token || typeof token !== "string" || token.trim().length === 0) {
    return jsonResponse(400, {
      error: "Token is required and must not be empty or whitespace-only",
      max_length: MAX_TOKEN_LENGTH,
    });
  }

  if (token.length > MAX_TOKEN_LENGTH) {
    return jsonResponse(400, {
      error: `Token exceeds maximum length of ${MAX_TOKEN_LENGTH} characters`,
      max_length: MAX_TOKEN_LENGTH,
    });
  }

  // --- Store token in Vault (Req 3.2, 3.9) ---
  try {
    await writeToken(provider, token);
  } catch (err) {
    if (err instanceof VaultWriteError) {
      return jsonResponse(502, { error: "Token storage failed" });
    }
    return jsonResponse(502, { error: "Token storage failed" });
  }

  // --- Success response (Req 3.7) ---
  const response: RefreshResponse = {
    provider,
    updated_at: new Date().toISOString(),
  };

  return jsonResponse(200, response);
}

/** Helper to create a JSON response with the given status and body. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
