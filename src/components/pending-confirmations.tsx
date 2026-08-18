"use client";

import { useEffect, useState, useCallback } from "react";
import { CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PendingItem {
  dedup_key: string;
  package_name: string;
  amount_native: number;
  native_currency: string;
  merchant: string | null;
  created_at: string;
}

export function PendingConfirmations() {
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [loading, setLoading] = useState<Record<string, boolean>>({});

  const fetchPending = useCallback(async () => {
    try {
      const res = await fetch("/api/push-ingest/confirm");
      if (res.ok) {
        const data = await res.json();
        setPending(data.pending ?? []);
      }
    } catch {
      // silently fail
    }
  }, []);

  // Fetching on mount and polling is exactly what an effect is for: the state
  // comes from the network, not from props, so there is nothing to derive.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchPending();
    // Poll every 30s in case new ones arrive while app is open
    const interval = setInterval(fetchPending, 30_000);
    return () => clearInterval(interval);
  }, [fetchPending]);

  async function handleAction(dedupKey: string, action: "approve" | "reject") {
    setLoading((prev) => ({ ...prev, [dedupKey]: true }));
    try {
      await fetch("/api/push-ingest/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dedup_key: dedupKey, action }),
      });
      setPending((prev) => prev.filter((p) => p.dedup_key !== dedupKey));
    } catch {
      // ignore
    }
    setLoading((prev) => ({ ...prev, [dedupKey]: false }));
  }

  if (pending.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 mb-4">
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle className="size-4 text-amber-500" />
        <span className="text-sm font-medium">
          {pending.length} transacción{pending.length > 1 ? "es" : ""} por confirmar
        </span>
      </div>
      <div className="space-y-2">
        {pending.map((item) => (
          <div
            key={item.dedup_key}
            className="flex items-center justify-between gap-2 rounded-md bg-background/50 px-3 py-2 text-sm"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium truncate">
                {item.merchant ?? item.package_name}
              </p>
              <p className="text-xs text-muted-foreground">
                {item.native_currency} {item.amount_native.toLocaleString("es-AR")}
                {" · "}
                {new Date(item.created_at).toLocaleDateString("es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
              </p>
            </div>
            <div className="flex gap-1 shrink-0">
              <Button
                size="icon"
                variant="ghost"
                className="text-green-500 hover:bg-green-500/10"
                disabled={loading[item.dedup_key]}
                onClick={() => handleAction(item.dedup_key, "approve")}
                title="Confirmar"
              >
                <CheckCircle2 className="size-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="text-destructive hover:bg-destructive/10"
                disabled={loading[item.dedup_key]}
                onClick={() => handleAction(item.dedup_key, "reject")}
                title="Rechazar"
              >
                <XCircle className="size-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
