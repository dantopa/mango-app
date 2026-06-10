import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export const maxDuration = 300;

import { callMcpTool, McpError } from "@/lib/sync/mcp-client";
import { adaptBancolombia } from "@/lib/sync/adapters/bancolombia";
import { adaptNexo, type NexoRawTx } from "@/lib/sync/adapters/nexo";
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
    const allNexoTxs: NexoRawTx[] = [];
    let offset = 0;
    const limit = 100;
    let done = false;

    while (!done) {
      const rawData = await callMcpTool("nexo_get_card_transactions", {
        limit,
        offset,
      });
      const page = Array.isArray(rawData) ? rawData as NexoRawTx[] : [];
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

    const candidates = adaptNexo(allNexoTxs);
    const result = await processCandidates(candidates, OWNER_USER_ID, month);
    results.push(result);
  } catch (err) {
    const msg =
      err instanceof McpError ? err.message : err instanceof Error ? err.message : "Unknown error";
    errors.push({ source: "sync_nexo", error: msg });
  }

  // 5. Sync Gmail — loop cursor server-side until done
  {
    const { runGmailMonth } = await import("@/lib/sync/gmail/orchestrator");
    const { GmailAuthError } = await import("@/lib/sync/gmail/client");

    try {
      // Determine months to sync: current month + previous month if day <= 5
      const monthsToSync = [month];
      if (now.getDate() <= 5) {
        const prev = new Date(year, m - 2, 1);
        const prevMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
        monthsToSync.push(prevMonth);
      }

      for (const syncMonth of monthsToSync) {
        let cursor: import("@/lib/sync/gmail/types").GmailSyncCursor | null = null;
        while (true) {
          const response = await runGmailMonth(syncMonth, undefined, cursor, 20000);
          for (const r of response.results) {
            results.push(r);
          }
          if (!response.next) break;
          cursor = response.next;
        }
      }
    } catch (err) {
      if (err instanceof GmailAuthError) {
        errors.push({ source: "sync_gmail", error: "Gmail no conectado" });
      } else {
        const msg = err instanceof Error ? err.message : "Unknown error";
        errors.push({ source: "sync_gmail", error: msg });
      }
    }
  }

  // 6. Return summary
  return NextResponse.json({
    month,
    results,
    errors,
    total_inserted: results.reduce((sum, r) => sum + r.inserted, 0),
    total_duplicates: results.reduce((sum, r) => sum + r.duplicates, 0),
  });
}
