"use client";

import { useEffect } from "react";
import { CheckCircle2, RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { shortBuild } from "@/lib/app-version";

interface SwUpdateToastProps {
  /** "available": a newer build is deployed. "updated": the app just moved to a new build. */
  kind: "available" | "updated" | null;
  /** The build being offered ("available") or now running ("updated"). */
  build: string | null;
  /** The build the app was on before an update. */
  previousBuild?: string | null;
  /** Reloads into the new build. */
  onReload: () => void;
  onDismiss: () => void;
}

/** An offer can wait a while; a confirmation is read at a glance. */
const AUTO_DISMISS_MS = { available: 15_000, updated: 6_000 } as const;

/**
 * Bottom toast for app updates: offers the new version, or confirms the app
 * just moved to one.
 */
export function SwUpdateToast({ kind, build, previousBuild, onReload, onDismiss }: SwUpdateToastProps) {
  // Cleared on unmount, on dismissal, or when the kind changes; onDismiss
  // flips `kind` in the parent, so there is no local copy to keep in sync.
  useEffect(() => {
    if (!kind) return;
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS[kind]);
    return () => clearTimeout(timer);
  }, [kind, onDismiss]);

  if (!kind) return null;

  const version = build ? shortBuild(build) : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-20 left-4 right-4 z-50 mx-auto max-w-sm animate-in slide-in-from-bottom-4 fade-in duration-300 rounded-lg border border-border bg-card px-4 py-3 shadow-lg"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-sm text-card-foreground">
          {kind === "available" ? (
            <RefreshCw className="size-4 shrink-0 text-primary" />
          ) : (
            <CheckCircle2 className="size-4 shrink-0 text-positive" />
          )}
          <div className="min-w-0">
            <p className="font-medium">
              {kind === "available" ? "Hay una versión nueva" : "Maquinita se actualizó"}
            </p>
            {version && (
              <p className="truncate text-xs text-muted-foreground">
                {kind === "updated" && previousBuild
                  ? `${shortBuild(previousBuild)} → ${version}`
                  : `Versión ${version}`}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {kind === "available" && (
            <Button variant="default" size="sm" onClick={onReload} className="h-8 px-3 text-xs">
              Actualizar
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={onDismiss} className="size-8" aria-label="Cerrar">
            <X className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
