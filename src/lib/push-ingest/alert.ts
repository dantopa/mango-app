import { formatPercent, formatUsd } from "@/lib/format";

import type { SemaphoreResult } from "./types";
import { sendPushNotification } from "./web-push";

/**
 * Avisa por push cuando el semáforo del presupuesto cambia de estado.
 *
 * La transición se deduce del gasto anterior: el pipeline calcula también el
 * semáforo de *antes* de esta compra y lo pasa acá. Así el aviso sale exactamente
 * en el gasto que cruza la línea, sin depender de memoria del proceso — que en
 * serverless se pierde en cada cold start, y era por qué la versión anterior
 * avisaba de más y de menos a la vez.
 */

/** Bastante por debajo del ritmo esperado. Sólo cambia el tono del mensaje. */
const COMFORTABLE_RATIO = 0.6;

type Alert = { title: string; body: string };

/** Días de mes que faltan, contando hoy. */
function daysLeft(s: SemaphoreResult): number {
  return Math.max(1, s.days_in_month - s.day + 1);
}

/** Lo que queda por día si repartís el resto del techo en los días que faltan. */
function perDay(s: SemaphoreResult): number {
  return Math.max(0, (s.ceiling - s.spent) / daysLeft(s));
}

/**
 * `previous` es null cuando este es el primer gasto del mes: ahí siempre avisa, y
 * es el único aviso de rutina — uno por mes, con el número del día en la mano.
 * Con gasto previo avisa sólo si el estado cambió, así que un mes entero en verde
 * no genera ruido.
 */
export function buildAlert(
  previous: SemaphoreResult | null,
  current: SemaphoreResult,
): Alert | null {
  if (previous && previous.state === current.state) return null;

  // Todo redondeado a entero: en una notificación los decimales son ruido.
  const spent = `${formatUsd(Math.round(current.spent))} de ${formatUsd(Math.round(current.ceiling))}`;
  const consumed = formatPercent(Math.round(current.pct * 100) / 100);
  const expected = formatPercent(Math.round(current.expected_pct * 100) / 100);
  const budget = formatUsd(Math.round(perDay(current)));

  if (current.state === "rojo") {
    const days = daysLeft(current);
    return {
      title: "🔴 Llegaste al techo",
      body: `${spent} (${consumed}) y ${days === 1 ? "queda 1 día" : `quedan ${days} días`} de mes. Lo que gastes ahora sale del ahorro.`,
    };
  }

  if (current.state === "amarillo") {
    return {
      title: "🟡 Vas más rápido de lo esperado",
      body: `${spent} (${consumed}) cuando tocaba ${expected}. Con ${budget} por día cerrás el mes en verde.`,
    };
  }

  if (previous === null) {
    return {
      title: "🟢 Arrancó el mes",
      body: `${spent} (${consumed}). Tenés ${budget} por día para llegar cómodo a fin de mes.`,
    };
  }

  return current.pct <= current.expected_pct * COMFORTABLE_RATIO
    ? {
        title: "🟢 Vas muy bien",
        body: `${spent} (${consumed}) cuando lo esperado era ${expected}. Seguí así: te sobran ${budget} por día.`,
      }
    : {
        title: "🟢 Volviste al ritmo",
        body: `${spent} (${consumed}) contra ${expected} esperado. Bien ahí, podés gastar ${budget} por día.`,
      };
}

/**
 * Manda el aviso si hubo cambio de estado. No propaga errores: el gasto ya quedó
 * registrado y una notificación que no sale no puede deshacer eso.
 */
export async function checkAndAlert(
  userId: string,
  previous: SemaphoreResult | null,
  current: SemaphoreResult,
): Promise<void> {
  const alert = buildAlert(previous, current);
  if (!alert) return;

  try {
    const { sent, failed } = await sendPushNotification(userId, {
      ...alert,
      // Un solo tag: sólo importa el estado de ahora, así el aviso nuevo reemplaza
      // al anterior en la bandeja en vez de apilarse.
      tag: "semaforo",
      data: { url: "/gastos" },
    });

    console.log(
      "[push-ingest][alert]",
      JSON.stringify({
        from: previous?.state ?? null,
        to: current.state,
        title: alert.title,
        sent,
        failed,
      }),
    );
  } catch (e) {
    console.error("[push-ingest][alert] error:", e);
  }
}
