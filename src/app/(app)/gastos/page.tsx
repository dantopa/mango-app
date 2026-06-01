"use client";

import * as React from "react";
import { Bike, Car, Receipt, Sparkle } from "lucide-react";

import { useAccounts, useCategories, useTransactions } from "@/hooks/use-finance";
import {
  categoryComparison,
  daysInMonthKey,
  filterByMonth,
  monthsPresent,
  previousMonthKey,
  spendPatterns,
  spendingByCategory,
  totalSpend,
} from "@/lib/analytics";
import { formatMonth, formatUsd } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { ChangeIndicator } from "@/components/change-indicator";
import { LoadingState, ErrorState, EmptyState } from "@/components/states";
import { TransactionsTable } from "@/components/transactions-table";
import { CategoryPieChart } from "@/components/charts/category-pie-chart";
import { CategoryBarChart } from "@/components/charts/category-bar-chart";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const ALL = "__all__";

export default function GastosPage() {
  const txns = useTransactions();
  const accounts = useAccounts();
  const categories = useCategories();

  const [month, setMonth] = React.useState<string | null>(null);
  const [excludeExtra, setExcludeExtra] = React.useState(false);
  const [accountFilter, setAccountFilter] = React.useState(ALL);
  const [categoryFilter, setCategoryFilter] = React.useState(ALL);
  const [search, setSearch] = React.useState("");

  const months = React.useMemo(
    () => (txns.data ? monthsPresent(txns.data) : []),
    [txns.data],
  );
  const selectedMonth = month ?? months[0] ?? null;

  const view = React.useMemo(() => {
    if (!txns.data || !selectedMonth) return null;
    const monthTxns = filterByMonth(txns.data, selectedMonth);
    const prevTxns = filterByMonth(txns.data, previousMonthKey(selectedMonth));

    const opts = { excludeExtraordinary: excludeExtra };
    const byCategory = spendingByCategory(monthTxns, opts);
    const total = totalSpend(monthTxns, opts);
    const totalWithExtra = totalSpend(monthTxns);
    const comparison = categoryComparison(monthTxns, prevTxns, opts);
    const patterns = spendPatterns(monthTxns, daysInMonthKey(selectedMonth));

    const filtered = monthTxns.filter((t) => {
      if (accountFilter !== ALL && t.account_id !== accountFilter) return false;
      if (categoryFilter !== ALL && (t.category?.id ?? "") !== categoryFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        const hay = `${t.merchant ?? ""} ${t.description_raw}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    return {
      byCategory,
      total,
      extraordinary: totalWithExtra - total,
      comparison,
      patterns,
      filtered,
    };
  }, [txns.data, selectedMonth, excludeExtra, accountFilter, categoryFilter, search]);

  if (txns.isLoading || accounts.isLoading || categories.isLoading)
    return <LoadingState />;
  if (txns.error) return <ErrorState error={txns.error} />;
  if (!view || months.length === 0) {
    return (
      <>
        <PageHeader title="Gastos" />
        <EmptyState
          title="Todavía no hay transacciones"
          description="Cuando se carguen consumos de tus extractos, los vas a ver y analizar acá."
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Gastos"
        description="Análisis de tus consumos por período y categoría."
        action={
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
            <label className="flex items-center justify-between gap-2 text-sm text-muted-foreground sm:justify-start">
              Excluir extraordinarios
              <Switch checked={excludeExtra} onCheckedChange={setExcludeExtra} />
            </label>
            <Select value={selectedMonth} onValueChange={setMonth}>
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {months.map((m) => (
                  <SelectItem key={m} value={m}>
                    {formatMonth(m + "-01")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />

      {/* Pattern stats */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="Gasto del período"
          value={formatUsd(view.total)}
          hint={
            excludeExtra && view.extraordinary > 0
              ? `+ ${formatUsd(view.extraordinary)} extraordinarios`
              : "vida normal"
          }
          icon={<Receipt className="size-4" />}
        />
        <StatCard
          label="Consumos"
          value={view.patterns.expenseCount}
          hint={`${formatUsd(view.patterns.avgPerDay)} / día`}
          icon={<Sparkle className="size-4" />}
        />
        <StatCard
          label="Pedidos de delivery"
          value={view.patterns.deliveryOrders}
          hint="en el período"
          icon={<Bike className="size-4" />}
        />
        <StatCard
          label="Viajes (Uber/Didi)"
          value={view.patterns.uberTrips}
          hint="en el período"
          icon={<Car className="size-4" />}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* Distribution */}
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>Gasto por categoría</CardTitle>
              <CardDescription>{formatMonth(selectedMonth + "-01")}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {view.byCategory.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Sin gastos en el período.
              </p>
            ) : (
              <Tabs defaultValue="torta">
                <TabsList>
                  <TabsTrigger value="torta">Torta</TabsTrigger>
                  <TabsTrigger value="barras">Barras</TabsTrigger>
                </TabsList>
                <TabsContent value="torta">
                  <CategoryPieChart data={view.byCategory} />
                  <CategoryLegend data={view.byCategory} />
                </TabsContent>
                <TabsContent value="barras">
                  <CategoryBarChart data={view.byCategory} />
                </TabsContent>
              </Tabs>
            )}
          </CardContent>
        </Card>

        {/* Month over month */}
        <Card>
          <CardHeader>
            <CardTitle>Comparación vs mes anterior</CardTitle>
            <CardDescription>
              {formatMonth(previousMonthKey(selectedMonth) + "-01")} →{" "}
              {formatMonth(selectedMonth + "-01")}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {view.comparison.filter((c) => c.current > 0 || c.previous > 0).length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No hay con qué comparar.
              </p>
            ) : (
              view.comparison
                .filter((c) => c.current > 0 || c.previous > 0)
                .slice(0, 8)
                .map((c) => (
                  <div
                    key={c.name}
                    className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-secondary/40"
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ background: c.color }}
                      />
                      <span className="truncate">{c.name}</span>
                    </span>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-sm tabular-nums">{formatUsd(c.current)}</span>
                      <ChangeIndicator
                        changeAbs={c.changeAbs}
                        changePct={c.changePct}
                        invert
                        compact
                        className="w-14 justify-end"
                      />
                    </div>
                  </div>
                ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Transactions */}
      <Card className="mt-4">
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Transacciones</CardTitle>
            <span className="text-sm text-muted-foreground">
              {view.filtered.length} resultados
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Buscar</Label>
              <Input
                placeholder="Comercio o descripción…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Cuenta</Label>
              <Select value={accountFilter} onValueChange={setAccountFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Todas</SelectItem>
                  {accounts.data?.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Categoría</Label>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Todas</SelectItem>
                  {categories.data?.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <TransactionsTable
            transactions={view.filtered}
            categories={categories.data ?? []}
          />
        </CardContent>
      </Card>
    </>
  );
}

function CategoryLegend({
  data,
}: {
  data: { name: string; color: string; total: number }[];
}) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
      {data.map((c) => (
        <div key={c.name} className="flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2 truncate text-muted-foreground">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: c.color }} />
            <span className="truncate">{c.name}</span>
          </span>
          <span className="tabular-nums">{formatUsd(c.total)}</span>
        </div>
      ))}
    </div>
  );
}
