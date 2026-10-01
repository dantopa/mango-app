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

/** "YYYY-MM" of the current month in Bogotá. On Vercel the clock is UTC, so from 19:00 Bogotá `new Date()` is already tomorrow — and on the last day of a month, next month. */
export function currentBogotaMonth(nowMs: number = Date.now()): string {
  return epochToLocalDate(nowMs, TZ_OFFSETS.BOGOTA).slice(0, 7);
}

/** Today in Bogotá: day of month, days in the month and the month's first/last date (YYYY-MM-DD). */
export function bogotaMonthInfo(nowMs: number = Date.now()): {
  month: string;
  day: number;
  daysInMonth: number;
  start: string;
  end: string;
} {
  const today = epochToLocalDate(nowMs, TZ_OFFSETS.BOGOTA);
  const [y, m, d] = today.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const month = today.slice(0, 7);
  return { month, day: d, daysInMonth, start: `${month}-01`, end: `${month}-${String(daysInMonth).padStart(2, "0")}` };
}

/** The instants a Bogotá calendar month starts and ends, as UTC ISO strings (for timestamp columns). */
export function bogotaMonthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const offset = TZ_OFFSETS.BOGOTA * 3600_000;
  const from = Date.UTC(y, m - 1, 1) + offset;
  const to = Date.UTC(y, m, 1) + offset - 1;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}
