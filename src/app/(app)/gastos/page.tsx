"use client";

import * as React from "react";
import { Bike, Car, Filter, Receipt, RefreshCw, Sparkle, X } from "lucide-react";

import { useAccounts, useCategories, useTransactions } from "@/hooks/use-finance";
import {
  applyFilters,
  categoryComparison,
  costOfLiving,
  daysInMonthKey,
  emptyFilters,
  filterByMonth,
  filtersActive,
  monthsPresent,
  previousMonthKey,
  spendByAccount,
  spendByCountry,
  spendByExpenseType,
  spendingByCategory,
  spendPatterns,
  totalSpend,
  type SpendFilters,
} from "@/lib/analytics";
import { EXPENSE_TYPES, countryMeta, paymentMeta } from "@/lib/dimensions";
import { formatMonth, formatUsd } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { CostOfLivingCard } from "@/components/cost-of-living-card";
import { ChangeIndicator } from "@/components/change-indicator";
import { FilterChips, type ChipOption } from "@/components/filter-chips";
import { LoadingState, ErrorState, EmptyState } from "@/components/states";
import { TransactionsTable } from "@/components/transactions-table";
import { LazyCategoryPieChart, LazyCategoryBarChart, LazySyncDialog } from "@/components/lazy";
import { Button } from "@/components/ui/button";
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

type FacetKey = keyof Omit<SpendFilters, "search">;

export default function GastosPage() {
  const txns = useTransactions();
  const accounts = useAccounts();
  const categories = useCategories();

  const [month, setMonth] = React.useState<string | null>(null);
  const [excludeExtra, setExcludeExtra] = React.useState(false);
  const [filters, setFilters] = React.useState<SpendFilters>(emptyFilters);
  const [syncOpen, setSyncOpen] = React.useState(false);

  const months = React.useMemo(
    () => (txns.data ? monthsPresent(txns.data) : []),
    [txns.data],
  );
  const selectedMonth = month ?? months[0] ?? null;

  function toggleFacet(key: FacetKey, value: string) {
    setFilters((prev) => {
      const next = new Set(prev[key]);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...prev, [key]: next };
    });
  }

  const view = React.useMemo(() => {
    if (!txns.data || !selectedMonth) return null;
    const monthTxns = filterByMonth(txns.data, selectedMonth);
    const prevTxns = filterByMonth(txns.data, previousMonthKey(selectedMonth));

    const dropExtra = (set: typeof monthTxns) =>
      excludeExtra ? set.filter((t) => t.expense_type !== "extraordinario") : set;

    const filtered = dropExtra(applyFilters(monthTxns, filters));
    const prevFiltered = dropExtra(applyFilters(prevTxns, filters));

    return {
      monthTxns,
      filtered,
      total: totalSpend(filtered),
      extraordinary: totalSpend(monthTxns) - totalSpend(monthTxns.filter((t) => t.expense_type !== "extraordinario")),
      byCategory: spendingByCategory(filtered),
      comparison: categoryComparison(filtered, prevFiltered),
      byExpenseType: spendByExpenseType(filtered),
      byCountry: spendByCountry(filtered),
      byAccount: spendByAccount(filtered),
      patterns: spendPatterns(filtered, daysInMonthKey(selectedMonth)),
      cost: costOfLiving(txns.data, selectedMonth),
    };
  }, [txns.data, selectedMonth, excludeExtra, filters]);

  // Facet options derived from the month's data (so no dead chips appear).
  const facetOptions = React.useMemo(() => {
    const set = view?.monthTxns ?? [];
    const present = <T,>(arr: T[]) => [...new Set(arr)];

    const accountOpts: ChipOption[] = present(set.map((t) => t.account_id)).map((id) => ({
      value: id,
      label: set.find((t) => t.account_id === id)?.account?.name ?? "—",
    }));
    const categoryOpts: ChipOption[] = present(
      set.filter((t) => t.category).map((t) => t.category!.id),
    ).map((id) => {
      const c = set.find((t) => t.category?.id === id)?.category;
      return { value: id, label: c?.name ?? "—", color: c?.color };
    });
    const countryOpts: ChipOption[] = present(set.map((t) => t.country)).map((c) => ({
      value: c,
      label: countryMeta.label(c),
      color: countryMeta.color(c),
    }));
    const paymentOpts: ChipOption[] = present(set.map((t) => t.payment_type ?? "")).map((p) => ({
      value: p,
      label: paymentMeta.label(p),
      color: paymentMeta.color(p),
    }));
    return { accountOpts, categoryOpts, countryOpts, paymentOpts };
  }, [view?.monthTxns]);

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

  const activeCount = filtersActive(filters);
  const expenseTypeOpts: ChipOption[] = EXPENSE_TYPES.map((o) => ({
    value: o.value,
    label: o.label,
    color: o.color,
  }));

  return (
    <>
      <PageHeader
        title="Gastos"
        description="Análisis de tus consumos por período y dimensión."
        action={
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
            <Button variant="outline" size="sm" onClick={() => setSyncOpen(true)}>
              <RefreshCw className="mr-1.5 size-4" />
              Sincronizar
            </Button>
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
      <LazySyncDialog open={syncOpen} onOpenChange={setSyncOpen} />

      {/* Pattern stats */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="Gasto del período"
          value={formatUsd(view.total)}
          hint={
            excludeExtra && view.extraordinary > 0
              ? `+ ${formatUsd(view.extraordinary)} extraordinarios`
              : activeCount > 0
                ? "con filtros aplicados"
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

      {/* Cost of living */}
      <div className="mt-4">
        <CostOfLivingCard data={view.cost} />
      </div>

      {/* Faceted filters */}
      <Card className="mt-4">
        <CardHeader className="gap-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Filter className="size-4 text-muted-foreground" />
              Filtros
            </CardTitle>
            {activeCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-muted-foreground"
                onClick={() => setFilters(emptyFilters())}
              >
                <X className="size-3.5" />
                Limpiar ({activeCount})
              </Button>
            )}
          </div>
          <Input
            placeholder="Buscar comercio o descripción…"
            value={filters.search}
            onChange={(e) => setFilters((p) => ({ ...p, search: e.target.value }))}
          />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <FilterChips
            label="Tipo de gasto"
            options={expenseTypeOpts}
            selected={filters.expenseTypes}
            onToggle={(v) => toggleFacet("expenseTypes", v)}
          />
          {facetOptions.categoryOpts.length > 1 && (
            <FilterChips
              label="Categoría"
              options={facetOptions.categoryOpts}
              selected={filters.categoryIds}
              onToggle={(v) => toggleFacet("categoryIds", v)}
            />
          )}
          {facetOptions.accountOpts.length > 1 && (
            <FilterChips
              label="Cuenta / tarjeta"
              options={facetOptions.accountOpts}
              selected={filters.accountIds}
              onToggle={(v) => toggleFacet("accountIds", v)}
            />
          )}
          {facetOptions.countryOpts.length > 1 && (
            <FilterChips
              label="País"
              options={facetOptions.countryOpts}
              selected={filters.countries}
              onToggle={(v) => toggleFacet("countries", v)}
            />
          )}
          {facetOptions.paymentOpts.length > 1 && (
            <FilterChips
              label="Medio de pago"
              options={facetOptions.paymentOpts}
              selected={filters.paymentTypes}
              onToggle={(v) => toggleFacet("paymentTypes", v)}
            />
          )}
        </CardContent>
      </Card>

      {/* Category + month-over-month */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>Gasto por categoría</CardTitle>
              <CardDescription>{formatMonth(selectedMonth + "-01")}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {view.byCategory.length === 0 ? (
              <EmptyChart />
            ) : (
              <Tabs defaultValue="torta">
                <TabsList>
                  <TabsTrigger value="torta">Torta</TabsTrigger>
                  <TabsTrigger value="barras">Barras</TabsTrigger>
                </TabsList>
                <TabsContent value="torta">
                  <LazyCategoryPieChart data={view.byCategory} />
                  <Legend data={view.byCategory} />
                </TabsContent>
                <TabsContent value="barras">
                  <LazyCategoryBarChart data={view.byCategory} />
                </TabsContent>
              </Tabs>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
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
                      <span className="size-2.5 shrink-0 rounded-full" style={{ background: c.color }} />
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

      {/* Dimension breakdowns */}
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-base">Fijo vs variable vs extraordinario</CardTitle>
            <CardDescription>Costo de vida inevitable vs discrecional.</CardDescription>
          </CardHeader>
          <CardContent>
            {view.byExpenseType.length === 0 ? (
              <EmptyChart />
            ) : (
              <>
                <LazyCategoryPieChart data={view.byExpenseType} />
                <Legend data={view.byExpenseType} />
              </>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-base">Gasto por país</CardTitle>
            <CardDescription>Dónde se fue la plata.</CardDescription>
          </CardHeader>
          <CardContent>
            {view.byCountry.length === 0 ? <EmptyChart /> : <LazyCategoryBarChart data={view.byCountry} />}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="text-base">Gasto por cuenta</CardTitle>
            <CardDescription>Ranking de tarjetas / cuentas.</CardDescription>
          </CardHeader>
          <CardContent>
            {view.byAccount.length === 0 ? <EmptyChart /> : <LazyCategoryBarChart data={view.byAccount} />}
          </CardContent>
        </Card>
      </div>

      {/* Transactions */}
      <Card className="mt-4">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Transacciones</CardTitle>
            <span className="text-sm text-muted-foreground">
              {view.filtered.length} resultados
            </span>
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

function EmptyChart() {
  return (
    <p className="py-10 text-center text-sm text-muted-foreground">
      Sin gastos para este filtro.
    </p>
  );
}

function Legend({
  data,
}: {
  data: { name: string; color: string; total: number }[];
}) {
  return (
    <div className="mt-2 grid grid-cols-1 gap-y-1.5 sm:grid-cols-2 sm:gap-x-4">
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
