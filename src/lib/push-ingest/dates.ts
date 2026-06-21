/**
 * Centralized date helpers for push-ingest parsers.
 *
 * All parsers need to derive tx_date from a timestamp in the user's local
 * timezone. On Vercel the server clock is UTC, so `new Date()` gives the wrong
 * day for evening transactions. This module provides a single source of truth.
 */

/** Known timezone offsets (hours west of UTC) for supported regions. */
export const TZ_OFFSETS = {
  /** America/Bogota — UTC-5, no DST */
  BOGOTA: 5,
  /** America/Argentina/Buenos_Aires — UTC-3, no DST */
  BUENOS_AIRES: 3,
} as const;

export type TzOffset = (typeof TZ_OFFSETS)[keyof typeof TZ_OFFSETS];

/**
 * Convert epoch ms to YYYY-MM-DD in a fixed-offset timezone.
 *
 * @param epochMs - Unix timestamp in milliseconds
 * @param offsetHours - Hours west of UTC (e.g. 5 for Bogotá, 3 for Buenos Aires)
 */
export function epochToLocalDate(epochMs: number, offsetHours: TzOffset): string {
  const offsetMs = offsetHours * 60 * 60 * 1000;
  const local = new Date(epochMs - offsetMs);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Resolve tx_date from a push payload timestamp, falling back to Date.now()
 * if no timestamp is available (shouldn't happen, but defensive).
 *
 * @param payloadTimestamp - The `timestamp` field from PushPayload
 * @param offsetHours - Timezone offset (default: Bogotá)
 */
export function resolveTxDate(
  payloadTimestamp: number | string | undefined,
  offsetHours: TzOffset = TZ_OFFSETS.BOGOTA,
): string {
  const epochMs = typeof payloadTimestamp === "number"
    ? payloadTimestamp
    : typeof payloadTimestamp === "string"
      ? new Date(payloadTimestamp).getTime()
      : Date.now();
  return epochToLocalDate(epochMs, offsetHours);
}
