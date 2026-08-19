import type {
  Account,
  Goal,
  NetWorthSnapshot,
  TransactionWithRelations,
} from "./types";
import {
  countryMeta,
  expenseTypeMeta,
  paymentMeta,
  type ExpenseType,
} from "./dimensions";

// ---------------------------------------------------------------------------
// Net worth
// ---------------------------------------------------------------------------

export type NetWorthPoint = { date: string; total: number };

/**
 * Per-date balances with every account's last known value carried forward.
 *
 * Balances are loaded one account at a time, so most dates hold only a subset
 * of them (in production: 6 to 10 of 14 accounts per date). Summing a date's
 * own rows reads every account missing that day as zero, which turned the
 * net-worth series into a sawtooth of "whatever was loaded that day" and made
 * growth indistinguishable from an account being loaded for the first time.
 *
 * An account is carried forward until it gets a new snapshot; it never
 * disappears from the series on its own. A closed account therefore needs a
 * final zero snapshot, same as the per-account view already assumes.
 */
function balancesByDate(
  snapshots: NetWorthSnapshot[],
): { date: string; balances: Map<string, number> }[] {
  const byDate = new Map<string, NetWorthSnapshot[]>();
  for (const s of snapshots) {
    const list = byDate.get(s.snapshot_date);
    if (list) list.push(s);
    else byDate.set(s.snapshot_date, [s]);
  }

  const carried = new Map<string, number>();
  return [...byDate.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((date) => {
      for (const s of byDate.get(date)!) carried.set(s.account_id, s.balance_usd);
      return { date, balances: new Map(carried) };
    });
}

/** Total net worth (all accounts, last known balance) per snapshot date, ascending. */
export function netWorthByDate(snapshots: NetWorthSnapshot[]): NetWorthPoint[] {
  return balancesByDate(snapshots).map(({ date, balances }) => {
    let total = 0;
    for (const usd of balances.values()) total += usd;
    return { date, total };
  });
}

export type CompositionPoint = { date: string } & Record<string, number | string>;

/**
 * Stacked-area data: one row per date, one key per account (USD balance).
 * Carries balances forward like the total series, so a stack does not collapse
 * to zero on the dates that account was not reloaded.
 */
export function netWorthComposition(
  snapshots: NetWorthSnapshot[],
  accounts: Account[],
): { data: CompositionPoint[]; accountNames: string[] } {
  const nameById = new Map(accounts.map((a) => [a.id, a.name]));
  const nameOf = (accountId: string) => nameById.get(accountId) ?? "—";
  const names = [...new Set(snapshots.map((s) => nameOf(s.account_id)))];

  const data = balancesByDate(snapshots).map(({ date, balances }) => {
    const row: CompositionPoint = { date };
    for (const n of names) row[n] = 0;
    for (const [accountId, usd] of balances) {
      const name = nameOf(accountId);
      row[name] = (row[name] as number) + usd;
    }
    return row;
  });

  return { data, accountNames: names };
}

export type NetWorthSummary = {
  current: number;
  previous: number | null;
  changeAbs: number | null;
  changePct: number | null;
};

/** Same day of the previous month, clamped when that month is shorter. */
function oneMonthEarlier(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const prevYear = m === 1 ? y - 1 : y;
  const prevMonth = m === 1 ? 12 : m - 1;
  const daysInPrevMonth = new Date(y, m - 1, 0).getDate();
  const day = Math.min(d, daysInPrevMonth);
  return `${prevYear}-${String(prevMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Current total plus the change against a month earlier — which is what the UI
 * labels it. Snapshots are not taken on fixed days (two consecutive days appear
 * in production), so the previous *row* can be hours old; the comparison is
 * anchored to the last date that is at least a month back instead. `previous`
 * is null until there is that much history.
 */
export function netWorthSummary(snapshots: NetWorthSnapshot[]): NetWorthSummary {
  const series = netWorthByDate(snapshots);
  const latest = series.at(-1);
  if (!latest) return { current: 0, previous: null, changeAbs: null, changePct: null };

  const cutoff = oneMonthEarlier(latest.date);
  let previous: number | null = null;
  for (let i = series.length - 2; i >= 0; i--) {
    if (series[i].date <= cutoff) {
      previous = series[i].total;
      break;
    }
  }

  const current = latest.total;
  const changeAbs = previous === null ? null : current - previous;
  const changePct =
    previous === null || previous === 0 ? null : (current - previous) / previous;
  return { current, previous, changeAbs, changePct };
}

export type AccountBalance = {
  account: Account;
  balanceUsd: number;
  balanceNative: number;
  nativeCurrency: string;
  snapshotDate: string | null;
  isPending: boolean;
  notes: string | null;
  sparkline: { date: string; usd: number }[];
};

/** Latest balance + historical sparkline for each account. */
export function accountBalances(
  snapshots: NetWorthSnapshot[],
  accounts: Account[],
): AccountBalance[] {
  const byAccount = new Map<string, NetWorthSnapshot[]>();
  for (const s of snapshots) {
    const list = byAccount.get(s.account_id) ?? [];
    list.push(s);
    byAccount.set(s.account_id, list);
  }

  return accounts
    .map((account) => {
      const list = (byAccount.get(account.id) ?? []).sort((a, b) =>
        a.snapshot_date.localeCompare(b.snapshot_date),
      );
      const latest = list.at(-1) ?? null;
      return {
        account,
        balanceUsd: latest?.balance_usd ?? 0,
        balanceNative: latest?.balance_native ?? 0,
        nativeCurrency: latest?.native_currency ?? account.native_currency,
        snapshotDate: latest?.snapshot_date ?? null,
        isPending: latest?.is_pending ?? false,
        notes: latest?.notes ?? null,
        sparkline: list.map((s) => ({ date: s.snapshot_date, usd: s.balance_usd })),
      };
    })
    .sort((a, b) => b.balanceUsd - a.balanceUsd);
}

// ---------------------------------------------------------------------------
// Spending
// ---------------------------------------------------------------------------

/** A real expense: positive amount and not a payment/refund. */
export function isExpense(t: TransactionWithRelations): boolean {
  return !t.is_payment && t.amount_usd > 0;
}

export type CategorySpend = {
  categoryId: string | null;
  name: string;
  color: string;
  total: number;
  count: number;
};

const UNCATEGORIZED = { name: "Sin categoría", color: "#52525b" };

export function spendingByCategory(
  txns: TransactionWithRelations[],
  opts: { excludeExtraordinary?: boolean } = {},
): CategorySpend[] {
  const acc = new Map<string, CategorySpend>();
  for (const t of txns) {
    if (!isExpense(t)) continue;
    if (opts.excludeExtraordinary && t.is_extraordinary) continue;
    const key = t.category?.id ?? "none";
    const existing =
      acc.get(key) ??
      {
        categoryId: t.category?.id ?? null,
        name: t.category?.name ?? UNCATEGORIZED.name,
        color: t.category?.color ?? UNCATEGORIZED.color,
        total: 0,
        count: 0,
      };
    existing.total += t.amount_usd;
    existing.count += 1;
    acc.set(key, existing);
  }
  return [...acc.values()].sort((a, b) => b.total - a.total);
}

export function totalSpend(
  txns: TransactionWithRelations[],
  opts: { excludeExtraordinary?: boolean } = {},
): number {
  return txns.reduce((sum, t) => {
    if (!isExpense(t)) return sum;
    if (opts.excludeExtraordinary && t.is_extraordinary) return sum;
    return sum + t.amount_usd;
  }, 0);
}

export type CategoryComparison = {
  name: string;
  color: string;
  current: number;
  previous: number;
  changeAbs: number;
  changePct: number | null;
};

/** Month-over-month spend per category given two pre-filtered transaction sets. */
export function categoryComparison(
  current: TransactionWithRelations[],
  previous: TransactionWithRelations[],
  opts: { excludeExtraordinary?: boolean } = {},
): CategoryComparison[] {
  const cur = new Map(spendingByCategory(current, opts).map((c) => [c.name, c]));
  const prev = new Map(spendingByCategory(previous, opts).map((c) => [c.name, c]));
  const names = new Set([...cur.keys(), ...prev.keys()]);

  return [...names]
    .map((name) => {
      const c = cur.get(name);
      const p = prev.get(name);
      const curTotal = c?.total ?? 0;
      const prevTotal = p?.total ?? 0;
      return {
        name,
        color: c?.color ?? p?.color ?? UNCATEGORIZED.color,
        current: curTotal,
        previous: prevTotal,
        changeAbs: curTotal - prevTotal,
        changePct: prevTotal === 0 ? null : (curTotal - prevTotal) / prevTotal,
      };
    })
    .sort((a, b) => b.current - a.current);
}

export type SpendPatterns = {
  deliveryOrders: number;
  uberTrips: number;
  expenseCount: number;
  avgPerDay: number;
  busiestMerchant: { name: string; count: number } | null;
};

/** Lightweight pattern detection over an already month-filtered set. */
export function spendPatterns(
  txns: TransactionWithRelations[],
  daysInPeriod: number,
): SpendPatterns {
  const expenses = txns.filter(isExpense);
  const matchCat = (re: RegExp) =>
    expenses.filter((t) => re.test(t.category?.name ?? "")).length;

  const merchantCounts = new Map<string, number>();
  for (const t of expenses) {
    const m = t.merchant ?? t.description_raw;
    merchantCounts.set(m, (merchantCounts.get(m) ?? 0) + 1);
  }
  const busiest = [...merchantCounts.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    deliveryOrders: matchCat(/delivery/i),
    uberTrips: matchCat(/transporte/i),
    expenseCount: expenses.length,
    avgPerDay: daysInPeriod > 0 ? totalSpend(txns) / daysInPeriod : 0,
    busiestMerchant: busiest ? { name: busiest[0], count: busiest[1] } : null,
  };
}

/** "YYYY-MM" bucket for a transaction. */
export function txMonthKey(t: TransactionWithRelations): string {
  return t.tx_date.slice(0, 7);
}

/** Unique month buckets present in the data, most recent first. */
export function monthsPresent(txns: TransactionWithRelations[]): string[] {
  return [...new Set(txns.map(txMonthKey))].sort((a, b) => b.localeCompare(a));
}

export function filterByMonth(
  txns: TransactionWithRelations[],
  monthKey: string,
): TransactionWithRelations[] {
  return txns.filter((t) => txMonthKey(t) === monthKey);
}

export function filterByRange(
  txns: TransactionWithRelations[],
  from: string,
  to: string,
): TransactionWithRelations[] {
  return txns.filter((t) => t.tx_date >= from && t.tx_date <= to);
}

/** Number of days in a "YYYY-MM" bucket. */
export function daysInMonthKey(monthKey: string): number {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

/** The previous "YYYY-MM" bucket. */
export function previousMonthKey(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Faceted filtering & dimension breakdowns (v2)
// ---------------------------------------------------------------------------

/**
 * Combinable facet filters. Each set is AND-combined; an empty set means "no
 * filter on this dimension". `search` matches merchant or raw description.
 */
export type SpendFilters = {
  accountIds: Set<string>;
  countries: Set<string>;
  paymentTypes: Set<string>;
  expenseTypes: Set<string>;
  categoryIds: Set<string>;
  search: string;
};

export function emptyFilters(): SpendFilters {
  return {
    accountIds: new Set(),
    countries: new Set(),
    paymentTypes: new Set(),
    expenseTypes: new Set(),
    categoryIds: new Set(),
    search: "",
  };
}

export function filtersActive(f: SpendFilters): number {
  return (
    f.accountIds.size +
    f.countries.size +
    f.paymentTypes.size +
    f.expenseTypes.size +
    f.categoryIds.size +
    (f.search.trim() ? 1 : 0)
  );
}

export function applyFilters(
  txns: TransactionWithRelations[],
  f: SpendFilters,
): TransactionWithRelations[] {
  const q = f.search.trim().toLowerCase();
  return txns.filter((t) => {
    if (f.accountIds.size && !f.accountIds.has(t.account_id)) return false;
    if (f.countries.size && !f.countries.has(t.country)) return false;
    if (f.paymentTypes.size && !f.paymentTypes.has(t.payment_type ?? "")) return false;
    if (f.expenseTypes.size && !f.expenseTypes.has(t.expense_type)) return false;
    if (f.categoryIds.size && !f.categoryIds.has(t.category?.id ?? "")) return false;
    if (q) {
      const hay = `${t.merchant ?? ""} ${t.description_raw}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export type DimensionSlice = {
  key: string;
  name: string;
  color: string;
  total: number;
  count: number;
};

/** Generic spend breakdown over expenses, grouped by an arbitrary key. */
function spendBy(
  txns: TransactionWithRelations[],
  keyOf: (t: TransactionWithRelations) => string,
  nameOf: (key: string) => string,
  colorOf: (key: string) => string,
): DimensionSlice[] {
  const acc = new Map<string, DimensionSlice>();
  for (const t of txns) {
    if (!isExpense(t)) continue;
    const key = keyOf(t);
    const existing =
      acc.get(key) ??
      { key, name: nameOf(key), color: colorOf(key), total: 0, count: 0 };
    existing.total += t.amount_usd;
    existing.count += 1;
    acc.set(key, existing);
  }
  return [...acc.values()].sort((a, b) => b.total - a.total);
}

/** Spend split fijo / variable / extraordinario. */
export function spendByExpenseType(txns: TransactionWithRelations[]): DimensionSlice[] {
  return spendBy(
    txns,
    (t) => t.expense_type,
    (k) => expenseTypeMeta.label(k),
    (k) => expenseTypeMeta.color(k),
  );
}

/** Spend grouped by country where the expense happened. */
export function spendByCountry(txns: TransactionWithRelations[]): DimensionSlice[] {
  return spendBy(
    txns,
    (t) => t.country,
    (k) => countryMeta.label(k),
    (k) => countryMeta.color(k),
  );
}

/** Spend grouped by payment medium. */
export function spendByPaymentType(txns: TransactionWithRelations[]): DimensionSlice[] {
  return spendBy(
    txns,
    (t) => t.payment_type ?? "",
    (k) => paymentMeta.label(k),
    (k) => paymentMeta.color(k),
  );
}

const ACCOUNT_PALETTE = [
  "#8b5cf6", "#22c55e", "#f97316", "#3b82f6", "#ec4899",
  "#eab308", "#06b6d4", "#ef4444", "#14b8a6", "#a16207",
];

/** Spend grouped by account/card (ranking). Colors are name-stable. */
export function spendByAccount(txns: TransactionWithRelations[]): DimensionSlice[] {
  const names = [...new Set(txns.map((t) => t.account?.name ?? "—"))].sort();
  const colorByName = new Map(names.map((n, i) => [n, ACCOUNT_PALETTE[i % ACCOUNT_PALETTE.length]]));
  return spendBy(
    txns,
    (t) => t.account?.name ?? "—",
    (k) => k,
    (k) => colorByName.get(k) ?? "#52525b",
  );
}

export type CostOfLiving = {
  fixed: number;
  variableAvg: number;
  total: number;
  monthsAveraged: number;
};

/**
 * Monthly cost of living = current-month FIXED spend + average VARIABLE spend
 * over the last up-to-3 months. Extraordinary one-offs are excluded by design.
 */
export function costOfLiving(
  allTxns: TransactionWithRelations[],
  currentMonthKey: string,
): CostOfLiving {
  const sumByType = (set: TransactionWithRelations[], type: ExpenseType) =>
    set.reduce(
      (s, t) => (isExpense(t) && t.expense_type === type ? s + t.amount_usd : s),
      0,
    );

  const fixed = sumByType(filterByMonth(allTxns, currentMonthKey), "fijo");

  // Average variable over the most recent months that have data (incl. current).
  const months = monthsPresent(allTxns)
    .filter((m) => m <= currentMonthKey)
    .slice(0, 3);
  const variableTotals = months.map((m) =>
    sumByType(filterByMonth(allTxns, m), "variable"),
  );
  const variableAvg =
    variableTotals.length > 0
      ? variableTotals.reduce((a, b) => a + b, 0) / variableTotals.length
      : 0;

  return {
    fixed,
    variableAvg,
    total: fixed + variableAvg,
    monthsAveraged: months.length,
  };
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export type GoalProgress = {
  goal: Goal;
  current: number;
  progressPct: number;
  remaining: number;
  monthsRemaining: number;
  requiredMonthlyUsd: number;
  actualMonthlyUsd: number;
  onTrack: boolean;
  projectedDate: Date | null;
};

const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.44;

export function goalProgress(
  goal: Goal,
  currentNetWorth: number,
  netWorthSeries: NetWorthPoint[],
  now: Date = new Date(),
): GoalProgress {
  const remaining = Math.max(goal.target_usd - currentNetWorth, 0);
  const progressPct =
    goal.target_usd === goal.start_usd
      ? 1
      : (currentNetWorth - goal.start_usd) / (goal.target_usd - goal.start_usd);

  const target = new Date(goal.target_date + "T00:00:00");
  const monthsRemaining = Math.max((target.getTime() - now.getTime()) / MS_PER_MONTH, 0);
  const requiredMonthlyUsd = monthsRemaining > 0 ? remaining / monthsRemaining : remaining;

  // Actual recent pace: average monthly delta over the available history window.
  const actualMonthlyUsd = recentMonthlyPace(netWorthSeries);

  // Project when the goal is hit at the current pace.
  let projectedDate: Date | null = null;
  if (actualMonthlyUsd > 0 && remaining > 0) {
    const monthsNeeded = remaining / actualMonthlyUsd;
    projectedDate = new Date(now.getTime() + monthsNeeded * MS_PER_MONTH);
  } else if (remaining === 0) {
    projectedDate = now;
  }

  return {
    goal,
    current: currentNetWorth,
    progressPct: Math.min(Math.max(progressPct, 0), 1),
    remaining,
    monthsRemaining,
    requiredMonthlyUsd,
    actualMonthlyUsd,
    onTrack: actualMonthlyUsd >= requiredMonthlyUsd - 1, // tiny tolerance
    projectedDate,
  };
}

/** Average monthly change across the net-worth series (USD/month). */
export function recentMonthlyPace(series: NetWorthPoint[]): number {
  if (series.length < 2) return 0;
  const first = series[0];
  const last = series.at(-1)!;
  const months =
    (new Date(last.date + "T00:00:00").getTime() -
      new Date(first.date + "T00:00:00").getTime()) /
    MS_PER_MONTH;
  if (months <= 0) return 0;
  return (last.total - first.total) / months;
}
