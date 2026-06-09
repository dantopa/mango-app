"use client";

import * as React from "react";
import { Receipt, TrendingUp, CalendarDays } from "lucide-react";

import {
  useAccounts,
  useGoals,
  useSnapshots,
  useTransactions,
} from "@/hooks/use-finance";
import {
  accountBalances,
  daysInMonthKey,
  filterByMonth,
  goalProgress,
  monthsPresent,
  netWorthByDate,
  netWorthComposition,
  netWorthSummary,
  recentMonthlyPace,
  spendPatterns,
  totalSpend,
} from "@/lib/analytics";
import { formatMonth, formatUsd } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { SemaphoreGauge } from "@/components/semaphore-gauge";
import { ChangeIndicator } from "@/components/change-indicator";
import { GoalTracker } from "@/components/goal-tracker";
import { LoadingState, ErrorState, EmptyState } from "@/components/states";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { NetWorthLineChart } from "@/components/charts/net-worth-line-chart";
import { CompositionAreaChart } from "@/components/charts/composition-area-chart";

export default function DashboardPage() {
  const snapshots = useSnapshots();
  const accounts = useAccounts();
  const goals = useGoals();
  const txns = useTransactions();

  const isLoading =
    snapshots.isLoading || accounts.isLoading || goals.isLoading || txns.isLoading;
  const error = snapshots.error || accounts.error || goals.error || txns.error;

  const view = React.useMemo(() => {
    if (!snapshots.data || !accounts.data || !goals.data || !txns.data) return null;

    const series = netWorthByDate(snapshots.data);
    const summary = netWorthSummary(snapshots.data);
    const composition = netWorthComposition(snapshots.data, accounts.data);
    const pace = recentMonthlyPace(series);

    const activeGoal = goals.data.find((g) => g.is_active) ?? null;
    const progress = activeGoal
      ? goalProgress(activeGoal, summary.current, series)
      : null;

    const months = monthsPresent(txns.data);
    const currentMonth = months[0] ?? null;
    const monthTxns = currentMonth ? filterByMonth(txns.data, currentMonth) : [];
    const monthSpend = totalSpend(monthTxns);
    const patterns = currentMonth
      ? spendPatterns(monthTxns, daysInMonthKey(currentMonth))
      : null;

    return { series, summary, composition, pace, progress, currentMonth, monthSpend, patterns };
  }, [snapshots.data, accounts.data, goals.data, txns.data]);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;
  if (!view || view.series.length === 0) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <EmptyState
          title="Todavía no hay datos"
          description="Cuando se carguen snapshots de patrimonio, vas a ver tu evolución acá."
        />
      </>
    );
  }

  const { summary, series, composition, progress, currentMonth, monthSpend, patterns } = view;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Tu foto financiera consolidada en dólares."
      />

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Net worth */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardDescription>Patrimonio neto</CardDescription>
            <div className="flex flex-wrap items-baseline gap-3">
              <CardTitle className="text-3xl font-semibold tabular-nums tracking-tight sm:text-4xl">
                {formatUsd(summary.current)}
              </CardTitle>
              <div className="flex items-center gap-2">
                <ChangeIndicator
                  changeAbs={summary.changeAbs}
                  changePct={summary.changePct}
                />
                <span className="text-sm text-muted-foreground">vs mes anterior</span>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <NetWorthLineChart data={series} />
          </CardContent>
        </Card>

        {/* Goal */}
        <Card className="lg:col-span-1">
          <CardContent className="p-6">
            {progress ? (
              <GoalTracker progress={progress} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-1 py-10 text-center">
                <p className="font-medium">Sin objetivo activo</p>
                <p className="text-sm text-muted-foreground">
                  Creá uno en la sección Objetivos.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Quick stats */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SemaphoreGauge />
        <StatCard
          label={`Gasto ${currentMonth ? formatMonth(currentMonth + "-01") : "del mes"}`}
          value={formatUsd(monthSpend)}
          hint={patterns ? `${patterns.expenseCount} consumos` : undefined}
          icon={<Receipt className="size-4" />}
        />
        <StatCard
          label="Ritmo de ahorro"
          value={`${formatUsd(view.pace, { compact: true })}/mes`}
          hint="promedio del histórico"
          icon={<TrendingUp className="size-4" />}
        />
        <StatCard
          label="Gasto promedio / día"
          value={patterns ? formatUsd(patterns.avgPerDay) : "—"}
          hint={
            patterns?.busiestMerchant
              ? `Top: ${patterns.busiestMerchant.name} (${patterns.busiestMerchant.count}×)`
              : undefined
          }
          icon={<CalendarDays className="size-4" />}
        />
      </div>

      {/* Composition */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Composición del patrimonio</CardTitle>
          <CardDescription>Cómo crece cada cuenta mes a mes (USD).</CardDescription>
        </CardHeader>
        <CardContent>
          <CompositionAreaChart
            data={composition.data}
            accountNames={composition.accountNames}
          />
        </CardContent>
      </Card>
    </>
  );
}
