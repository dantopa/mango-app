"use client";

import { Bell, BellOff } from "lucide-react";
import { usePushNotifications } from "@/hooks/use-push-notifications";

export function PushNotificationToggle() {
  const { permission, isSubscribed, isLoading, subscribe, unsubscribe } =
    usePushNotifications();

  if (permission === "unsupported") return null;

  if (permission === "denied") {
    return (
      <button
        disabled
        className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md px-3 py-2 text-xs text-muted-foreground opacity-50"
        title="Notificaciones bloqueadas en el navegador"
      >
        <BellOff className="h-4 w-4" />
        <span className="hidden sm:inline">Bloqueadas</span>
      </button>
    );
  }

  if (isSubscribed) {
    return (
      <button
        onClick={unsubscribe}
        disabled={isLoading}
        className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md px-3 py-2 text-xs text-emerald-600 hover:bg-muted transition-colors"
        title="Notificaciones activas — click para desactivar"
      >
        <Bell className="h-4 w-4" />
        <span className="hidden sm:inline">Notificaciones</span>
      </button>
    );
  }

  return (
    <button
      onClick={subscribe}
      disabled={isLoading}
      className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md px-3 py-2 text-xs text-muted-foreground hover:bg-muted transition-colors"
      title="Activar notificaciones de gastos"
    >
      <BellOff className="h-4 w-4" />
      <span className="hidden sm:inline">Activar alertas</span>
    </button>
  );
}
