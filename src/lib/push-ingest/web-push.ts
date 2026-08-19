import webpush from "web-push";
import { getSupabaseAdmin } from "./supabase-admin";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? "mailto:pato@pde-it.com";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

export type PushNotificationPayload = {
  title: string;
  body: string;
  icon?: string;
  tag?: string;
  data?: Record<string, unknown>;
};

/**
 * `high` porque estos avisos son de una compra que acaba de pasar. Con la urgencia
 * por defecto (`normal`) FCM considera el mensaje diferible y en un teléfono en
 * Doze lo retiene hasta la próxima ventana de mantenimiento o hasta que se abre la
 * app — que era justamente el síntoma: la compra quedaba registrada en un segundo
 * y la notificación aparecía recién al abrir Maquinita.
 *
 * TTL corto por lo mismo: si el teléfono estuvo horas sin red, un aviso de
 * "compra registrada" viejo ya no informa nada, sólo molesta.
 */
const DELIVERY_OPTIONS = { urgency: "high", TTL: 6 * 60 * 60 } as const;

/**
 * Send a web push notification to all subscriptions for a user.
 * Silently removes stale subscriptions (410 Gone).
 */
export async function sendPushNotification(
  userId: string,
  payload: PushNotificationPayload,
): Promise<{ sent: number; failed: number }> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.warn("[web-push] VAPID keys not configured, skipping notification");
    return { sent: 0, failed: 0 };
  }

  const supabase = getSupabaseAdmin();
  const { data: subscriptions } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, keys_p256dh, keys_auth")
    .eq("user_id", userId);

  if (!subscriptions || subscriptions.length === 0) {
    return { sent: 0, failed: 0 };
  }

  const jsonPayload = JSON.stringify(payload);
  let sent = 0;
  let failed = 0;

  await Promise.allSettled(
    subscriptions.map(async (sub: { id: string; endpoint: string; keys_p256dh: string; keys_auth: string }) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: {
          p256dh: sub.keys_p256dh,
          auth: sub.keys_auth,
        },
      };

      try {
        await webpush.sendNotification(pushSubscription, jsonPayload, DELIVERY_OPTIONS);
        sent++;
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        if (statusCode === 410 || statusCode === 404) {
          // Subscription expired — clean up
          const { error } = await supabase.from("push_subscriptions").delete().eq("id", sub.id);
          if (error) {
            console.error(`[web-push] failed to remove stale subscription ${sub.id}:`, error.message);
          }
        }
        failed++;
      }
    }),
  );

  return { sent, failed };
}
