"use client";

import * as React from "react";

import { useAccounts, useSnapshots } from "@/hooks/use-finance";
import {
  accountBalances,
  netWorthByDate,
  netWorthSummary,
} from "@/lib/analytics";
import { formatDate, formatNative, formatPercent, formatUsd } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { ChangeIndicator } from "@/components/change-indicator";
import { LoadingState, ErrorState, EmptyState } from "@/components/states";
import { Sparkline } from "@/components/charts/sparkline";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { paletteColor } from "@/lib/colors";
import type { AccountType } from "@/lib/types";

const TYPE_LABEL: Record<AccountType, string> = {
  crypto: "Cripto",
  broker: "Broker",
  bank: "Banco",
  wallet: "Billetera",
  cash: "Efectivo",
};

export default function PatrimonioPage() {
  const snapshots = useSnapshots();
  const accounts = useAccounts();

  const view = React.useMemo(() => {
    if (!snapshots.data || !accounts.data) return null;
    const balances = accountBalances(snapshots.data, accounts.data).filter(
      (b) => b.snapshotDate !== null,
    );
    const summary = netWorthSummary(snapshots.data);
    const series = netWorthByDate(snapshots.data);
    return { balances, summary, series };
  }, [snapshots.data, accounts.data]);

  if (snapshots.isLoading || accounts.isLoading) return <LoadingState />;
  if (snapshots.error) return <ErrorState error={snapshots.error} />;
  if (!view || view.balances.length === 0) {
    return (
      <>
        <PageHeader title="Patrimonio" />
        <EmptyState
          title="Sin snapshots de patrimonio"
          description="Cargá saldos por cuenta para ver el consolidado."
        />
      </>
    );
  }

  const { balances, summary } = view;
  const latestDate = balances[0]?.snapshotDate;
  const pending = balances.filter((b) => b.isPending);

  return (
    <>
      <PageHeader
        title="Patrimonio"
        description={latestDate ? `Saldos al ${formatDate(latestDate)}` : undefined}
      />

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <div className="text-sm text-muted-foreground">Total consolidado</div>
              <div className="text-3xl font-semibold tabular-nums tracking-tight">
                {formatUsd(summary.current)}
              </div>
            </div>
            <ChangeIndicator
              changeAbs={summary.changeAbs}
              changePct={summary.changePct}
            />
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {/* Mobile: card list */}
          <ul className="divide-y divide-border md:hidden">
            {balances.map((b, i) => (
              <li key={b.account.id} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-medium">
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ background: paletteColor(i) }}
                      />
                      <span className="truncate">{b.account.name}</span>
                      {b.isPending && <Badge variant="muted">pendiente</Badge>}
                    </div>
                    <div className="ml-[18px] text-xs text-muted-foreground">
                      {TYPE_LABEL[b.account.type]}
                      {summary.current > 0
                        ? ` · ${formatPercent(b.balanceUsd / summary.current)} del total`
                        : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-semibold tabular-nums">
                      {formatUsd(b.balanceUsd)}
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {formatNative(b.balanceNative, b.nativeCurrency)}
                    </div>
                  </div>
                </div>
                <Sparkline data={b.sparkline} color={paletteColor(i)} />
                {b.notes && (
                  <div className="text-xs text-muted-foreground">{b.notes}</div>
                )}
              </li>
            ))}
          </ul>

          {/* Desktop: table */}
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Cuenta</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Evolución</TableHead>
                  <TableHead className="text-right">Saldo nativo</TableHead>
                  <TableHead className="text-right">USD</TableHead>
                  <TableHead className="text-right">% del total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {balances.map((b, i) => (
                  <TableRow key={b.account.id}>
                    <TableCell>
                      <div className="flex items-center gap-2 font-medium">
                        <span
                          className="size-2.5 rounded-full"
                          style={{ background: paletteColor(i) }}
                        />
                        {b.account.name}
                        {b.isPending && (
                          <Badge variant="muted" className="ml-1">
                            pendiente
                          </Badge>
                        )}
                      </div>
                      {b.notes && (
                        <div className="ml-[18px] text-xs text-muted-foreground">
                          {b.notes}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{TYPE_LABEL[b.account.type]}</Badge>
                    </TableCell>
                    <TableCell className="w-32">
                      <Sparkline data={b.sparkline} color={paletteColor(i)} />
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {formatNative(b.balanceNative, b.nativeCurrency)}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatUsd(b.balanceUsd)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {summary.current > 0
                        ? formatPercent(b.balanceUsd / summary.current)
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {pending.length > 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          {pending.length} cuenta(s) con saldo pendiente (plata en proceso / reintegros).
        </p>
      )}
    </>
  );
}
