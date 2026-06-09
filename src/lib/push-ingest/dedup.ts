import { createHash } from "crypto";

import { getSupabaseAdmin } from "./supabase-admin";
import type { PushPayload } from "./types";

/**
 * Normalize timestamp to epoch ms regardless of input format.
 * If ISO string, parse to epoch; if number, use directly.
 */
function toEpochMs(timestamp: number | string): number {
  if (typeof timestamp === "string") {
    return new Date(timestamp).getTime();
  }
  return timestamp;
}

/**
 * Compute dedup key: SHA-256 hash of (packageName + title + text + minute-truncated timestamp).
 * Returns first 32 hex characters for brevity.
 */
export function computeDedupKey(payload: PushPayload): string {
  const epochMs = toEpochMs(payload.timestamp);
  const minuteTruncated = Math.floor(epochMs / 60000);
  const input = `${payload.packageName}|${payload.title}|${payload.text}|${minuteTruncated}`;
  const hash = createHash("sha256").update(input).digest("hex");
  return hash.slice(0, 32);
}

/**
 * Check if dedup_key already exists in push_ingest_log (query by PK).
 */
export async function isDuplicate(dedupKey: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  // Cast needed: push_ingest_log not yet in generated database.types.ts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("push_ingest_log")
    .select("dedup_key")
    .eq("dedup_key", dedupKey)
    .limit(1)
    .maybeSingle();

  if (error) {
    // If table doesn't exist or query fails, treat as not duplicate (fail open)
    console.error("[dedup] isDuplicate query error:", error.message);
    return false;
  }

  return data !== null;
}

/**
 * Cross-source dedup: find a transaction from a DIFFERENT package
 * with the same amount within a 2-minute window.
 * Returns the existing dedup_key and merchant if found, null otherwise.
 */
export async function findCrossSourceDuplicate(
  amountNative: number,
  excludePackage: string,
  timestamp: Date,
): Promise<{ dedup_key: string; merchant: string | null } | null> {
  const supabase = getSupabaseAdmin();

  const windowMs = 2 * 60 * 1000; // 2 minutes
  const start = new Date(timestamp.getTime() - windowMs).toISOString();
  const end = new Date(timestamp.getTime() + windowMs).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any)
    .from("push_ingest_log")
    .select("dedup_key, merchant")
    .eq("amount_native", amountNative)
    .neq("package_name", excludePackage)
    .eq("status", "registered")
    .gte("created_at", start)
    .lte("created_at", end)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[dedup] findCrossSourceDuplicate query error:", error.message);
    return null;
  }

  if (!data) return null;

  return { dedup_key: data.dedup_key, merchant: data.merchant };
}
