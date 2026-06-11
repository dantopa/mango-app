"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { SwUpdateToast } from "@/components/sw-update-toast";

// ---------------------------------------------------------------------------
// Context for SW update state — consumed by sw-update-toast.tsx (task 4.5)
// ---------------------------------------------------------------------------

interface SwUpdateContextValue {
  /** True when a new SW version is installed and waiting to activate */
  hasUpdate: boolean;
  /** Triggers SKIP_WAITING on the waiting SW, causing reload on controllerchange */
  onReload: () => void;
  /** Dismiss the update notification without reloading */
  onDismiss: () => void;
}

const SwUpdateContext = createContext<SwUpdateContextValue>({
  hasUpdate: false,
  onReload: () => {},
  onDismiss: () => {},
});

/** Hook for consuming SW update state (used by sw-update-toast). */
export function useSwUpdate() {
  return useContext(SwUpdateContext);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Registers the service worker and handles the SW update lifecycle.
 *
 * Detects when a new SW is installed and waiting, listens for controllerchange
 * to reload the page, and exposes hasUpdate/onReload/onDismiss via React context
 * so the update toast can trigger SKIP_WAITING.
 */
export function PwaRegister({ children }: { children?: React.ReactNode }) {
  const [hasUpdate, setHasUpdate] = useState(false);
  const waitingSw = useRef<ServiceWorker | null>(null);

  const onReload = useCallback(() => {
    const sw = waitingSw.current;
    if (sw) {
      sw.postMessage({ type: "SKIP_WAITING" });
    }
  }, []);

  const onDismiss = useCallback(() => {
    setHasUpdate(false);
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // Track when a new SW moves to "installed" (waiting) state
    function onStateChange(this: ServiceWorker) {
      if (this.state === "installed" && navigator.serviceWorker.controller) {
        // Only show update if there's already an active controller
        // (i.e. this is a genuine update, not a first-time install)
        waitingSw.current = this;
        setHasUpdate(true);
      }
    }

    // When a new controller takes over, reload to pick up the new version.
    // Guard against multiple reloads with a flag.
    let refreshing = false;
    function onControllerChange() {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    }

    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        // If there's already a waiting SW (e.g. page was refreshed while
        // an update waited)
        if (reg.waiting) {
          waitingSw.current = reg.waiting;
          setHasUpdate(true);
          return;
        }

        // If there's an installing SW, listen for it to reach "installed"
        if (reg.installing) {
          reg.installing.addEventListener("statechange", onStateChange);
        }

        // Detect future updates
        reg.addEventListener("updatefound", () => {
          const newSw = reg.installing;
          if (newSw) {
            newSw.addEventListener("statechange", onStateChange);
          }
        });
      })
      .catch(() => {
        /* registration failures are non-fatal */
      });

    // Listen for controllerchange — the new SW has claimed clients
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange,
    );

    return () => {
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange,
      );
    };
  }, []);

  return (
    <SwUpdateContext.Provider value={{ hasUpdate, onReload, onDismiss }}>
      {children}
      <SwUpdateToast
        visible={hasUpdate}
        onReload={onReload}
        onDismiss={onDismiss}
      />
    </SwUpdateContext.Provider>
  );
}
