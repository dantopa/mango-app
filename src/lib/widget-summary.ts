import { bogotaMonthInfo, epochToLocalDate, shiftDate, TZ_OFFSETS } from "./push-ingest/dates";
import { computeSemaphore } from "./push-ingest/semaphore";
import type { SemaphoreState } from "./push-ingest/types";

/**
 * What the Android home-screen widget shows, and nothing else.
 *
 * The widget authenticates with the phone's ingest token — a credential that
 * until now could only write notifications — so this is deliberately the
 * smallest summary that makes the widget useful: five numbers and the name of
 * the last purchase. No transaction list, no descriptions, no accounts.
 *
 * The month's spend is computed exactly like the budget semaphore the app and
 * the push alerts use (active rows, not payments, positive USD, Bogotá month),
 * so the widget can never disagree with them.
 */

export type WidgetSummary = {
  /** "2026-10", Bogotá. */
  month: string;
  /** "Octubre". */
  month_label: string;
  day: number;
  days_in_month: number;
  spent_usd: number;
  /** Null when no budget ceiling is configured. */
  ceiling_usd: number | null;
  state: SemaphoreState | null;
  /** Share of the ceiling spent; above 1 once it is exceeded. */
  pct: number | null;
  /** Share of the month elapsed: where the spend would be on an even pace. */
  expected_pct: number | null;
  /** (ceiling − spent) / days left including today, never negative. */
  daily_available_usd: number | null;
  last: WidgetLastExpense | null;
  generated_at: string;
};

export type WidgetLastExpense = {
  merchant: string | null;
  amount_usd: number;
  /** "hoy 14:32", "ayer" or "3 oct". */
  when_label: string;
};

export type LastExpenseRow = {
  merchant: string | null;
  amount_usd: number;
  tx_date: string;
  created_at: string;
};

const MONTHS = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];

const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** The longest merchant name worth putting on a widget line. */
const MAX_MERCHANT_LENGTH = 40;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A merchant as a single readable line, or null when there is nothing to show. */
export function cleanMerchant(merchant: string | null | undefined): string | null {
  // Control characters and runs of whitespace come from bank text, not from people.
  const text = (merchant ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > MAX_MERCHANT_LENGTH ? `${text.slice(0, MAX_MERCHANT_LENGTH - 1)}…` : text;
}

/** "hoy 14:32" for today's purchases, "ayer", or "3 oct" — all in Bogotá time. */
export function whenLabel(row: Pick<LastExpenseRow, "tx_date" | "created_at">, nowMs: number): string {
  const today = epochToLocalDate(nowMs, TZ_OFFSETS.BOGOTA);
  if (row.tx_date === today) {
    const registered = new Date(row.created_at).getTime();
    if (Number.isNaN(registered)) return "hoy";
    // The wall clock in Bogotá: shift by the offset, then read it as UTC.
    return `hoy ${new Date(registered - TZ_OFFSETS.BOGOTA * 3600_000).toISOString().slice(11, 16)}`;
  }
  if (row.tx_date === shiftDate(today, -1)) return "ayer";
  const [, m, d] = row.tx_date.split("-").map(Number);
  return `${d} ${MONTHS_SHORT[m - 1] ?? ""}`.trim();
}

export function buildWidgetSummary(input: {
  /** amount_usd of every active, non-payment expense of the month. */
  monthAmounts: readonly number[];
  ceiling: number | null;
  last: LastExpenseRow | null;
  now: number;
}): WidgetSummary {
  const { monthAmounts, last, now } = input;
  const info = bogotaMonthInfo(now);
  const spent = monthAmounts.reduce((sum, amount) => sum + (amount > 0 ? amount : 0), 0);
  const ceiling = input.ceiling !== null && input.ceiling > 0 ? input.ceiling : null;

  const semaphore =
    ceiling === null
      ? null
      : computeSemaphore({
          accumulated_spend: spent,
          ceiling,
          current_day: info.day,
          days_in_month: info.daysInMonth,
        });

  const remainingDays = info.daysInMonth - info.day + 1; // today counts
  const daily = ceiling === null ? null : Math.max(0, (ceiling - spent) / remainingDays);

  return {
    month: info.month,
    month_label: MONTHS[Number(info.month.slice(5, 7)) - 1] ?? info.month,
    day: info.day,
    days_in_month: info.daysInMonth,
    spent_usd: round2(spent),
    ceiling_usd: ceiling === null ? null : round2(ceiling),
    state: semaphore?.state ?? null,
    pct: semaphore ? Math.round(semaphore.pct * 10_000) / 10_000 : null,
    expected_pct: semaphore ? Math.round(semaphore.expected_pct * 10_000) / 10_000 : null,
    daily_available_usd: daily === null ? null : round2(daily),
    last: last
      ? { merchant: cleanMerchant(last.merchant), amount_usd: round2(last.amount_usd), when_label: whenLabel(last, now) }
      : null,
    generated_at: new Date(now).toISOString(),
  };
}
