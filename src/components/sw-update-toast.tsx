"use client";

import { useEffect, useRef } from "react";
import { RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";

interface SwUpdateToastProps {
  /** Whether a new SW version is waiting to activate */
  visible: boolean;
  /** Callback to trigger SW update (post SKIP_WAITING + reload) */
  onReload: () => void;
  /** Callback when user dismisses the toast */
  onDismiss: () => void;
}

const AUTO_DISMISS_MS = 10_000;

/**
 * Bottom-positioned dismissible toast shown when a SW update is available.
 * Displays "Actualización disponible" with a reload button.
 * Auto-dismisses after 10 seconds if not interacted with.
 */
export function SwUpdateToast({ visible, onReload, onDismiss }: SwUpdateToastProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // Auto-dismiss after 10s. Cleared on unmount, on interaction, or when the
  // update goes away — onDismiss() flips `visible` in the parent, so there is
  // no local copy of the visibility to keep in sync.
  useEffect(() => {
    if (!visible) return;
    timerRef.current = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [visible, onDismiss]);

  if (!visible) return null;

  const handleReload = () => {
    clearTimer();
    onReload();
  };

  const handleDismiss = () => {
    clearTimer();
    onDismiss();
  };

  return (
    <div
      role="alert"
      aria-live="polite"
      className="fixed bottom-20 left-4 right-4 z-50 mx-auto max-w-sm animate-in slide-in-from-bottom-4 fade-in duration-300 rounded-lg border border-border bg-card px-4 py-3 shadow-lg"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-card-foreground">
          <RefreshCw className="size-4 shrink-0 text-primary" />
          <span>Actualización disponible</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="default"
            size="sm"
            onClick={handleReload}
            className="h-8 px-3 text-xs"
          >
            Recargar
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleDismiss}
            className="size-8"
            aria-label="Cerrar"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
