import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { executePipeline } from "@/lib/push-ingest/pipeline";
import { computeDedupKey } from "@/lib/push-ingest/dedup";
import { getSupabaseAdmin } from "@/lib/push-ingest/supabase-admin";
import { PACKAGE_WHITELIST } from "@/lib/push-ingest/package-whitelist";
import type { PushPayload } from "@/lib/push-ingest/types";
import type { SyncSourceResult, SyncItemDetail } from "@/lib/sync/types";

/**
 * POST /api/sync/notifications
 *
 * Replays notifications stored in push_raw_log through the ingest pipeline.
 * Body: { month: "YYYY-MM", force?: boolean }
 *
 * Without `force` only notifications that were never ingested are processed.
 * With `force`, rows a previous run left in a retryable state are processed
 * again — this is how the ingest failures of a month get recovered after a
 * parser fix. Rows that already produced a transaction are never touched.
 */

/** Ingest-log states a reprocess may take over. Anything else is a settled row. */
const RETRYABLE_STATUSES = new Set([
  "registration_failed",
  "no_parser",
  "fx_pending",
  "processing",
  "pending_cleanup",
]);

const MS_PER_DAY = 86_400_000;

export async function POST(request: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const month: string = body.month; // "YYYY-MM"
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "invalid month" }, { status: 400 });
  }
  const force = body.force === true;

  // Month range for filtering by received_at
  const [year, mon] = month.split("-").map(Number);
  const monthStart = new Date(year, mon - 1, 1);
  const monthEnd = new Date(year, mon, 0, 23, 59, 59);

  // A notification received in June is about a June purchase, so the live-ingest
  // window (60 days) would reject it as too old. Allow anything back to the start
  // of the month being replayed, plus a week for late-arriving notifications.
  const maxPastDays = Math.ceil((Date.now() - monthStart.getTime()) / MS_PER_DAY) + 7;

  const admin = getSupabaseAdmin();

  const { data: rawLogs, error: fetchError } = await admin
    .from("push_raw_log")
    .select("id, package_name, payload, received_at")
    .in("package_name", [...PACKAGE_WHITELIST])
    .gte("received_at", monthStart.toISOString())
    .lte("received_at", monthEnd.toISOString())
    .order("received_at", { ascending: true });

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  const jobs = (rawLogs ?? []).map((log) => {
    const raw = (log.payload ?? {}) as Record<string, unknown>;
    const payload: PushPayload = {
      packageName: String(raw.packageName ?? log.package_name),
      title: String(raw.title ?? ""),
      text: String(raw.text ?? ""),
      timestamp: (raw.postedAt as number) ?? (raw.timestamp as number) ?? Date.now(),
    };
    return { log, payload, dedupKey: computeDedupKey(payload) };
  });

  // One query for the whole batch instead of a lookup per notification.
  const existingByKey = new Map<string, { status: string; transaction_id: string | null }>();
  if (jobs.length > 0) {
    const { data: logs, error: logsError } = await admin
      .from("push_ingest_log")
      .select("dedup_key, status, transaction_id")
      .in("dedup_key", jobs.map((j) => j.dedupKey));
    if (logsError) {
      return NextResponse.json({ error: logsError.message }, { status: 500 });
    }
    for (const row of logs ?? []) {
      existingByKey.set(row.dedup_key, {
        status: row.status,
        transaction_id: row.transaction_id,
      });
    }
  }

  const result: SyncSourceResult = {
    source: "sync_notifications",
    found: jobs.length,
    inserted: 0,
    duplicates: 0,
    needs_review: 0,
    errors: [],
    items: [],
  };
  let skipped = 0;
  let reprocessed = 0;

  const detail = (
    job: (typeof jobs)[number],
    status: SyncItemDetail["status"],
  ): SyncItemDetail => ({
    merchant: (job.payload.title || job.payload.text).substring(0, 50),
    amount: 0, // the pipeline result does not carry the parsed amount back
    currency: "COP",
    date: new Date(job.log.received_at).toISOString().substring(0, 10),
    status,
  });

  for (const job of jobs) {
    const existing = existingByKey.get(job.dedupKey);

    if (existing) {
      const retryable =
        existing.transaction_id === null && RETRYABLE_STATUSES.has(existing.status);
      // Settled rows (registered, ignored, deduped…) are left exactly as they are.
      if (!force || !retryable) {
        result.duplicates++;
        skipped++;
        continue;
      }
      reprocessed++;
    }
    // Only an already-existing row has to be taken over from a previous run.
    const forceThis = existing !== undefined;

    try {
      const pipelineResult = await executePipeline(job.payload, "full_pipeline", {
        maxPastDays,
        force: forceThis,
      });

      switch (pipelineResult.status) {
        case "registered":
          result.inserted++;
          result.items!.push(detail(job, "inserted"));
          break;
        case "duplicate":
        case "deduped_cross_source":
        case "deduped_wallet_echo":
          result.duplicates++;
          result.items!.push(detail(job, "duplicate"));
          break;
        case "no_parser":
        case "ignored":
        case "logged":
          // Not financial, or deliberately not an expense — nothing to report.
          break;
        case "fx_pending":
          result.needs_review++;
          result.items!.push(detail(job, "review"));
          break;
        case "registration_failed":
          result.errors.push(pipelineResult.error);
          result.items!.push(detail(job, "error"));
          break;
      }
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : "unknown error");
      result.items!.push(detail(job, "error"));
    }
  }

  return NextResponse.json({ result, reprocessed, skipped });
}
