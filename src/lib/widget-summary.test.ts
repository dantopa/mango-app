import { describe, expect, it } from "vitest";

import { computeSemaphore } from "./push-ingest/semaphore";
import { buildWidgetSummary, cleanMerchant, whenLabel } from "./widget-summary";

// 2026-10-12 15:30 in Bogotá (UTC-5) — day 12 of 31.
const NOW = Date.parse("2026-10-12T20:30:00Z");

function summary(overrides: Partial<Parameters<typeof buildWidgetSummary>[0]> = {}) {
  return buildWidgetSummary({ monthAmounts: [1000, 184], ceiling: 3100, last: null, now: NOW, ...overrides });
}

describe("buildWidgetSummary", () => {
  it("sums the month and reads the semaphore exactly like the app does", () => {
    const s = summary();
    expect(s).toMatchObject({
      month: "2026-10",
      month_label: "Octubre",
      day: 12,
      days_in_month: 31,
      spent_usd: 1184,
      ceiling_usd: 3100,
    });
    // The widget must never disagree with the alert semaphore.
    const reference = computeSemaphore({ accumulated_spend: 1184, ceiling: 3100, current_day: 12, days_in_month: 31 });
    expect(s.state).toBe(reference.state);
    expect(s.state).toBe("verde");
    expect(s.pct).toBeCloseTo(1184 / 3100, 4);
    expect(s.expected_pct).toBeCloseTo(12 / 31, 4);
  });

  it("turns amarillo when spending runs ahead of the month, rojo past the ceiling", () => {
    expect(summary({ monthAmounts: [1300] }).state).toBe("amarillo");
    const over = summary({ monthAmounts: [3000, 200] });
    expect(over.state).toBe("rojo");
    expect(over.pct).toBeGreaterThan(1);
    expect(over.daily_available_usd).toBe(0);
  });

  it("splits what is left over the days left, counting today", () => {
    // (3100 - 1184) / (31 - 12 + 1) = 95.8
    expect(summary().daily_available_usd).toBe(95.8);
  });

  it("ignores refunds and zero rows in the month's spend", () => {
    expect(summary({ monthAmounts: [100, -40, 0, 20] }).spent_usd).toBe(120);
  });

  it("has no semaphore, bar or daily budget when no ceiling is configured", () => {
    for (const ceiling of [null, 0, -5]) {
      const s = summary({ ceiling });
      expect(s).toMatchObject({
        ceiling_usd: null,
        state: null,
        pct: null,
        expected_pct: null,
        daily_available_usd: null,
        spent_usd: 1184,
      });
    }
  });

  it("starts the month at zero, green, with the whole day's budget", () => {
    const first = buildWidgetSummary({
      monthAmounts: [],
      ceiling: 3100,
      last: null,
      now: Date.parse("2026-10-01T12:00:00Z"),
    });
    expect(first).toMatchObject({ day: 1, spent_usd: 0, state: "verde", daily_available_usd: 100 });
  });

  it("uses the Bogotá calendar: 22:00 on Sept 30 there is already Oct 1 in UTC", () => {
    const s = buildWidgetSummary({
      monthAmounts: [10],
      ceiling: 3000,
      last: null,
      now: Date.parse("2026-10-01T03:00:00Z"),
    });
    expect(s).toMatchObject({ month: "2026-09", month_label: "Septiembre", day: 30, days_in_month: 30 });
  });

  it("carries the last purchase, trimmed down to what a widget line can show", () => {
    const s = summary({
      last: { merchant: "  RAPPI \n COLOMBIA  ", amount_usd: 12.404, tx_date: "2026-10-12", created_at: "2026-10-12T19:32:10Z" },
    });
    expect(s.last).toEqual({ merchant: "RAPPI COLOMBIA", amount_usd: 12.4, when_label: "hoy 14:32" });
  });

  it("exposes nothing but the summary fields", () => {
    const keys = Object.keys(
      summary({ last: { merchant: "X", amount_usd: 1, tx_date: "2026-10-12", created_at: NOW.toString() } }),
    ).sort();
    expect(keys).toEqual(
      [
        "ceiling_usd", "daily_available_usd", "day", "days_in_month", "expected_pct", "generated_at",
        "last", "month", "month_label", "pct", "spent_usd", "state",
      ].sort(),
    );
  });
});

describe("whenLabel", () => {
  const at = (tx_date: string, created_at = "2026-10-12T19:32:00Z") => whenLabel({ tx_date, created_at }, NOW);

  it("gives the Bogotá wall-clock time for today's purchases", () => {
    expect(at("2026-10-12")).toBe("hoy 14:32");
    // 03:05Z is 22:05 the day before in Bogotá.
    expect(whenLabel({ tx_date: "2026-10-12", created_at: "2026-10-12T03:05:00Z" }, NOW)).toBe("hoy 22:05");
  });

  it("says ayer, then the date", () => {
    expect(at("2026-10-11")).toBe("ayer");
    expect(at("2026-10-03")).toBe("3 oct");
    expect(at("2026-09-30")).toBe("30 sep");
  });

  it("does not invent a time it cannot read", () => {
    expect(whenLabel({ tx_date: "2026-10-12", created_at: "garbage" }, NOW)).toBe("hoy");
  });
});

describe("cleanMerchant", () => {
  it("returns null for nothing worth showing", () => {
    expect(cleanMerchant(null)).toBeNull();
    expect(cleanMerchant("   \n ")).toBeNull();
  });

  it("flattens whitespace and control characters", () => {
    expect(cleanMerchant("A\u0000B\t\tC")).toBe("A B C");
  });

  it("caps the length with an ellipsis", () => {
    const long = cleanMerchant("X".repeat(100));
    expect(long).toHaveLength(40);
    expect(long?.endsWith("…")).toBe(true);
  });
});
