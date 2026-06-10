import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { callMcpTool, McpError } from "@/lib/sync/mcp-client";
import { adaptBancolombia } from "@/lib/sync/adapters/bancolombia";
import { adaptNexo } from "@/lib/sync/adapters/nexo";
import { processCandidates } from "@/lib/sync/sync-engine";
import type { SyncSourceResult } from "@/lib/sync/types";

const OWNER_USER_ID =
  process.env.MAQUINITA_OWNER_USER_ID ??
  "49b33f55-dcf2-4370-ba9a-204b91f2551d";

/**
 * GET /api/sync/cron
 * Auth: Bearer SYNC_CRON_SECRET
 *
 * Runs sync for all sources for the current month.
 * Compatible with Vercel Cron Jobs.
 */
export async function GET(request: NextRequest) {
  // 1. Verify cron auth
  const authHeader = request.headers.get("authorization");
  const expectedToken = process.env.SYNC_CRON_SECRET;

  if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Determine current month
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [year, m] = month.split("-").map(Number);
  const lastDay = new Date(year, m, 0).getDate();

  // Nexo uses YYYY-MM-DD, Bancolombia uses YYYY/MM/DD
  const startDate = `${month}-01`;
  const endDate = `${month}-${String(lastDay).padStart(2, "0")}`;
  const dateFromBC = `${year}/${String(m).padStart(2, "0")}/01`;
  const dateToBC = `${year}/${String(m).padStart(2, "0")}/${String(lastDay).padStart(2, "0")}`;

  const results: SyncSourceResult[] = [];
  const errors: Array<{ source: string; error: string }> = [];

  // 3. Sync Bancolombia — get account number dynamically
  try {
    const accountsData = await callMcpTool("bancolombia_get_accounts", {}) as {
      accounts?: Array<{ number: string; type: string }>;
    };

    const savingsAccount = accountsData?.accounts?.find(
      (a) => a.type === "CUENTA_DE_AHORRO" || a.type?.toLowerCase().includes("ahorro")
    );

    if (!savingsAccount?.number) {
      errors.push({ source: "sync_bancolombia", error: "No se encontró cuenta de ahorros" });
    } else {
      const rawData = await callMcpTool("bancolombia_get_transactions", {
        account_number: savingsAccount.number,
        date_from: dateFromBC,
        date_to: dateToBC,
      });
      const rawTxs = Array.isArray(rawData) ? rawData : [];
      const candidates = adaptBancolombia(rawTxs);
      const result = await processCandidates(candidates, OWNER_USER_ID, month);
      results.push(result);
    }
  } catch (err) {
    const msg =
      err instanceof McpError ? err.message : err instanceof Error ? err.message : "Unknown error";
    errors.push({ source: "sync_bancolombia", error: msg });
  }

  // 4. Sync Nexo — paginate until we cover the month
  try {
    const allNexoTxs: Array<Record<string, unknown>> = [];
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
        if (txDate >= startDate && txDate <= endDate) {
          allNexoTxs.push(tx);
        } else if (txDate < startDate) {
          done = true;
          break;
        }
      }

      if (!done && page.length === limit) {
        offset += limit;
      } else {
        break;
      }
    }

    const candidates = adaptNexo(allNexoTxs as any);
    const result = await processCandidates(candidates, OWNER_USER_ID, month);
    results.push(result);
  } catch (err) {
    const msg =
      err instanceof McpError ? err.message : err instanceof Error ? err.message : "Unknown error";
    errors.push({ source: "sync_nexo", error: msg });
  }

  // 5. Return summary
  return NextResponse.json({
    month,
    results,
    errors,
    total_inserted: results.reduce((sum, r) => sum + r.inserted, 0),
    total_duplicates: results.reduce((sum, r) => sum + r.duplicates, 0),
  });
}
