import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export const maxDuration = 300;

import { validateBearer } from "@/lib/push-ingest/auth";
import { runGmailMonth } from "@/lib/sync/gmail/orchestrator";
import { recategorizeMonth } from "@/lib/sync/sync-engine";
import { GmailAuthError } from "@/lib/sync/gmail/client";
import type { GmailSyncCursor } from "@/lib/sync/gmail/types";
import type { SyncSourceResult } from "@/lib/sync/types";

const OWNER_USER_ID = "e99371b1-6163-4216-b624-c79d8ee01520";

/**
 * GET /api/sync/cron
 * Auth: Bearer SYNC_CRON_SECRET
 *
 * Runs Gmail sync for the current month (and previous month if day <= 5).
 * Compatible with Vercel Cron Jobs.
 *
 * Note: Bancolombia API and Nexo MCP sources are NOT included here because
 * their tokens expire in ~10 min and require manual trigger via the sync dialog.
 */
export async function GET(request: NextRequest) {
  // 1. Verify cron auth — constant-time, so the token cannot be recovered
  // character by character from response timings.
  const auth = validateBearer(request.headers.get("authorization"), process.env.SYNC_CRON_SECRET);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Determine current month
  const now = new Date();
  const year = now.getFullYear();
  const m = now.getMonth() + 1;
  const month = `${year}-${String(m).padStart(2, "0")}`;

  const results: SyncSourceResult[] = [];
  const errors: Array<{ source: string; error: string }> = [];

  // 3. Sync Gmail — loop cursor server-side until done
  try {
    // Determine months to sync: current month + previous month if day <= 5
    const monthsToSync = [month];
    if (now.getDate() <= 5) {
      const prev = new Date(year, m - 2, 1);
      const prevMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
      monthsToSync.push(prevMonth);
    }

    for (const syncMonth of monthsToSync) {
      let cursor: GmailSyncCursor | null = null;
      while (true) {
        const response = await runGmailMonth(syncMonth, undefined, cursor, 20000);
        for (const r of response.results) {
          results.push(r);
        }
        if (!response.next) break;
        cursor = response.next;
      }

      // Mop-up pass: every other sync trigger (manual Gmail, Nexo, BBVA,
      // Bancolombia) calls this after its month is fully paged, but the daily
      // cron never did — so a transaction that missed categorization the first
      // time (AI call cap, a rule that only got created later) had no route
      // back to it and stayed "Sin categoría" forever, since the cron is the
      // only thing that actually keeps this source syncing day to day.
      try {
        const recat = await recategorizeMonth(OWNER_USER_ID, syncMonth);
        if (recat.updated > 0 || recat.classified > 0) {
          console.log(`[sync/cron] recategorized ${syncMonth}: ${recat.updated} updated, ${recat.classified} reclassified`);
        }
      } catch (err) {
        console.error(`[sync/cron] recategorizeMonth failed for ${syncMonth}:`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    if (err instanceof GmailAuthError) {
      errors.push({ source: "sync_gmail", error: "Gmail no conectado — reconectar OAuth" });
    } else {
      const msg = err instanceof Error ? err.message : "Unknown error";
      errors.push({ source: "sync_gmail", error: msg });
    }
  }

  // 4. Return summary
  return NextResponse.json({
    month,
    results,
    errors,
    total_inserted: results.reduce((sum, r) => sum + r.inserted, 0),
    total_duplicates: results.reduce((sum, r) => sum + r.duplicates, 0),
  });
}
