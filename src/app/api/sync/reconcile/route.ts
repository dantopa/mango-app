import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { validateBearer } from "@/lib/push-ingest/auth";
import { getSupabaseAdmin } from "@/lib/push-ingest/supabase-admin";
import { epochToLocalDate, TZ_OFFSETS } from "@/lib/push-ingest/dates";
import { reconcileRange, shiftDate } from "@/lib/reconcile/run";

export const maxDuration = 60;

const OWNER_USER_ID = "e99371b1-6163-4216-b624-c79d8ee01520";

/** Default look-back: notifications race each other within minutes, releases within days. */
const DEFAULT_DAYS = 7;
const MAX_DAYS = 62;

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/sync/reconcile
 * Auth: Bearer SYNC_CRON_SECRET
 *
 * Re-evaluates duplicates, released pre-authorizations and internal transfers
 * over the last `days` days (default 7), or over `from`..`to`. The push
 * pipeline already reconciles on every insert; this catches what raced past it.
 * `dry_run=1` reports what would change without writing.
 */
export async function GET(request: NextRequest) {
  const auth = validateBearer(request.headers.get("authorization"), process.env.SYNC_CRON_SECRET);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const today = epochToLocalDate(Date.now(), TZ_OFFSETS.BOGOTA);
  const days = Math.min(Math.max(Number(params.get("days") ?? DEFAULT_DAYS) || DEFAULT_DAYS, 1), MAX_DAYS);
  const from = params.get("from") ?? shiftDate(today, -(days - 1));
  const to = params.get("to") ?? today;
  if (!RE_DATE.test(from) || !RE_DATE.test(to) || from > to) {
    return NextResponse.json({ error: "from/to must be YYYY-MM-DD with from <= to" }, { status: 400 });
  }

  try {
    const report = await reconcileRange(getSupabaseAdmin(), OWNER_USER_ID, {
      from,
      to,
      trigger: "job",
      dryRun: params.get("dry_run") === "1",
    });
    return NextResponse.json({
      run_id: report.runId,
      from,
      to,
      dry_run: report.dryRun,
      changes: report.changes.map(({ id, rule, ref_id, from: before, to: after, detail }) => ({
        id,
        rule,
        ref_id,
        from: before.status,
        to: after.status,
        detail,
      })),
      review_flags: report.reviewFlags,
      spend_delta_usd: report.spendDeltaUsd,
      income_delta_usd: report.incomeDeltaUsd,
      errors: report.errors,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sync/reconcile]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
