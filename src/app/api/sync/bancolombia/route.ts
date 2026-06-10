import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { callMcpTool, McpError } from "@/lib/sync/mcp-client";
import { adaptBancolombia } from "@/lib/sync/adapters/bancolombia";
import { processCandidates, recategorizeMonth } from "@/lib/sync/sync-engine";
import type { SyncRequest, SyncErrorResponse } from "@/lib/sync/types";

/**
 * POST /api/sync/bancolombia
 * Body: { month: "2024-07" }
 * Auth: Supabase session cookie
 *
 * Flow:
 * 1. Verify user session
 * 2. Call browser-token-mcp via JSON-RPC (bancolombia_get_transactions)
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

    // Calculate date range for the month (Bancolombia API uses YYYY/MM/DD format)
    const [year, m] = month.split("-").map(Number);
    const lastDay = new Date(year, m, 0).getDate();
    const dateFrom = `${year}/${String(m).padStart(2, "0")}/01`;
    const dateTo = `${year}/${String(m).padStart(2, "0")}/${String(lastDay).padStart(2, "0")}`;

    // 3a. Get account number dynamically via bancolombia_get_accounts
    const accountsData = await callMcpTool("bancolombia_get_accounts", {}) as {
      accounts?: Array<{ number: string; type: string }>;
    };

    const savingsAccount = accountsData?.accounts?.find(
      (a) => a.type === "CUENTA_DE_AHORRO" || a.type?.toLowerCase().includes("ahorro")
    );

    if (!savingsAccount?.number) {
      return NextResponse.json(
        { error: "No se encontró cuenta de ahorros en Bancolombia", code: "MCP_ERROR" } satisfies SyncErrorResponse,
        { status: 502 }
      );
    }

    // 3b. Call MCP for transactions
    const rawData = await callMcpTool("bancolombia_get_transactions", {
      account_number: savingsAccount.number,
      date_from: dateFrom,
      date_to: dateTo,
    });

    // 4. Adapt
    const rawTxs = Array.isArray(rawData) ? rawData : [];
    const candidates = adaptBancolombia(rawTxs);

    // 5. Process via sync-engine
    const result = await processCandidates(candidates, user.id, month);

    // 6. Re-categorize & re-classify any uncategorized transactions from this month
    const recat = await recategorizeMonth(user.id, month);
    if (recat.updated > 0 || recat.classified > 0) {
      console.log(`[sync/bancolombia] recategorized: ${recat.updated} updated, ${recat.classified} reclassified`);
    }

    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof McpError) {
      return NextResponse.json(
        { error: err.message, code: err.code } satisfies SyncErrorResponse,
        { status: err.code === "AUTH_EXPIRED" ? 401 : 502 }
      );
    }

    console.error("[sync/bancolombia] error:", err);
    return NextResponse.json(
      { error: "Error interno del servidor", code: "MCP_ERROR" } satisfies SyncErrorResponse,
      { status: 500 }
    );
  }
}
