// =============================================================================
// browser-token-mcp — MCP Protocol Handler
// =============================================================================
// JSON-RPC 2.0 dispatcher implementing the MCP Streamable HTTP transport.
// Handles: initialize, tools/list, tools/call, ping, notifications.
// Auth: BROWSER_MCP_SECRET via Bearer header or `key` query param.
// Requirements: 1.1–1.5, 2.1–2.5, 5.2, 5.7, 9.4, 9.5, 9.6
// =============================================================================

import type { ToolResult } from "./types.ts";
import { VaultEmptyError, VaultServiceError } from "./types.ts";
import { readToken } from "./vault.ts";
import { resolveProvider, allTools } from "./registry.ts";
import { timingSafeEqual, redactToken, sanitizeError } from "./security.ts";

// --- Constants ---------------------------------------------------------------

const SERVER_INFO = { name: "browser-token-mcp", version: "1.0.0" };
const PROTOCOL_VERSION = "2024-11-05";

// --- JSON-RPC helpers --------------------------------------------------------

// deno-lint-ignore no-explicit-any
function rpcResult(id: any, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

// deno-lint-ignore no-explicit-any
function rpcError(id: any, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function errorContent(message: string): ToolResult {
  return { content: [{ type: "text", text: `ERROR: ${message}` }], isError: true };
}

// --- Auth extraction ---------------------------------------------------------

/**
 * Extract the auth token from the request.
 * Priority: Authorization Bearer header > `key` query param.
 * Requirement 2.2
 */
function extractToken(req: Request): string | null {
  // Header takes priority
  const authHeader = req.headers.get("authorization");
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1];
  }

  // Fallback to query param
  const url = new URL(req.url);
  const keyParam = url.searchParams.get("key");
  if (keyParam) return keyParam;

  return null;
}

// --- tools/call dispatch -----------------------------------------------------

/**
 * Handle a tools/call request: resolve provider, read token from Vault,
 * call provider handler, wrap errors with redaction.
 * Requirements: 1.4, 5.2, 5.7, 9.6, 10.1, 10.3
 */
// deno-lint-ignore no-explicit-any
async function handleToolsCall(id: any, params: any): Promise<unknown> {
  const toolName = params?.name as string;
  if (!toolName) {
    return rpcResult(id, errorContent("Tool name is required"));
  }

  // Resolve provider by tool name prefix (Req 5.2)
  const provider = resolveProvider(toolName);
  if (!provider) {
    return rpcResult(id, errorContent(`Tool not found: ${toolName}`));
  }

  // Read token from Vault (Req 4.2, 5.7)
  let token: string;
  try {
    token = await readToken(provider.name);
  } catch (err) {
    if (err instanceof VaultEmptyError) {
      return rpcResult(id, errorContent(err.message));
    }
    if (err instanceof VaultServiceError) {
      return rpcResult(id, errorContent("Internal storage error"));
    }
    return rpcResult(id, errorContent("Internal storage error"));
  }

  // Call provider handler (Req 1.4)
  try {
    const result: ToolResult = await provider.handle(
      toolName,
      params?.arguments ?? {},
      token,
    );
    return rpcResult(id, result);
  } catch (err) {
    // Sanitize and redact token from error messages (Req 9.3, 10.3)
    let message = sanitizeError(err);
    try {
      message = redactToken(message, token);
    } catch {
      // If redaction itself fails, suppress provider error content (Req 10.6)
      message = `Tool execution failed: ${provider.name}/${toolName}`;
    }
    return rpcResult(id, errorContent(message));
  }
}

// --- JSON-RPC method dispatch ------------------------------------------------

// deno-lint-ignore no-explicit-any
async function handleRpc(msg: any): Promise<unknown | null> {
  const { id, method, params } = msg ?? {};

  switch (method) {
    // MCP initialize (Req 1.2)
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    // Notifications — no response (JSON-RPC spec)
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    // Ping (keep-alive)
    case "ping":
      return rpcResult(id, {});

    // Tools list (Req 1.3)
    case "tools/list":
      return rpcResult(id, { tools: allTools() });

    // Tools call (Req 1.4, 1.5)
    case "tools/call":
      return await handleToolsCall(id, params);

    // Unknown method (Req 9.5)
    default:
      // If no id, it's a notification we don't recognize — ignore
      if (id === undefined) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// --- Main handler ------------------------------------------------------------

/**
 * MCP protocol handler.
 * Validates auth, parses JSON-RPC, dispatches methods.
 * Does NOT handle CORS or Deno.serve — that's in index.ts.
 */
export async function mcpHandler(req: Request): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  // --- Check BROWSER_MCP_SECRET env var (Req 2.3, 2.4) -----------------------
  const secret = Deno.env.get("BROWSER_MCP_SECRET");
  if (!secret) {
    return json(rpcError(null, -32002, "Server configuration error"), 500);
  }

  // --- Authenticate (Req 2.1, 2.2, 2.5) -------------------------------------
  const token = extractToken(req);
  if (!token || !timingSafeEqual(token, secret)) {
    return json(rpcError(null, -32001, "Unauthorized: invalid secret"), 401);
  }

  // --- Parse JSON body (Req 9.4) ---------------------------------------------
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error: invalid JSON"), 400);
  }

  // --- Support JSON-RPC batches ----------------------------------------------
  if (Array.isArray(payload)) {
    const out: unknown[] = [];
    for (const m of payload) {
      const r = await handleRpc(m);
      if (r !== null) out.push(r);
    }
    return out.length
      ? json(out)
      : new Response(null, { status: 202 });
  }

  // --- Single request --------------------------------------------------------
  const result = await handleRpc(payload);
  if (result === null) {
    return new Response(null, { status: 202 });
  }
  return json(result);
}
