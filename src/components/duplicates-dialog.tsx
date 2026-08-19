"use client";

import * as React from "react";
import { AlertCircle, CheckCircle2, CopyCheck, Loader2, Trash2 } from "lucide-react";

import type { AuditResult, DuplicateGroup } from "@/lib/sync/duplicate-audit";
import { useDeleteTransactions } from "@/hooks/use-finance";
import { formatMonth } from "@/lib/format";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface DuplicatesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  month: string;
}

type State =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: AuditResult }
  | { status: "deleted"; count: number }
  | { status: "failed"; error: string };

async function detect(month: string): Promise<State> {
  try {
    const res = await fetch("/api/duplicates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month }),
    });
    const data = await res.json();
    if (!res.ok) return { status: "failed", error: data.error ?? res.statusText };
    return { status: "done", result: data as AuditResult };
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
}

function amount(value: number, currency: string): string {
  return `${currency} ${value.toLocaleString("es-AR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Finds transactions that look like the same movement recorded twice, and offers
 * to delete the extras.
 *
 * Deliberately two steps: the AI proposes, you confirm. Deleting a real expense
 * is worse than keeping a duplicate one more day, so nothing goes away on its
 * own — the low-confidence groups even start unchecked.
 */
export function DuplicatesDialog({ open, onOpenChange, month }: DuplicatesDialogProps) {
  const [state, setState] = React.useState<State>({ status: "idle" });
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const deleteTransactions = useDeleteTransactions();

  const busy = state.status === "running" || deleteTransactions.isPending;

  /** Closing clears the proposal, so re-opening never shows another month's. */
  function handleOpenChange(next: boolean) {
    if (busy) return;
    if (!next) {
      setState({ status: "idle" });
      setSelected(new Set());
    }
    onOpenChange(next);
  }

  async function run() {
    setState({ status: "running" });
    const next = await detect(month);
    if (next.status === "done") {
      setSelected(
        new Set(
          next.result.groups
            .filter((g) => g.confidence === "high")
            .map((g) => g.keep_id)
        )
      );
    }
    setState(next);
  }

  function toggle(keepId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(keepId)) next.delete(keepId);
      else next.add(keepId);
      return next;
    });
  }

  async function remove(groups: DuplicateGroup[]) {
    const ids = groups.filter((g) => selected.has(g.keep_id)).flatMap((g) => g.drop_ids);
    if (ids.length === 0) return;
    try {
      await deleteTransactions.mutateAsync(ids);
      setState({ status: "deleted", count: ids.length });
    } catch (err) {
      setState({ status: "failed", error: (err as Error).message });
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CopyCheck className="size-5" />
            Detectar duplicados
          </DialogTitle>
          <DialogDescription>
            Revisa {formatMonth(month + "-01")} entero y propone qué borrar. No borra nada
            sin que lo confirmes.
          </DialogDescription>
        </DialogHeader>

        {state.status === "idle" && (
          <Button onClick={run} className="w-full">
            Analizar el mes
          </Button>
        )}

        {state.status === "running" && (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin text-primary" />
            Comparando todo contra todo y consultando los casos dudosos…
          </p>
        )}

        {state.status === "failed" && (
          <>
            <p className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {state.error}
            </p>
            <Button variant="outline" onClick={run} className="w-full">
              Reintentar
            </Button>
          </>
        )}

        {state.status === "deleted" && (
          <>
            <p className="flex items-center gap-2 text-sm font-medium text-emerald-600">
              <CheckCircle2 className="size-4" />
              {state.count} {state.count === 1 ? "transacción borrada" : "transacciones borradas"}
            </p>
            <Button variant="outline" onClick={() => handleOpenChange(false)} className="w-full">
              Cerrar
            </Button>
          </>
        )}

        {state.status === "done" && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {state.result.scanned} transacciones revisadas ·{" "}
              {state.result.candidate_groups} grupos sospechosos ·{" "}
              {state.result.groups.length} confirmados
              {state.result.skipped_groups > 0 &&
                ` · ${state.result.skipped_groups} sin revisar (volvé a correrlo)`}
            </p>

            {state.result.groups.length === 0 ? (
              <p className="text-sm">
                No hay duplicados. Los parecidos que encontró son consumos distintos.
              </p>
            ) : (
              <>
                <div className="max-h-80 space-y-3 overflow-y-auto">
                  {state.result.groups.map((group) => (
                    <GroupCard
                      key={group.keep_id}
                      group={group}
                      checked={selected.has(group.keep_id)}
                      onToggle={() => toggle(group.keep_id)}
                    />
                  ))}
                </div>

                <Button
                  variant="destructive"
                  disabled={selected.size === 0 || deleteTransactions.isPending}
                  onClick={() => remove(state.result.groups)}
                  className="w-full"
                >
                  {deleteTransactions.isPending ? (
                    <Loader2 className="mr-1.5 size-4 animate-spin" />
                  ) : (
                    <Trash2 className="mr-1.5 size-4" />
                  )}
                  Borrar los duplicados marcados
                </Button>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function GroupCard({
  group,
  checked,
  onToggle,
}: {
  group: DuplicateGroup;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="mt-1 size-4 rounded border-border"
        />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">
              {amount(group.transactions[0].amount_native, group.transactions[0].native_currency)}
            </span>
            {group.confidence === "low" && <Badge variant="secondary">dudoso</Badge>}
          </div>

          <p className="text-xs text-muted-foreground">{group.reason}</p>

          <ul className="space-y-0.5 text-xs">
            {group.transactions.map((tx) => {
              const keep = tx.id === group.keep_id;
              return (
                <li
                  key={tx.id}
                  className={`flex items-center gap-1.5 ${
                    keep ? "" : "text-muted-foreground line-through"
                  }`}
                >
                  <span className={keep ? "text-emerald-600" : "text-destructive"}>
                    {keep ? "✓" : "✗"}
                  </span>
                  <span className="truncate">{tx.merchant || tx.description_raw}</span>
                  <span className="ml-auto shrink-0">{tx.tx_date}</span>
                  <span className="shrink-0">{tx.source}</span>
                </li>
              );
            })}
          </ul>
        </div>
      </label>
    </div>
  );
}
