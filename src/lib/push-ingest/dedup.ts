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
  const { data, error } = await supabase
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
