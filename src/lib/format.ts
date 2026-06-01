/** Currency / number / date formatting helpers (es-AR locale, USD-first). */

const LOCALE = "es-AR";

export function formatUsd(value: number, opts?: { compact?: boolean; sign?: boolean }): string {
  return new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency: "USD",
    notation: opts?.compact ? "compact" : "standard",
    maximumFractionDigits: opts?.compact ? 1 : value % 1 === 0 ? 0 : 2,
    signDisplay: opts?.sign ? "exceptZero" : "auto",
  }).format(value);
}

/** Format an amount in its native currency (no fixed currency symbol coupling). */
export function formatNative(value: number, currency: string): string {
  // Crypto / stablecoin codes are not ISO currencies — render as plain number + code.
  const isoLike = /^[A-Z]{3}$/.test(currency) && currency !== "USDT";
  if (!isoLike) {
    return `${new Intl.NumberFormat(LOCALE, {
      maximumFractionDigits: 2,
    }).format(value)} ${currency}`;
  }
  try {
    return new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${new Intl.NumberFormat(LOCALE).format(value)} ${currency}`;
  }
}

export function formatPercent(value: number, opts?: { sign?: boolean }): string {
  return new Intl.NumberFormat(LOCALE, {
    style: "percent",
    maximumFractionDigits: 1,
    signDisplay: opts?.sign ? "exceptZero" : "auto",
  }).format(value);
}

/** "2026-05-31" -> "may 2026" */
export function formatMonth(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date + "T00:00:00") : date;
  return new Intl.DateTimeFormat(LOCALE, { month: "short", year: "numeric" }).format(d);
}

/** "2026-05-31" -> "31 may" */
export function formatDay(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date + "T00:00:00") : date;
  return new Intl.DateTimeFormat(LOCALE, { day: "2-digit", month: "short" }).format(d);
}

/** "2026-05-31" -> "31 may 2026" */
export function formatDate(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date + "T00:00:00") : date;
  return new Intl.DateTimeFormat(LOCALE, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d);
}
