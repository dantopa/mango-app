"use client";

import * as React from "react";
import {
  CalendarCheck,
  Check,
  CircleDashed,
  FileText,
  Lock,
  Mail,
  Wallet,
} from "lucide-react";

import {
  useMonthlyCloses,
  useCreateMonthlyClose,
  useUpdateCloseItem,
  useUpdateClose,
  useSnapshots,
  useTransactions,
} from "@/hooks/use-finance";
import {
  filterByMonth,
  netWorthSummary,
  totalSpend,
} from "@/lib/analytics";
import { formatMonth, formatUsd } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { LoadingState, ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { MonthlyCloseItem, MonthlyCloseWithItems } from "@/lib/types";

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

const ITEM_META: Record<string, { icon: React.ElementType; help: string }> = {
  extracto_pdf: { icon: FileText, help: "Subí el PDF del resumen" },
  saldo: { icon: Wallet, help: "Ingresá el saldo actual" },
  gmail_auto: { icon: Mail, help: "Se carga automáticamente desde Gmail" },
};

export default function CierrePage() {
  const closes = useMonthlyCloses();
  const snapshots = useSnapshots();
  const txns = useTransactions();
  const createClose = useCreateMonthlyClose();

  const period = currentPeriod();

  if (closes.isLoading) return <LoadingState />;
  if (closes.error) return <ErrorState error={closes.error} />;

  const all = closes.data ?? [];
  const current = all.find((c) => c.period === period) ?? null;
  const history = all.filter((c) => c.period !== period && c.status === "cerrado");

  return (
    <>
      <PageHeader
        title="Cierre mensual"
        description="El ritual de carga: marcá cada fuente a medida que entra."
      />

      {current ? (
        <CloseCard
          close={current}
          netWorth={snapshots.data ? netWorthSummary(snapshots.data).current : null}
          monthSpend={
            txns.data ? totalSpend(filterByMonth(txns.data, period)) : null
          }
          prevNetWorth={history[0]?.net_worth_usd ?? null}
        />
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <CalendarCheck className="size-8 text-muted-foreground" />
            <div>
              <p className="font-medium">
                Todavía no abriste el cierre de {formatMonth(period + "-01")}
              </p>
              <p className="text-sm text-muted-foreground">
                Crealo para generar el checklist de fuentes a cargar.
              </p>
            </div>
            <Button onClick={() => createClose.mutate(period)} disabled={createClose.isPending}>
              <CalendarCheck className="size-4" />
              Abrir cierre de {formatMonth(period + "-01")}
            </Button>
          </CardContent>
        </Card>
      )}

      {history.length > 0 && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-base">Cierres anteriores</CardTitle>
            <CardDescription>Patrimonio y ahorro de cada mes cerrado.</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <ul className="divide-y divide-border">
              {history.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
                  <div className="flex items-center gap-2">
                    <Lock className="size-3.5 text-muted-foreground" />
                    <span className="font-medium capitalize">{formatMonth(c.period + "-01")}</span>
                  </div>
                  <div className="flex items-center gap-4 text-sm tabular-nums">
                    <span>{c.net_worth_usd !== null ? formatUsd(c.net_worth_usd) : "—"}</span>
                    {c.savings_usd !== null && (
                      <span
                        className={c.savings_usd >= 0 ? "text-positive" : "text-destructive"}
                      >
                        {formatUsd(c.savings_usd, { sign: true, compact: true })}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}

function CloseCard({
  close,
  netWorth,
  monthSpend,
  prevNetWorth,
}: {
  close: MonthlyCloseWithItems;
  netWorth: number | null;
  monthSpend: number | null;
  prevNetWorth: number | null;
}) {
  const updateItem = useUpdateCloseItem();
  const updateClose = useUpdateClose();

  const total = close.items.length;
  const loaded = close.items.filter((i) => i.status === "cargado").length;
  const pending = close.items.filter((i) => i.status === "pendiente").length;
  const progress = total > 0 ? (loaded / total) * 100 : 0;
  const isClosed = close.status === "cerrado";

  function closeMonth() {
    const savings =
      netWorth !== null && prevNetWorth !== null ? netWorth - prevNetWorth : null;
    updateClose.mutate({
      id: close.id,
      values: {
        status: "cerrado",
        closed_at: new Date().toISOString(),
        net_worth_usd: netWorth,
        total_spend_usd: monthSpend,
        savings_usd: savings,
      },
    });
  }

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="capitalize">{formatMonth(close.period + "-01")}</CardTitle>
            <CardDescription>
              {isClosed ? "Cerrado" : `${loaded} de ${total} fuentes cargadas`}
            </CardDescription>
          </div>
          {isClosed ? (
            <Badge variant="positive" className="gap-1">
              <Lock className="size-3" />
              Cerrado
            </Badge>
          ) : (
            <Button
              size="sm"
              onClick={closeMonth}
              disabled={pending > 0 || updateClose.isPending}
            >
              <Lock className="size-3.5" />
              {pending > 0 ? `Faltan ${pending}` : "Cerrar mes"}
            </Button>
          )}
        </div>
        <Progress value={progress} />
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <ul className="divide-y divide-border">
          {close.items.map((item) => (
            <CloseItemRow
              key={item.id}
              item={item}
              disabled={isClosed}
              onSetStatus={(status) => updateItem.mutate({ id: item.id, status })}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function CloseItemRow({
  item,
  disabled,
  onSetStatus,
}: {
  item: MonthlyCloseItem;
  disabled: boolean;
  onSetStatus: (status: string) => void;
}) {
  const meta = ITEM_META[item.item_type] ?? ITEM_META.saldo;
  const Icon = meta.icon;
  const [balance, setBalance] = React.useState("");

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div className="flex items-start gap-3">
        <span
          className={
            item.status === "cargado"
              ? "text-positive"
              : item.status === "omitido"
                ? "text-muted-foreground/50"
                : "text-muted-foreground"
          }
        >
          {item.status === "cargado" ? (
            <Check className="size-5" />
          ) : (
            <CircleDashed className="size-5" />
          )}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-medium">
            {item.source}
            {item.item_type === "gmail_auto" && (
              <Badge variant="muted" className="gap-1 text-[10px]">
                <Mail className="size-2.5" />
                auto
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Icon className="size-3" />
            {meta.help}
          </div>
        </div>
      </div>

      {!disabled && (
        <div className="flex items-center gap-2 pl-8 sm:pl-0">
          {item.item_type === "saldo" && item.status !== "cargado" && (
            <Input
              inputMode="decimal"
              placeholder="USD"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              className="h-9 w-24"
            />
          )}
          {item.status === "cargado" ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-muted-foreground"
              onClick={() => onSetStatus("pendiente")}
            >
              Deshacer
            </Button>
          ) : (
            <>
              <Button size="sm" className="h-8" onClick={() => onSetStatus("cargado")}>
                Marcar cargado
              </Button>
              {item.status !== "omitido" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-muted-foreground"
                  onClick={() => onSetStatus("omitido")}
                >
                  Omitir
                </Button>
              ) : (
                <Badge variant="muted">Omitido</Badge>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}
