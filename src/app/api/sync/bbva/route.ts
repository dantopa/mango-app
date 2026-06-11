import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { callMcpTool, McpError } from "@/lib/sync/mcp-client";
import { adaptBbva } from "@/lib/sync/adapters/bbva";
import { processCandidates, recategorizeMonth } from "@/lib/sync/sync-engine";
import type { SyncRequest, SyncErrorResponse, SyncSourceResult } from "@/lib/sync/types";

export const maxDuration = 60;

/**
 * POST /api/sync/bbva
 * Body: { month: "2026-06" }
 * Auth: Supabase session cookie
 *
 * Flow:
 * 1. Verify user session
 * 2. Call browser-token-mcp: bbva_get_cards → list cards
 * 3. Per card: bbva_get_card_transactions → adaptBbva → processCandidates
 * 4. recategorizeMonth at the end
 * 5. Return { results: SyncSourceResult[] } (one per card)
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

    // Calculate date range for client-side filtering
    const [year, m] = month.split("-").map(Number);
    const lastDay = new Date(year, m, 0).getDate();
    const dateFrom = `${month}-01`;
    const dateTo = `${month}-${String(lastDay).padStart(2, "0")}`;

    // 3. Get cards
    const cards = (await callMcpTool("bbva_get_cards", {})) as Array<{
      id: string;
      brand: string;
      last4: string;
      name: string;
    }>;

    if (!Array.isArray(cards) || cards.length === 0) {
      return NextResponse.json(
        { error: "No se encontraron tarjetas BBVA", code: "MCP_ERROR" } satisfies SyncErrorResponse,
        { status: 502 }
      );
    }

    // 4. Per card: get transactions, adapt, process
    const results: SyncSourceResult[] = [];

    for (const card of cards) {
      const accountName = card.name; // "BBVA Visa" | "BBVA Mastercard"

      const rawTxs = (await callMcpTool("bbva_get_card_transactions", {
        card_id: card.id,
        date_from: dateFrom,
        date_to: dateTo,
      })) as Array<Record<string, unknown>>;

      const txs = Array.isArray(rawTxs) ? rawTxs : [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const candidates = adaptBbva(txs as any, accountName, card.last4);

      const result = await processCandidates(candidates, user.id, month);
      results.push(result);
    }

    // 5. Re-categorize & re-classify
    const recat = await recategorizeMonth(user.id, month);
    if (recat.updated > 0 || recat.classified > 0) {
      console.log(
        `[sync/bbva] recategorized: ${recat.updated} updated, ${recat.classified} reclassified`
      );
    }

    return NextResponse.json({ results });
  } catch (err) {
    if (err instanceof McpError) {
      return NextResponse.json(
        { error: err.message, code: err.code } satisfies SyncErrorResponse,
        { status: err.code === "AUTH_EXPIRED" ? 401 : 502 }
      );
    }

    console.error("[sync/bbva] error:", err);
    return NextResponse.json(
      { error: "Error interno del servidor", code: "MCP_ERROR" } satisfies SyncErrorResponse,
      { status: 500 }
    );
  }
}
