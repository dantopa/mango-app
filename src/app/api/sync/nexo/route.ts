import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { callMcpTool, McpError } from "@/lib/sync/mcp-client";
import { adaptNexo } from "@/lib/sync/adapters/nexo";
import { processCandidates } from "@/lib/sync/sync-engine";
import type { SyncRequest, SyncErrorResponse } from "@/lib/sync/types";

/**
 * POST /api/sync/nexo
 * Body: { month: "2024-07" }
 * Auth: Supabase session cookie
 *
 * Flow:
 * 1. Verify user session
 * 2. Call browser-token-mcp via JSON-RPC (nexo_get_card_transactions)
 * 3. Adapt response → CandidateTransaction[]
 * 4. Process via sync-engine
 * 5. Return SyncSourceResult
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Verify session
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { error: "No autenticado", code: "AUTH_EXPIRED" } satisfies SyncErrorResponse,
        { status: 401 }
      );
    }

    // 2. Parse request body
    const body: SyncRequest = await request.json();
    const { month } = body;

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json(
        { error: "Formato de mes inválido. Usar YYYY-MM.", code: "MCP_ERROR" } satisfies SyncErrorResponse,
        { status: 400 }
      );
    }

    // Calculate date range
    const [year, m] = month.split("-").map(Number);
    const lastDay = new Date(year, m, 0).getDate();
    const monthStart = `${month}-01`;
    const monthEnd = `${month}-${String(lastDay).padStart(2, "0")}`;

    // 3. Call MCP — Nexo uses limit/offset pagination (no date filter).
    // Fetch pages until we have transactions outside the month range.
    const allRawTxs: Array<Record<string, unknown>> = [];
    let offset = 0;
    const limit = 100;
    let done = false;

    while (!done) {
      const rawData = await callMcpTool("nexo_get_card_transactions", {
        limit,
        offset,
      });

      const page = Array.isArray(rawData) ? rawData : [];
      if (page.length === 0) break;

      for (const tx of page) {
        const txDate = String(tx.date ?? "");
        if (txDate >= monthStart && txDate <= monthEnd) {
          allRawTxs.push(tx);
        } else if (txDate < monthStart) {
          // Transactions are DESC — if we went past the start, stop
          done = true;
          break;
        }
        // Skip transactions after monthEnd (future pages might have our month)
      }

      if (!done && page.length === limit) {
        offset += limit;
      } else {
        break;
      }
    }

    // 4. Adapt
    const candidates = adaptNexo(allRawTxs as any);

    // 5. Process via sync-engine
    const result = await processCandidates(candidates, user.id, month);

    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof McpError) {
      return NextResponse.json(
        { error: err.message, code: err.code } satisfies SyncErrorResponse,
        { status: err.code === "AUTH_EXPIRED" ? 401 : 502 }
      );
    }

    console.error("[sync/nexo] error:", err);
    return NextResponse.json(
      { error: "Error interno del servidor", code: "MCP_ERROR" } satisfies SyncErrorResponse,
      { status: 500 }
    );
  }
}
