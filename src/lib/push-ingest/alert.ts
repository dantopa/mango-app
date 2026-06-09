import type { SemaphoreState } from "./types";

/**
 * Alert stub — dispatches a notification when the semaphore state changes.
 * For now, logs to console. Future: push notification back to phone, email, or in-app.
 *
 * Idempotency: only fires once per (month, transition) pair.
 * TODO: persist last alerted state in DB to survive cold starts.
 */

let lastAlertedState: SemaphoreState | null = null;

export function checkAndAlert(
  previousState: SemaphoreState | null,
  currentState: SemaphoreState,
): void {
  // No alert if state hasn't changed
  if (previousState === currentState) return;

  // No alert if we already alerted this transition in this container lifecycle
  if (lastAlertedState === currentState) return;

  // State changed — fire alert
  lastAlertedState = currentState;

  const message = buildAlertMessage(previousState, currentState);
  console.log("[push-ingest][alert]", JSON.stringify({
    level: "alert",
    previous_state: previousState,
    current_state: currentState,
    message,
    timestamp: new Date().toISOString(),
  }));

  // TODO: implement actual alert delivery (push, email, or in-app)
}

function buildAlertMessage(
  from: SemaphoreState | null,
  to: SemaphoreState,
): string {
  if (to === "rojo") {
    return "⚠️ Presupuesto mensual alcanzado. Frenar gastos.";
  }
  if (to === "amarillo") {
    return "⚡ Estás por encima del ritmo esperado. Cuidado.";
  }
  if (to === "verde" && from !== null) {
    return "✅ Volviste al buen ritmo. Seguí así.";
  }
  return `Semáforo: ${to}`;
}
