import { createHash } from "crypto";

import { z } from "zod";

import { getSupabaseAdmin } from "./supabase-admin";

/**
 * Per-device ingest tokens.
 *
 * The Android app generates its own bearer token and a one-time pairing code,
 * and sends only their SHA-256 digests. Enrolling therefore needs no session —
 * the row it creates belongs to nobody and authenticates nothing. A signed-in
 * browser then posts the pairing code plaintext, which is what binds the row to
 * a user and makes the token live.
 *
 * The consequence worth keeping in mind: the token exists in exactly one place,
 * the phone. It cannot be recovered from here, only replaced by re-pairing.
 */

/** Long enough that a leaked expired code is worthless, short enough to survive a URL fragment. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** Bounds the writes caused by touching a device on every single ingest request. */
const LAST_USED_STALE_MS = 60 * 60 * 1000;

/** Everything the app sends is 32 bytes hex — a digest or a code — and never trusted. */
const hex32BytesSchema = z.string().regex(/^[0-9a-f]{64}$/, "expected 32 bytes of hex");

export const enrollSchema = z.object({
  token_hash: hex32BytesSchema,
  pairing_code_hash: hex32BytesSchema,
  label: z.string().trim().min(1).max(80),
});

export const pairSchema = z.object({
  code: hex32BytesSchema,
});

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

export type EnrolledDevice = { id: string; pairing_expires_at: string };

/**
 * Creates or resets the row for a phone. Keyed on token_hash so re-pairing the
 * same phone updates its row instead of leaving an orphan; the reset clears the
 * ownership, so a device stops working the moment you start re-pairing it and
 * only comes back when the new code is approved.
 */
export async function enrollDevice(
  input: z.infer<typeof enrollSchema>,
  now: Date,
): Promise<EnrolledDevice | null> {
  const supabase = getSupabaseAdmin();

  // Abandoned enrolments are the only garbage this table can accumulate, and
  // they are only reachable from here, so this is the place to drop them.
  await supabase
    .from("push_ingest_devices")
    .delete()
    .is("user_id", null)
    .lt("pairing_expires_at", now.toISOString());

  const pairingExpiresAt = new Date(now.getTime() + PAIRING_TTL_MS).toISOString();

  const { data, error } = await supabase
    .from("push_ingest_devices")
    .upsert(
      {
        user_id: null,
        label: input.label,
        token_hash: input.token_hash,
        pairing_code_hash: input.pairing_code_hash,
        pairing_expires_at: pairingExpiresAt,
        paired_at: null,
        revoked_at: null,
      },
      { onConflict: "token_hash" },
    )
    .select("id, pairing_expires_at")
    .single();

  if (error || !data?.pairing_expires_at) {
    console.error("[push-ingest] device enroll failed:", error?.message);
    return null;
  }

  return { id: data.id, pairing_expires_at: data.pairing_expires_at };
}

export type PairedDevice = { id: string; label: string };

/**
 * Binds a pending enrolment to a user. Returns null for a code that is unknown,
 * expired or already used — the caller must not distinguish between them, or the
 * endpoint becomes an oracle for guessing codes.
 */
export async function pairDevice(
  code: string,
  userId: string,
  now: Date,
): Promise<PairedDevice | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("push_ingest_devices")
    .update({
      user_id: userId,
      paired_at: now.toISOString(),
      // One-time: clearing it is what stops the code from being replayed.
      pairing_code_hash: null,
      pairing_expires_at: null,
      revoked_at: null,
    })
    .eq("pairing_code_hash", sha256Hex(code))
    .is("user_id", null)
    .gt("pairing_expires_at", now.toISOString())
    .select("id, label")
    .maybeSingle();

  if (error) {
    console.error("[push-ingest] device pairing failed:", error.message);
    return null;
  }

  return data ?? null;
}

export type AuthenticatedDevice = { id: string; userId: string };

/**
 * Resolves a bearer token to its paired device, or null. A row is only usable
 * once it has an owner and has not been revoked, so an enrolment that was never
 * approved is rejected here without a special case.
 */
export async function authenticateDevice(
  token: string,
  now: Date,
): Promise<AuthenticatedDevice | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("push_ingest_devices")
    .select("id, user_id, last_used_at")
    .eq("token_hash", sha256Hex(token))
    .not("user_id", "is", null)
    .is("revoked_at", null)
    .maybeSingle();

  if (error) {
    console.error("[push-ingest] device lookup failed:", error.message);
    return null;
  }
  if (!data?.user_id) return null;

  if (isLastUsedStale(data.last_used_at, now)) {
    await supabase
      .from("push_ingest_devices")
      .update({ last_used_at: now.toISOString() })
      .eq("id", data.id);
  }

  return { id: data.id, userId: data.user_id };
}

/** Exported for the tests: the throttle is the only reason last_used_at is approximate. */
export function isLastUsedStale(lastUsedAt: string | null, now: Date): boolean {
  if (!lastUsedAt) return true;
  return now.getTime() - new Date(lastUsedAt).getTime() > LAST_USED_STALE_MS;
}
