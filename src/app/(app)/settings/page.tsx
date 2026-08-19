"use client";

import { useState, useEffect, useCallback } from "react";
import { Bell, BellOff, Send, RefreshCw, Smartphone } from "lucide-react";

import { usePushNotifications } from "@/hooks/use-push-notifications";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

function timestamp() {
  return new Date().toLocaleTimeString("es-AR", { hour12: false });
}

type Device = {
  id: string;
  label: string;
  paired_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
};

async function fetchDevices(): Promise<Device[]> {
  const res = await fetch("/api/push-ingest/devices");
  if (!res.ok) return [];
  const data = await res.json();
  return data.devices;
}

/**
 * Paired phones. This is the only place a lost device can be cut off: its token
 * exists nowhere but on the phone, so revoking the row is the only lever there is.
 */
function DevicesCard() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchDevices().then((loaded) => {
      if (!cancelled) setDevices(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const revoke = async (id: string) => {
    setBusyId(id);
    await fetch("/api/push-ingest/devices", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setDevices(await fetchDevices());
    setBusyId(null);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="size-5" />
          Teléfonos vinculados
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {devices === null ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Ninguno. Se vinculan desde la app de Android, con &ldquo;Vincular este
            teléfono&rdquo;.
          </p>
        ) : (
          devices.map((device) => (
            <div
              key={device.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
            >
              <div className="min-w-0 space-y-1">
                <p className="truncate text-sm font-medium">{device.label}</p>
                <p className="text-xs text-muted-foreground">
                  {device.last_used_at
                    ? `Último uso: ${new Date(device.last_used_at).toLocaleString("es-AR")}`
                    : "Todavía no envió nada"}
                </p>
              </div>
              {device.revoked_at ? (
                <Badge variant="destructive">Revocado</Badge>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyId === device.id}
                  onClick={() => revoke(device.id)}
                >
                  Revocar
                </Button>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { permission, isSubscribed, isLoading, subscribe, unsubscribe } =
    usePushNotifications();

  const [logs, setLogs] = useState<string[]>([]);
  const [swState, setSwState] = useState<{
    registered: boolean;
    state: string;
    scope: string;
  }>({ registered: false, state: "unknown", scope: "" });
  const [sendingTest, setSendingTest] = useState(false);

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev, `[${timestamp()}] ${msg}`]);
  }, []);

  // Check SW registration state on mount. Lack of support already surfaces in
  // the status badges, so nothing is logged on the early return.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg) {
        const state = reg.active
          ? "active"
          : reg.waiting
            ? "waiting"
            : reg.installing
              ? "installing"
              : "unknown";
        setSwState({ registered: true, state, scope: reg.scope });
        addLog(`✅ SW registrado — estado: ${state}, scope: ${reg.scope}`);

        // Listen for state changes
        const worker = reg.active ?? reg.waiting ?? reg.installing;
        if (worker) {
          worker.addEventListener("statechange", () => {
            const newState = worker.state;
            setSwState((prev) => ({ ...prev, state: newState }));
            addLog(`🔄 SW cambió a estado: ${newState}`);
          });
        }
      } else {
        setSwState({ registered: false, state: "not-registered", scope: "" });
        addLog("⚠️ No hay Service Worker registrado");
      }
    }).catch((err) => {
      addLog(`❌ Error al verificar SW: ${err.message}`);
    });
  }, [addLog]);

  // `permission` and `isSubscribed` are rendered live in the status badges
  // below, so the log only records events (SW resolution and user actions).

  const handleToggleSubscription = async () => {
    if (isSubscribed) {
      addLog("🔄 Desactivando subscripción push...");
      await unsubscribe();
      addLog("✅ Subscripción desactivada");
    } else {
      addLog("🔄 Activando subscripción push...");
      const success = await subscribe();
      if (success) {
        addLog("✅ Subscripción activada correctamente");
      } else {
        addLog("❌ No se pudo activar la subscripción");
      }
    }
  };

  const handleSendTest = async () => {
    setSendingTest(true);
    addLog("📤 Enviando notificación de prueba...");
    try {
      const res = await fetch("/api/push-test", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        addLog(`✅ Test enviado — ${data.sent} notificación(es) entregada(s)`);
      } else {
        addLog(`❌ Error: ${data.error ?? res.statusText}`);
      }
    } catch (err) {
      addLog(`❌ Error de red: ${(err as Error).message}`);
    } finally {
      setSendingTest(false);
    }
  };

  const handleRefreshState = () => {
    addLog("🔄 Recargando estado...");
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg) {
        const state = reg.active
          ? "active"
          : reg.waiting
            ? "waiting"
            : reg.installing
              ? "installing"
              : "unknown";
        setSwState({ registered: true, state, scope: reg.scope });
        addLog(`✅ SW: ${state}, scope: ${reg.scope}`);
      } else {
        setSwState({ registered: false, state: "not-registered", scope: "" });
        addLog("⚠️ Sin SW registrado");
      }
    });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Configuración</h1>
        <p className="text-muted-foreground">
          Diagnóstico y pruebas de notificaciones push
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="size-5" />
            Notificaciones
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Status grid */}
          <div className="grid gap-4 sm:grid-cols-2">
            {/* Service Worker */}
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-muted-foreground">
                Estado del Service Worker
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={swState.registered ? "positive" : "destructive"}
                >
                  {swState.registered ? "Registrado" : "No registrado"}
                </Badge>
                {swState.registered && (
                  <Badge variant="secondary">{swState.state}</Badge>
                )}
              </div>
              {swState.scope && (
                <p className="text-xs text-muted-foreground truncate">
                  Scope: {swState.scope}
                </p>
              )}
            </div>

            {/* Permission */}
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-muted-foreground">
                Permiso de notificaciones
              </p>
              <Badge
                variant={
                  permission === "granted"
                    ? "positive"
                    : permission === "denied"
                      ? "destructive"
                      : "secondary"
                }
              >
                {permission === "granted"
                  ? "Concedido"
                  : permission === "denied"
                    ? "Denegado"
                    : permission === "unsupported"
                      ? "No soportado"
                      : "Sin solicitar"}
              </Badge>
            </div>

            {/* Push subscription */}
            <div className="space-y-1.5 sm:col-span-2">
              <p className="text-sm font-medium text-muted-foreground">
                Subscripción Push
              </p>
              <Badge variant={isSubscribed ? "positive" : "muted"}>
                {isSubscribed ? "Subscrito" : "No subscrito"}
              </Badge>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={handleToggleSubscription}
              disabled={isLoading || permission === "unsupported"}
              variant={isSubscribed ? "outline" : "default"}
              size="sm"
            >
              {isSubscribed ? (
                <>
                  <BellOff className="size-4" />
                  Desactivar
                </>
              ) : (
                <>
                  <Bell className="size-4" />
                  Activar
                </>
              )}
            </Button>

            <Button
              onClick={handleSendTest}
              disabled={sendingTest || !isSubscribed}
              variant="secondary"
              size="sm"
            >
              <Send className="size-4" />
              Enviar test
            </Button>

            <Button
              onClick={handleRefreshState}
              variant="ghost"
              size="sm"
            >
              <RefreshCw className="size-4" />
              Recargar estado
            </Button>
          </div>
        </CardContent>
      </Card>

      <DevicesCard />

      {/* Logs panel */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-sm">Logs</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLogs([])}
            className="h-7 text-xs text-muted-foreground"
          >
            Limpiar
          </Button>
        </CardHeader>
        <CardContent>
          <div className="h-56 overflow-y-auto rounded-lg bg-muted/50 p-3 font-mono text-xs leading-relaxed">
            {logs.length === 0 ? (
              <p className="text-muted-foreground">Sin eventos aún...</p>
            ) : (
              logs.map((log, i) => (
                <p key={i} className="text-foreground/80">
                  {log}
                </p>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
