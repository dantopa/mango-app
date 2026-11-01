"use client";

import { useCallback, useEffect, useState } from "react";
import { AppWindow } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Decision = {
  package_name: string;
  label: string | null;
  decision: "allowed" | "blocked";
  decided_via: "device" | "web";
  updated_at: string;
};

type AppsResponse = {
  allowed: string[];
  blocked: string[];
  never: string[];
  decisions: Decision[];
};

/** Friendly names for the built-in list; anything else shows its label or package. */
const KNOWN_NAMES: Record<string, string> = {
  "com.todo1.mobile": "Bancolombia",
  "com.bbva.nxt_argentina": "BBVA Argentina",
  "com.nequi.MobileApp": "Nequi",
  "com.brubank": "Brubank",
  "com.grability.rappi": "Rappi",
  "com.google.android.apps.walletnfcrel": "Google Wallet",
  "com.nexowallet": "Nexo",
  "com.google.android.apps.messaging": "Mensajes (SMS)",
  "com.samsung.android.messaging": "Mensajes Samsung (SMS)",
  "com.android.mms": "SMS",
};

function displayName(pkg: string, label?: string | null): string {
  return label || KNOWN_NAMES[pkg] || pkg;
}

/**
 * The apps the phone's reader listens to. New ones show up here after the user
 * answers "¿Registrar los pagos de esta app?" on the phone, and any of them can be
 * switched off or back on — the phone picks the change up on its next sync, with
 * no reinstall.
 */
export function ConnectedAppsCard() {
  const [data, setData] = useState<AppsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/push-ingest/apps", { cache: "no-store" });
    if (!res.ok) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setData(await res.json());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/push-ingest/apps", { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) return setFailed(true);
        setData(await res.json());
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const decide = async (pkg: string, label: string | null, decision: "allowed" | "blocked") => {
    setBusy(pkg);
    try {
      await fetch("/api/push-ingest/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageName: pkg, label, decision }),
      });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const labels = new Map(data?.decisions.map((d) => [d.package_name, d.label]) ?? []);
  const never = new Set(data?.never ?? []);
  // Chat apps are blocked by design, not by a choice: listing them as "bloqueada"
  // with a button to undo it would offer something the server refuses.
  const blocked = (data?.blocked ?? []).filter((pkg) => !never.has(pkg));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AppWindow className="size-5" />
          Apps conectadas
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          De estas apps el teléfono lee los pagos. Cuando aparece una nueva que parece de plata,
          te pregunta en el celular; nada sale del teléfono hasta que digas que sí.
        </p>

        {failed ? (
          <p className="text-sm text-destructive">No se pudo cargar la lista.</p>
        ) : data === null ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : (
          <>
            {data.allowed.map((pkg) => (
              <AppRow
                key={pkg}
                name={displayName(pkg, labels.get(pkg))}
                pkg={pkg}
                status="allowed"
                busy={busy === pkg}
                onToggle={() => decide(pkg, labels.get(pkg) ?? null, "blocked")}
              />
            ))}
            {blocked.map((pkg) => (
              <AppRow
                key={pkg}
                name={displayName(pkg, labels.get(pkg))}
                pkg={pkg}
                status="blocked"
                busy={busy === pkg}
                onToggle={() => decide(pkg, labels.get(pkg) ?? null, "allowed")}
              />
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AppRow({
  name,
  pkg,
  status,
  busy,
  onToggle,
}: {
  name: string;
  pkg: string;
  status: "allowed" | "blocked";
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
      <div className="min-w-0 space-y-1">
        <p className="flex items-center gap-2 truncate text-sm font-medium">
          {name}
          {status === "blocked" && <Badge variant="secondary">Ignorada</Badge>}
        </p>
        <p className="truncate text-xs text-muted-foreground">{pkg}</p>
      </div>
      <Button variant="outline" size="sm" disabled={busy} onClick={onToggle}>
        {status === "allowed" ? "Ignorar" : "Registrar"}
      </Button>
    </div>
  );
}
