import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { executePipeline } from "@/lib/push-ingest/pipeline";
import { getSupabaseAdmin } from "@/lib/push-ingest/supabase-admin";
import type { PushPayload } from "@/lib/push-ingest/types";
import type { SyncSourceResult } from "@/lib/sync/types";

/**
 * POST /api/sync/notifications
 *
 * Reprocesses unprocessed notifications from push_raw_log.
 * Picks entries that have a registered parser but no matching push_ingest_log entry.
 * Body: { month: "YYYY-MM" }
 */
export async function POST(request: Request): Promise<NextResponse> {
  // Auth check
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

  // Calculate month range for filtering by received_at
  const [year, mon] = month.split("-").map(Number);
  const monthStart = new Date(year, mon - 1, 1).toISOString();
  const monthEnd = new Date(year, mon, 0, 23, 59, 59).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = getSupabaseAdmin() as any;

  // Get all raw logs for the month that have parseable package names
  const PARSEABLE_PACKAGES = [
    "com.google.android.apps.walletnfcrel",
    "com.todo1.mobile",
    "com.bbva.nxt_argentina",
    "com.grability.rappi",
    "com.nexowallet",
    "com.google.android.apps.messaging",   // SMS (Google Messages)
    "com.samsung.android.messaging",       // SMS (Samsung Messages)
    "com.android.mms",                     // SMS (AOSP)
  ];

  const { data: rawLogs, error: fetchError } = await admin
    .from("push_raw_log")
    .select("id, package_name, payload, received_at")
    .in("package_name", PARSEABLE_PACKAGES)
    .gte("received_at", monthStart)
    .lte("received_at", monthEnd)
    .order("received_at", { ascending: true });

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  const result: SyncSourceResult = {
    source: "sync_notifications",
    found: rawLogs?.length ?? 0,
    inserted: 0,
    duplicates: 0,
    needs_review: 0,
    errors: [],
  };

  for (const log of rawLogs ?? []) {
    try {
      // Normalize the payload to match PushPayload type
      const raw = log.payload as Record<string, unknown>;
      const payload: PushPayload = {
        packageName: String(raw.packageName ?? log.package_name),
        title: String(raw.title ?? ""),
        text: String(raw.text ?? ""),
        timestamp: (raw.postedAt as number) ?? (raw.timestamp as number) ?? Date.now(),
      };

      const pipelineResult = await executePipeline(payload, "full_pipeline");

      switch (pipelineResult.status) {
        case "registered":
          result.inserted++;
          break;
        case "duplicate":
        case "deduped_cross_source":
          result.duplicates++;
          break;
        case "no_parser":
          // Skip silently
          break;
        case "fx_pending":
          result.needs_review++;
          break;
        case "registration_failed":
          result.errors.push(pipelineResult.error);
          break;
      }
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : "unknown error");
    }
  }

  return NextResponse.json({ result });
}
