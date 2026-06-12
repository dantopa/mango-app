"use client";

import { useState, useCallback, useEffect } from "react";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

/**
 * Convert VAPID public key from base64url to Uint8Array for the Push API.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

export type PushPermissionState = "prompt" | "granted" | "denied" | "unsupported";

export function usePushNotifications() {
  const [permission, setPermission] = useState<PushPermissionState>("prompt");
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Check current state on mount
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      console.log("[push-debug] unsupported: SW=", "serviceWorker" in navigator, "PushManager=", "PushManager" in window);
      setPermission("unsupported");
      return;
    }

    const perm = Notification.permission as PushPermissionState;
    console.log("[push-debug] Notification.permission =", perm);
    setPermission(perm);

    // Check if already subscribed
    navigator.serviceWorker.ready.then((reg) => {
      console.log("[push-debug] SW ready, checking getSubscription...");
      reg.pushManager.getSubscription().then((sub) => {
        console.log("[push-debug] getSubscription result:", sub ? sub.endpoint : "null (not subscribed)");
        setIsSubscribed(sub !== null);
      }).catch((err) => {
        console.error("[push-debug] getSubscription error:", err);
      });
    });
  }, []);

  const subscribe = useCallback(async () => {
    if (!VAPID_PUBLIC_KEY) {
      console.warn("[push-debug] VAPID public key not configured");
      return false;
    }

    console.log("[push-debug] subscribe() called, VAPID key length:", VAPID_PUBLIC_KEY.length);
    setIsLoading(true);
    try {
      // Request permission
      const result = await Notification.requestPermission();
      console.log("[push-debug] requestPermission result:", result);
      setPermission(result as PushPermissionState);

      if (result !== "granted") {
        console.log("[push-debug] permission not granted, aborting");
        return false;
      }

      // Get SW registration
      const registration = await navigator.serviceWorker.ready;
      console.log("[push-debug] SW ready for subscribe, scope:", registration.scope);

      // Subscribe to push
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
      });
      console.log("[push-debug] pushManager.subscribe OK, endpoint:", subscription.endpoint);

      // Send subscription to backend
      const response = await fetch("/api/push-subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          keys: {
            p256dh: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey("p256dh")!))),
            auth: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey("auth")!))),
          },
        }),
      });

      console.log("[push-debug] /api/push-subscribe response:", response.status);
      if (response.ok) {
        setIsSubscribed(true);
        return true;
      }

      return false;
    } catch (err) {
      console.error("[push-debug] subscription failed:", err);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const unsubscribe = useCallback(async () => {
    setIsLoading(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        await fetch("/api/push-subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }

      setIsSubscribed(false);
    } catch (err) {
      console.error("[push] unsubscribe failed:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { permission, isSubscribed, isLoading, subscribe, unsubscribe };
}
