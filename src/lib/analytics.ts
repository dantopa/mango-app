import type {
  Account,
  Goal,
  NetWorthSnapshot,
  TransactionWithRelations,
} from "./types";

// ---------------------------------------------------------------------------
// Net worth
// ---------------------------------------------------------------------------

export type NetWorthPoint = { date: string; total: number };

/** Total net worth (sum of all account balances) per snapshot date, ascending. */
export function netWorthByDate(snapshots: NetWorthSnapshot[]): NetWorthPoint[] {
  const byDate = new Map<string, number>();
  for (const s of snapshots) {
    byDate.set(s.snapshot_date, (byDate.get(s.snapshot_date) ?? 0) + s.balance_usd);
  }
  return [...byDate.entries()]
    .map(([date, total]) => ({ date, total }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export type CompositionPoint = { date: string } & Record<string, number | string>;

/** Stacked-area data: one row per date, one key per account (USD balance). */
export function netWorthComposition(
  snapshots: NetWorthSnapshot[],
  accounts: Account[],
): { data: CompositionPoint[]; accountNames: string[] } {
  const nameById = new Map(accounts.map((a) => [a.id, a.name]));
  const dates = [...new Set(snapshots.map((s) => s.snapshot_date))].sort();
  const names = [...new Set(snapshots.map((s) => nameById.get(s.account_id) ?? "—"))];

  const rows: Record<string, CompositionPoint> = {};
  for (const d of dates) rows[d] = { date: d } as CompositionPoint;
  for (const n of names) for (const d of dates) (rows[d][n] as number) = 0;

  for (const s of snapshots) {
    const name = nameById.get(s.account_id) ?? "—";
    rows[s.snapshot_date][name] = ((rows[s.snapshot_date][name] as number) ?? 0) + s.balance_usd;
  }
  return { data: dates.map((d) => rows[d]), accountNames: names };
}

export type NetWorthSummary = {
  current: number;
  previous: number | null;
  changeAbs: number | null;
  changePct: number | null;
};

export function netWorthSummary(snapshots: NetWorthSnapshot[]): NetWorthSummary {
  const series = netWorthByDate(snapshots);
  const current = series.at(-1)?.total ?? 0;
  const previous = series.length > 1 ? series.at(-2)!.total : null;
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
