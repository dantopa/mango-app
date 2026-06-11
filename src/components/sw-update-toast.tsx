"use client";

import { useEffect, useRef, useState } from "react";
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
  const [show, setShow] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interactedRef = useRef(false);

  useEffect(() => {
    if (visible) {
      setShow(true);
      interactedRef.current = false;

      timerRef.current = setTimeout(() => {
        if (!interactedRef.current) {
          setShow(false);
          onDismiss();
        }
      }, AUTO_DISMISS_MS);
    } else {
      setShow(false);
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [visible, onDismiss]);

  if (!show) return null;

  const handleReload = () => {
    interactedRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    onReload();
  };

  const handleDismiss = () => {
    interactedRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    setShow(false);
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
