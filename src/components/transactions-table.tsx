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

type EditValues = Parameters<
  ReturnType<typeof useUpdateTransaction>["mutateAsync"]
>[0]["values"];

export function TransactionsTable({
  transactions,
  categories,
}: {
  transactions: TransactionWithRelations[];
  categories: Category[];
}) {
  const update = useUpdateTransaction();
  const [pendingId, setPendingId] = React.useState<string | null>(null);

  async function mutate(id: string, values: EditValues) {
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
    <>
      {/* Mobile: card list */}
      <ul className="divide-y divide-border md:hidden">
        {transactions.map((t) => {
          const isCredit = t.is_payment || t.amount_usd < 0;
          return (
            <li key={t.id} className="flex flex-col gap-2.5 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">
                    {t.merchant ?? t.description_raw}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {formatDay(t.tx_date)} · {t.account?.name ?? "—"}
                    {t.installments && t.installments !== "1 de 1"
                      ? ` · ${t.installments}`
                      : ""}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div
                    className={cn(
                      "font-semibold tabular-nums",
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
                </div>
              </div>
              <div className="flex items-center gap-2">
                <CategorySelect
                  value={t.category?.id ?? NONE}
                  color={t.category?.color}
                  name={t.category?.name}
                  categories={categories}
                  className="h-9 min-w-0 flex-1"
                  onChange={(v) => mutate(t.id, { category_id: v === NONE ? null : v })}
                />
                <FlagToggle
                  active={t.is_extraordinary}
                  label="Extra"
                  onClick={() => mutate(t.id, { is_extraordinary: !t.is_extraordinary })}
                />
                <FlagToggle
                  active={t.is_payment}
                  label="Pago"
                  onClick={() => mutate(t.id, { is_payment: !t.is_payment })}
                />
                {pendingId === t.id && (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {/* Desktop: table */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Fecha</TableHead>
              <TableHead>Descripción</TableHead>
              <TableHead>Cuenta</TableHead>
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
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {t.account?.name ?? "—"}
                  </TableCell>
                  <TableCell>
                    <CategorySelect
                      value={t.category?.id ?? NONE}
                      color={t.category?.color}
                      name={t.category?.name}
                      categories={categories}
                      className="h-8"
                      onChange={(v) =>
                        mutate(t.id, { category_id: v === NONE ? null : v })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <FlagToggle
                        active={t.is_extraordinary}
                        label="Extra"
                        onClick={() =>
                          mutate(t.id, { is_extraordinary: !t.is_extraordinary })
                        }
                      />
                      <FlagToggle
                        active={t.is_payment}
                        label="Pago"
                        onClick={() => mutate(t.id, { is_payment: !t.is_payment })}
                      />
                      {busy && (
                        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                      )}
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
      </div>
    </>
  );
}

function CategorySelect({
  value,
  color,
  name,
  categories,
  className,
  onChange,
}: {
  value: string;
  color?: string;
  name?: string;
  categories: Category[];
  className?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={className}>
        <SelectValue>
          <span className="flex items-center gap-2">
            {color && (
              <span className="size-2.5 rounded-full" style={{ background: color }} />
            )}
            <span className="truncate">{name ?? "Sin categoría"}</span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Sin categoría</SelectItem>
        {categories.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            <span className="flex items-center gap-2">
              <span className="size-2.5 rounded-full" style={{ background: c.color }} />
              {c.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function FlagToggle({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={
        label === "Pago"
          ? "Pago / devolución (no cuenta como gasto)"
          : "Gasto extraordinario (one-off)"
      }
    >
      <Badge
        variant={active ? (label === "Pago" ? "positive" : "default") : "muted"}
        className={cn("cursor-pointer transition-opacity", !active && "opacity-50")}
      >
        {label}
      </Badge>
    </button>
  );
}
