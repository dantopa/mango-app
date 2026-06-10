import type { SyncErrorCode } from "./types";

/**
 * Llama a browser-token-mcp Edge Function via JSON-RPC.
 * URL: NEXT_PUBLIC_SUPABASE_URL/functions/v1/browser-token-mcp
 * Auth: Bearer BROWSER_MCP_SECRET
 */
export async function callMcpTool(
  toolName: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.BROWSER_MCP_SECRET;

  if (!supabaseUrl || !secret) {
    throw new McpError(
      "MCP_ERROR",
      "Missing NEXT_PUBLIC_SUPABASE_URL or BROWSER_MCP_SECRET"
    );
  }

  const url = `${supabaseUrl}/functions/v1/browser-token-mcp`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: { name: toolName, arguments: params },
      }),
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new McpError(
        "AUTH_EXPIRED",
        "Token de sesión bancaria expirado"
      );
    }

    if (!response.ok) {
      throw new McpError("MCP_ERROR", `HTTP ${response.status}`);
    }

    const rpc = await response.json();

    if (rpc.error) {
      throw new McpError("MCP_ERROR", rpc.error.message ?? "RPC error");
    }

    // The result comes in rpc.result.content[0].text (JSON string)
    const text = rpc.result?.content?.[0]?.text;
    if (!text) {
      throw new McpError("MCP_ERROR", "Empty response from MCP");
    }

    return JSON.parse(text);
  } catch (err) {
    if (err instanceof McpError) throw err;

    if (err instanceof Error && err.name === "AbortError") {
      throw new McpError("TIMEOUT", "MCP call timed out (15s)");
    }

    throw new McpError(
      "MCP_ERROR",
      err instanceof Error ? err.message : "Unknown error"
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Typed error for MCP failures, carrying the appropriate error code.
 */
export class McpError extends Error {
  code: SyncErrorCode;

  constructor(code: SyncErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "McpError";
  }
}
