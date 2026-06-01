"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatDay, formatNative, formatUsd } from "@/lib/format";
import { useUpdateTransaction } from "@/hooks/use-finance";
import type { Category, TransactionWithRelations } from "@/lib/types";

const NONE = "__none__";

export function TransactionsTable({
  transactions,
  categories,
}: {
  transactions: TransactionWithRelations[];
  categories: Category[];
}) {
  const update = useUpdateTransaction();
  const [pendingId, setPendingId] = React.useState<string | null>(null);

  async function mutate(id: string, values: Parameters<typeof update.mutateAsync>[0]["values"]) {
    setPendingId(id);
    try {
      await update.mutateAsync({ id, values });
    } finally {
      setPendingId(null);
    }
  }

  if (transactions.length === 0) {
    return (
      <div className="p-10 text-center text-sm text-muted-foreground">
        No hay transacciones para este filtro.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Fecha</TableHead>
          <TableHead>Descripción</TableHead>
          <TableHead className="hidden md:table-cell">Cuenta</TableHead>
          <TableHead className="w-48">Categoría</TableHead>
          <TableHead>Flags</TableHead>
          <TableHead className="text-right">Monto</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {transactions.map((t) => {
          const isCredit = t.is_payment || t.amount_usd < 0;
          const busy = pendingId === t.id;
          return (
            <TableRow key={t.id} className={cn(busy && "opacity-60")}>
              <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                {formatDay(t.tx_date)}
              </TableCell>

              <TableCell className="max-w-[260px]">
                <div className="truncate font-medium">
                  {t.merchant ?? t.description_raw}
                </div>
                {t.merchant && (
                  <div className="truncate text-xs text-muted-foreground">
                    {t.description_raw}
                  </div>
                )}
                {t.installments && t.installments !== "1 de 1" && (
                  <Badge variant="muted" className="mt-1">
                    {t.installments}
                  </Badge>
                )}
              </TableCell>

              <TableCell className="hidden whitespace-nowrap text-muted-foreground md:table-cell">
                {t.account?.name ?? "—"}
              </TableCell>

              <TableCell>
                <Select
                  value={t.category?.id ?? NONE}
                  onValueChange={(v) =>
                    mutate(t.id, { category_id: v === NONE ? null : v })
                  }
                >
                  <SelectTrigger className="h-8">
                    <SelectValue>
                      <span className="flex items-center gap-2">
                        {t.category && (
                          <span
                            className="size-2.5 rounded-full"
                            style={{ background: t.category.color }}
                          />
                        )}
                        <span className="truncate">{t.category?.name ?? "Sin categoría"}</span>
                      </span>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Sin categoría</SelectItem>
                    {categories.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        <span className="flex items-center gap-2">
                          <span
                            className="size-2.5 rounded-full"
                            style={{ background: c.color }}
                          />
                          {c.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TableCell>

              <TableCell>
                <div className="flex items-center gap-1.5">
                  <FlagToggle
                    active={t.is_extraordinary}
                    label="Extra"
                    title="Gasto extraordinario (one-off)"
                    onClick={() => mutate(t.id, { is_extraordinary: !t.is_extraordinary })}
                  />
                  <FlagToggle
                    active={t.is_payment}
                    label="Pago"
                    title="Pago / devolución (no cuenta como gasto)"
                    onClick={() => mutate(t.id, { is_payment: !t.is_payment })}
                  />
                  {busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                </div>
              </TableCell>

              <TableCell className="text-right">
                <div
                  className={cn(
                    "font-medium tabular-nums",
                    isCredit ? "text-positive" : "text-foreground",
                  )}
                >
                  {formatUsd(t.amount_usd)}
                </div>
                {t.native_currency !== "USD" && (
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {formatNative(t.amount_native, t.native_currency)}
                  </div>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function FlagToggle({
  active,
  label,
  title,
  onClick,
}: {
  active: boolean;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} title={title}>
      <Badge
        variant={active ? (label === "Pago" ? "positive" : "default") : "muted"}
        className={cn("cursor-pointer transition-opacity", !active && "opacity-50")}
      >
        {label}
      </Badge>
    </button>
  );
}
