"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck, ShieldX, Smartphone } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type State =
  | { status: "pairing" }
  | { status: "missing" }
  | { status: "paired"; label: string }
  | { status: "failed"; code: string };

async function approve(code: string): Promise<State> {
  if (!code) return { status: "missing" };
  try {
    const res = await fetch("/api/push-ingest/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) return { status: "failed", code };
    const data = await res.json();
    return { status: "paired", label: data.label };
  } catch {
    return { status: "failed", code };
  }
}

/**
 * Approves the Android app's pairing request.
 *
 * The code arrives in the URL fragment, not the query string, so it never reaches
 * a server log or a referrer header — this page is the only thing that ever sees
 * it, and it posts it straight back over the authenticated session.
 */
export default function PairPage() {
  const [state, setState] = useState<State>({ status: "pairing" });

  const retry = useCallback((code: string) => {
    setState({ status: "pairing" });
    void approve(code).then(setState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const code = window.location.hash.replace(/^#/, "");
    // Dropped from the URL before anything else can read it back.
    if (code) history.replaceState(null, "", window.location.pathname);

    void approve(code).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Vincular teléfono</h1>
        <p className="text-muted-foreground">
          Autoriza a la app de Android a enviar tus notificaciones de gastos
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="size-5" />
            Estado
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {state.status === "pairing" ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Vinculando…
            </p>
          ) : null}

          {state.status === "paired" ? (
            <>
              <p className="flex items-center gap-2 text-sm font-medium text-emerald-600">
                <ShieldCheck className="size-4" />
                {state.label} quedó vinculado
              </p>
              <p className="text-sm text-muted-foreground">
                Ya podés volver a Maquinita. Las notificaciones de tus apps
                financieras van a llegar solas.
              </p>
            </>
          ) : null}

          {state.status === "missing" ? (
            <p className="text-sm text-muted-foreground">
              Esta pantalla se abre desde la app de Android, con el botón
              &ldquo;Vincular este teléfono&rdquo;. No hay ningún código para
              aprobar.
            </p>
          ) : null}

          {state.status === "failed" ? (
            <>
              <p className="flex items-center gap-2 text-sm font-medium text-destructive">
                <ShieldX className="size-4" />
                No se pudo vincular
              </p>
              <p className="text-sm text-muted-foreground">
                El código ya se usó o venció (dura 10 minutos). Volvé a tocar
                &ldquo;Vincular este teléfono&rdquo; en la app.
              </p>
              <Button variant="outline" size="sm" onClick={() => retry(state.code)}>
                Reintentar
              </Button>
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
