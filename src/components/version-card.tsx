"use client";

import { CheckCircle2, Info, Loader2, RefreshCw, WifiOff } from "lucide-react";

import { useSwUpdate } from "@/components/pwa-register";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BUILD_TIME, CURRENT_BUILD, formatBuildTime, shortBuild } from "@/lib/app-version";

/** Running version, and whether a newer one is deployed. */
export function VersionCard() {
  const { status, latestBuild, lastCheckedAt, checkForUpdate, applyUpdate } = useSwUpdate();
  const builtAt = formatBuildTime(BUILD_TIME);
  const checkedAt = lastCheckedAt
    ? new Intl.DateTimeFormat("es-CO", { hour: "2-digit", minute: "2-digit", hour12: false }).format(lastCheckedAt)
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Info className="size-5" />
          Versión
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="font-mono text-lg font-semibold">{shortBuild(CURRENT_BUILD)}</p>
            {builtAt && <p className="text-sm text-muted-foreground">Publicada el {builtAt}</p>}
          </div>
          <StatusBadge status={status} />
        </div>

        {status === "available" && latestBuild && (
          <p className="text-sm">
            Hay una versión más nueva publicada: <span className="font-mono">{shortBuild(latestBuild)}</span>.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {status === "available" ? (
            <Button onClick={applyUpdate} size="sm">
              <RefreshCw className="size-4" />
              Actualizar ahora
            </Button>
          ) : (
            <Button onClick={() => void checkForUpdate()} size="sm" variant="outline" disabled={status === "checking"}>
              {status === "checking" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Buscar actualización
            </Button>
          )}
          {checkedAt && <span className="text-xs text-muted-foreground">Revisado a las {checkedAt}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: ReturnType<typeof useSwUpdate>["status"] }) {
  switch (status) {
    case "current":
      return (
        <Badge variant="positive" className="gap-1">
          <CheckCircle2 className="size-3.5" />
          Al día
        </Badge>
      );
    case "available":
      return <Badge className="gap-1">Actualización disponible</Badge>;
    case "error":
      return (
        <Badge variant="outline" className="gap-1">
          <WifiOff className="size-3.5" />
          No se pudo revisar
        </Badge>
      );
    default:
      return null;
  }
}
