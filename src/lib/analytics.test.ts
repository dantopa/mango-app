import { describe, it, expect } from "vitest";
import {
  netWorthByDate,
  netWorthComposition,
  netWorthSummary,
  recentMonthlyPace,
  previousMonthKey,
  daysInMonthKey,
} from "./analytics";
import type { Account, NetWorthSnapshot } from "./types";

function snapshot(accountId: string, date: string, usd: number): NetWorthSnapshot {
  return {
    id: `${accountId}-${date}`,
    account_id: accountId,
    snapshot_date: date,
    balance_usd: usd,
    balance_native: usd,
    native_currency: "USD",
    fx_rate_to_usd: 1,
    is_pending: false,
    notes: null,
    created_at: `${date}T12:00:00Z`,
    user_id: "u1",
  };
}

function account(id: string, name: string): Account {
  return {
    id,
    name,
    type: "bank",
    native_currency: "USD",
    card_digits: [],
    country: null,
    payment_type: null,
    is_active: true,
    created_at: "2025-12-01T00:00:00Z",
    user_id: "u1",
  };
}

describe("netWorthByDate", () => {
  it("carries a balance forward to dates where that account was not reloaded", () => {
    // The shape of the real data: one account is loaded on a date, the other is
    // not. Summing each date's own rows would report 300 then 700, i.e. a jump
    // that never happened.
    const series = netWorthByDate([
      snapshot("a", "2026-01-31", 1000),
      snapshot("b", "2026-01-31", 300),
      snapshot("a", "2026-02-28", 1100),
      snapshot("b", "2026-03-31", 400),
    ]);

    expect(series).toEqual([
      { date: "2026-01-31", total: 1300 },
      { date: "2026-02-28", total: 1400 },
      { date: "2026-03-31", total: 1500 },
    ]);
  });

  it("only counts an account from its first snapshot onwards", () => {
    // A new account is not retroactive: its earlier balance is unknown, not zero.
    const series = netWorthByDate([
      snapshot("a", "2026-01-31", 1000),
      snapshot("a", "2026-02-28", 1000),
      snapshot("b", "2026-02-28", 500),
    ]);

    expect(series.map((p) => p.total)).toEqual([1000, 1500]);
  });

  it("returns dates ascending regardless of input order", () => {
    const series = netWorthByDate([
      snapshot("a", "2026-03-31", 3),
      snapshot("a", "2026-01-31", 1),
      snapshot("a", "2026-02-28", 2),
    ]);
    expect(series.map((p) => p.date)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("returns an empty series with no snapshots", () => {
    expect(netWorthByDate([])).toEqual([]);
  });
});

describe("netWorthComposition", () => {
  it("keeps each account's stack at its last known balance", () => {
    const { data, accountNames } = netWorthComposition(
      [
        snapshot("a", "2026-01-31", 1000),
        snapshot("b", "2026-01-31", 300),
        snapshot("a", "2026-02-28", 1100),
      ],
      [account("a", "Nexo"), account("b", "Wise")],
    );

    expect(accountNames).toEqual(["Nexo", "Wise"]);
    expect(data).toEqual([
      { date: "2026-01-31", Nexo: 1000, Wise: 300 },
      { date: "2026-02-28", Nexo: 1100, Wise: 300 },
    ]);
  });

  it("merges accounts that resolve to the same label", () => {
    const { data } = netWorthComposition(
      [snapshot("a", "2026-01-31", 10), snapshot("b", "2026-01-31", 5)],
      [],
    );
    expect(data).toEqual([{ date: "2026-01-31", "—": 15 }]);
  });
});

describe("netWorthSummary", () => {
  const monthly = [
    snapshot("a", "2026-05-31", 1000),
    snapshot("a", "2026-06-30", 1200),
    snapshot("a", "2026-07-31", 1500),
  ];

  it("compares against a month earlier, not against the previous row", () => {
    // Two snapshots a day apart used to make "vs mes anterior" a one-day delta.
    const summary = netWorthSummary([...monthly, snapshot("a", "2026-08-01", 1510)]);

    expect(summary.current).toBe(1510);
    expect(summary.previous).toBe(1200); // 2026-06-30, the last date <= 2026-07-01
    expect(summary.changeAbs).toBe(310);
  });

  it("uses an exact month-end anchor when one exists", () => {
    const summary = netWorthSummary(monthly);
    expect(summary.previous).toBe(1200);
    expect(summary.changePct).toBeCloseTo(0.25);
  });

  it("reports no comparison until a month of history exists", () => {
    const summary = netWorthSummary([
      snapshot("a", "2026-07-30", 1000),
      snapshot("a", "2026-07-31", 1100),
    ]);

    expect(summary.current).toBe(1100);
    expect(summary.previous).toBeNull();
    expect(summary.changeAbs).toBeNull();
    expect(summary.changePct).toBeNull();
  });

  it("clamps the anchor day when the previous month is shorter", () => {
    const summary = netWorthSummary([
      snapshot("a", "2026-02-28", 100),
      snapshot("a", "2026-03-31", 200),
    ]);
    // 2026-03-31 minus one month clamps to 2026-02-28, which does exist.
    expect(summary.previous).toBe(100);
  });

  it("returns zeroes with no snapshots", () => {
    expect(netWorthSummary([])).toEqual({
      current: 0,
      previous: null,
      changeAbs: null,
      changePct: null,
    });
  });
});

describe("recentMonthlyPace", () => {
  it("averages the total change over the elapsed months", () => {
    const pace = recentMonthlyPace([
      { date: "2026-01-31", total: 1000 },
      { date: "2026-07-31", total: 2200 },
    ]);
    // 1200 over 181 days, and a month is 30.44 days.
    expect(pace).toBeCloseTo(1200 / (181 / 30.44), 6);
  });

  it("is zero with fewer than two points", () => {
    expect(recentMonthlyPace([{ date: "2026-01-31", total: 1000 }])).toBe(0);
  });
});

describe("month helpers", () => {
  it("steps back across a year boundary", () => {
    expect(previousMonthKey("2026-01")).toBe("2025-12");
    expect(previousMonthKey("2026-08")).toBe("2026-07");
  });

  it("counts days per month, including February in a leap year", () => {
    expect(daysInMonthKey("2026-02")).toBe(28);
    expect(daysInMonthKey("2024-02")).toBe(29);
    expect(daysInMonthKey("2026-08")).toBe(31);
  });
});
