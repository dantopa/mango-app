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
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Cuenta</TableHead>
                <TableHead className="hidden sm:table-cell">Tipo</TableHead>
                <TableHead className="hidden md:table-cell">Evolución</TableHead>
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
                      <div className="ml-[18px] text-xs text-muted-foreground">{b.notes}</div>
                    )}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <Badge variant="secondary">{TYPE_LABEL[b.account.type]}</Badge>
                  </TableCell>
                  <TableCell className="hidden w-32 md:table-cell">
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
