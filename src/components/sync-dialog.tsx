"use client";

import * as React from "react";
import { RefreshCw, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

import { useSync } from "@/hooks/use-sync";
import type { ClientSyncSource, SyncSourceResult } from "@/lib/sync/types";

import { formatMonth } from "@/lib/format";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface SyncDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SOURCES: { id: ClientSyncSource; label: string }[] = [
  { id: "sync_bancolombia", label: "Bancolombia" },
  { id: "sync_nexo", label: "Nexo Card" },
  { id: "sync_bbva", label: "BBVA" },
  { id: "sync_gmail", label: "Gmail" },
  { id: "sync_notifications", label: "Notificaciones (NFC/push)" },
];

const GMAIL_SUB_SOURCE_LABELS: Record<string, string> = {
  sync_gmail_bancolombia: "Gmail · Bancolombia",
  sync_gmail_rappicard: "Gmail · RappiCard",
  sync_gmail_arriendo: "Gmail · Arriendo",
};

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function getMonthOptions(): string[] {
  const options: string[] = [];
  const now = new Date();
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    options.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return options;
}

export function SyncDialog({ open, onOpenChange }: SyncDialogProps) {
  const { startSync, progress, reset } = useSync();
  const [month, setMonth] = React.useState(getCurrentMonth);
  const [selectedSources, setSelectedSources] = React.useState<Set<ClientSyncSource>>(
    new Set(SOURCES.map((s) => s.id))
  );
  const [gmailConnected, setGmailConnected] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    if (open) {
      fetch("/api/gmail/status")
        .then((r) => r.json())
        .then((d) => setGmailConnected(d.connected))
        .catch(() => setGmailConnected(false));
    }
  }, [open]);

  const monthOptions = React.useMemo(() => getMonthOptions(), []);

  function toggleSource(source: ClientSyncSource) {
    setSelectedSources((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  }

  function handleStart() {
    startSync({
      month,
      sources: SOURCES.filter((s) => selectedSources.has(s.id)).map((s) => s.id),
    });
  }

  function handleClose(isOpen: boolean) {
    if (!isOpen && progress.status !== "running") {
      reset();
    }
    if (progress.status !== "running") {
      onOpenChange(isOpen);
    }
  }

  const totalInserted = progress.completed.reduce((sum, r) => sum + r.inserted, 0);
  const totalDuplicates = progress.completed.reduce((sum, r) => sum + r.duplicates, 0);
  const totalReview = progress.completed.reduce((sum, r) => sum + r.needs_review, 0);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="size-5" />
            Sincronizar transacciones
          </DialogTitle>
          <DialogDescription>
            Reconciliá gastos de tus cuentas para el mes seleccionado.
          </DialogDescription>
        </DialogHeader>

        {progress.status === "idle" && (
          <div className="flex flex-col gap-4 pt-2">
            {/* Month selector */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Mes</label>
              <Select value={month} onValueChange={setMonth}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {monthOptions.map((m) => (
                    <SelectItem key={m} value={m}>
                      {formatMonth(m + "-01")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Source checkboxes */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Fuentes</label>
              <div className="flex flex-col gap-2">
                {SOURCES.map((s) => {
                  if (s.id === "sync_gmail" && !gmailConnected) {
                    return (
                      <div key={s.id} className="flex items-center gap-2 text-sm">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => (window.location.href = "/api/gmail/auth")}
                        >
                          Conectar Gmail
                        </Button>
                      </div>
                    );
                  }
                  return (
                    <label key={s.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedSources.has(s.id)}
                        onChange={() => toggleSource(s.id)}
                        className="size-4 rounded border-border"
                      />
                      {s.label}
                    </label>
                  );
                })}
              </div>
            </div>

            <Button
              onClick={handleStart}
              disabled={selectedSources.size === 0}
              className="w-full"
            >
              Iniciar sincronización
            </Button>
          </div>
        )}

        {progress.status === "running" && (
          <div className="flex flex-col gap-3 pt-2">
            {progress.current_source && (
              <div className="flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin text-primary" />
                <span>
                  Sincronizando{" "}
                  {GMAIL_SUB_SOURCE_LABELS[progress.current_source] ??
                    SOURCES.find((s) => s.id === progress.current_source)?.label ??
                    "..."}
                </span>
              </div>
            )}
            {progress.completed.map((r, i) => (
              <SourceResult key={`${r.source}-${i}`} result={r} />
            ))}
            {progress.errors.map((e) => (
              <div key={e.source} className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="size-4" />
                <span>
                  {GMAIL_SUB_SOURCE_LABELS[e.source] ??
                    SOURCES.find((s) => s.id === e.source)?.label ??
                    e.source}
                  : {e.error}
                </span>
              </div>
            ))}
          </div>
        )}

        {progress.status === "done" && (
          <div className="flex flex-col gap-4 pt-2">
            {/* Per-source results */}
            {progress.completed.map((r, i) => (
              <SourceResult key={`${r.source}-${i}`} result={r} />
            ))}
            {progress.errors.map((e) => (
              <div key={e.source} className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="size-4" />
                <span>
                  {GMAIL_SUB_SOURCE_LABELS[e.source] ??
                    SOURCES.find((s) => s.id === e.source)?.label ??
                    e.source}
                  : {e.error}
                </span>
              </div>
            ))}

            {/* Summary */}
            <div className="rounded-lg border bg-muted/50 p-3">
              <p className="text-sm font-medium">Resumen</p>
              <div className="mt-1.5 grid grid-cols-3 gap-2 text-center text-xs">
                <div>
                  <p className="text-lg font-bold text-primary">{totalInserted}</p>
                  <p className="text-muted-foreground">nuevas</p>
                </div>
                <div>
                  <p className="text-lg font-bold">{totalDuplicates}</p>
                  <p className="text-muted-foreground">duplicados</p>
                </div>
                <div>
                  <p className="text-lg font-bold text-amber-500">{totalReview}</p>
                  <p className="text-muted-foreground">para revisión</p>
                </div>
              </div>
            </div>

            <Button variant="outline" onClick={() => handleClose(false)} className="w-full">
              Cerrar
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SourceResult({ result }: { result: SyncSourceResult }) {
  const label =
    GMAIL_SUB_SOURCE_LABELS[result.source] ??
    SOURCES.find((s) => s.id === result.source)?.label ??
    result.source;
  const hasErrors = result.errors.length > 0;
  const hasItems = result.items && result.items.length > 0;
  return (
    <div className="flex items-start gap-2 text-sm">
      {hasErrors ? (
        <AlertCircle className="mt-0.5 size-4 text-amber-500" />
      ) : (
        <CheckCircle2 className="mt-0.5 size-4 text-green-500" />
      )}
      <div className="flex-1 min-w-0">
        <p className="font-medium">{label}</p>
        <p className="text-muted-foreground">
          {result.found} encontradas · {result.inserted} nuevas · {result.duplicates} duplicados
          {result.needs_review > 0 && ` · ${result.needs_review} para revisión`}
          {hasErrors && ` · ${result.errors.length} errores`}
        </p>
        {hasItems && (
          <ul className="mt-1.5 space-y-0.5 text-xs">
            {result.items!.map((item, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <span className={
                  item.status === "inserted" ? "text-green-500" :
                  item.status === "duplicate" ? "text-muted-foreground" :
                  item.status === "review" ? "text-amber-500" :
                  "text-destructive"
                }>
                  {item.status === "inserted" ? "✓" : item.status === "duplicate" ? "=" : item.status === "review" ? "?" : "✗"}
                </span>
                <span className="truncate">{item.merchant || "—"}</span>
                <span className="ml-auto shrink-0 tabular-nums">
                  {item.currency} {item.amount.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span className="shrink-0 text-muted-foreground">{item.date}</span>
              </li>
            ))}
          </ul>
        )}
        {hasErrors && (
          <ul className="mt-1 list-inside list-disc text-xs text-destructive">
            {result.errors.slice(0, 5).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
            {result.errors.length > 5 && (
              <li>...y {result.errors.length - 5} más</li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
