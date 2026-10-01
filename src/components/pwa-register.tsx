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
import { CURRENT_BUILD, isNewerBuild, takeUpdatedFrom } from "@/lib/app-version";

// ---------------------------------------------------------------------------
// Context: what version is running and whether a newer one is deployed
// ---------------------------------------------------------------------------

export type UpdateStatus = "idle" | "checking" | "current" | "available" | "error";

interface SwUpdateContextValue {
  status: UpdateStatus;
  /** Build the server reported on the last successful check. */
  latestBuild: string | null;
  /** When the last check finished (ms), or null if none yet. */
  lastCheckedAt: number | null;
  /** Asks the server for the deployed build. */
  checkForUpdate: () => Promise<void>;
  /** Reloads into the deployed build. */
  applyUpdate: () => void;
}

const SwUpdateContext = createContext<SwUpdateContextValue>({
  status: "idle",
  latestBuild: null,
  lastCheckedAt: null,
  checkForUpdate: async () => {},
  applyUpdate: () => {},
});

/** Version and update state, for the toast and the Ajustes card. */
export function useSwUpdate() {
  return useContext(SwUpdateContext);
}

/** Background checks: on return to the app, at most this often. */
const RESUME_CHECK_MIN_INTERVAL_MS = 5 * 60 * 1000;
/** ...and periodically while it stays open. */
const PERIODIC_CHECK_MS = 30 * 60 * 1000;
/** First check after load, once the page has settled. */
const FIRST_CHECK_DELAY_MS = 3000;
/** The "se actualizó" confirmation waits for the first paint. */
const UPDATED_TOAST_DELAY_MS = 800;

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Registers the service worker and tracks the app version.
 *
 * Opening the app always loads the deployed build (navigation is network
 * first). What goes stale is a session resumed from the background — the usual
 * case in the Android app — which keeps running the code it loaded. So the
 * deployed build is asked for on load, on every return to the app and every
 * half hour, and a newer one is offered with a toast instead of reloading
 * under the owner's fingers. After the reload, a second toast confirms it.
 */
export function PwaRegister({ children }: { children?: React.ReactNode }) {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [latestBuild, setLatestBuild] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [toast, setToast] = useState<"available" | "updated" | null>(null);
  const [updatedFrom, setUpdatedFrom] = useState<string | null>(null);
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const lastCheck = useRef(0);
  const announced = useRef<string | null>(null);

  const checkForUpdate = useCallback(async () => {
    lastCheck.current = Date.now();
    setStatus((s) => (s === "available" ? s : "checking"));
    try {
      const res = await fetch("/api/version", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const { build } = (await res.json()) as { build?: string };
      setLatestBuild(build ?? null);
      if (isNewerBuild(CURRENT_BUILD, build)) {
        setStatus("available");
        // Announce each new build once, not on every check.
        if (build && announced.current !== build) {
          announced.current = build;
          setToast("available");
        }
        // Have the new service worker ready before the reload.
        registration.current?.update().catch(() => {});
      } else {
        setStatus("current");
      }
    } catch {
      // Offline or the request failed: nothing is known, nothing is offered.
      setStatus((s) => (s === "available" ? s : "error"));
    } finally {
      setLastCheckedAt(Date.now());
    }
  }, []);

  const applyUpdate = useCallback(() => {
    // Navigation is network first, so a reload is what loads the new build.
    window.location.reload();
  }, []);

  // Confirm an update that just happened. Read after mount (storage does not
  // exist on the server render), and shown once the page has painted.
  useEffect(() => {
    const timer = setTimeout(() => {
      const previous = takeUpdatedFrom(safeLocalStorage());
      if (previous) {
        setUpdatedFrom(previous);
        setToast("updated");
      }
    }, UPDATED_TOAST_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  // Service worker registration.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        registration.current = reg;
      })
      .catch(() => {
        /* registration failures are non-fatal */
      });
  }, []);

  // When to ask the server.
  useEffect(() => {
    const first = setTimeout(checkForUpdate, FIRST_CHECK_DELAY_MS);
    const periodic = setInterval(checkForUpdate, PERIODIC_CHECK_MS);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastCheck.current < RESUME_CHECK_MIN_INTERVAL_MS) return;
      void checkForUpdate();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(first);
      clearInterval(periodic);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [checkForUpdate]);

  const dismissToast = useCallback(() => setToast(null), []);

  return (
    <SwUpdateContext.Provider value={{ status, latestBuild, lastCheckedAt, checkForUpdate, applyUpdate }}>
      {children}
      <SwUpdateToast
        kind={toast}
        build={toast === "updated" ? CURRENT_BUILD : latestBuild}
        previousBuild={updatedFrom}
        onReload={applyUpdate}
        onDismiss={dismissToast}
      />
    </SwUpdateContext.Provider>
  );
}
