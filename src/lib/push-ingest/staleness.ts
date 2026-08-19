import { getSupabaseAdmin } from "./supabase-admin";
import { sendPushNotification } from "./web-push";

/**
 * The notification reader is a sensor that can die silently: the phone's
 * forwarder app gets uninstalled, loses its notification-access permission, or
 * the phone is replaced, and the ingest simply stops. That happened for two
 * months without anything noticing, so the daily cron now checks that the sensor
 * is still reporting and pushes an alert when it goes quiet.
 */
const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
const MS_PER_HOUR = 3_600_000;

export type StalenessReport = {
  user_id: string;
  last_seen_at: string | null;
  hours_since: number | null;
  stale: boolean;
  alerted: boolean;
};

/**
 * A user who never received a notification has no baseline to compare against —
 * the reader was never connected, which is not a regression to alert about.
 */
export function evaluateStaleness(
  lastSeenAt: string | null,
  now: number,
): { stale: boolean; hoursSince: number | null } {
  if (!lastSeenAt) return { stale: false, hoursSince: null };

  const elapsed = now - new Date(lastSeenAt).getTime();
  if (!Number.isFinite(elapsed)) return { stale: false, hoursSince: null };

  return {
    stale: elapsed > STALE_AFTER_MS,
    hoursSince: Math.floor(elapsed / MS_PER_HOUR),
  };
}

function buildAlert(hoursSince: number): { title: string; body: string } {
  const days = Math.floor(hoursSince / 24);
  const age = days >= 1 ? `${days} ${days === 1 ? "día" : "días"}` : `${hoursSince} horas`;
  return {
    title: "🔇 No llegan notificaciones",
    body: `La última llegó hace ${age}. Revisá que el lector esté activo y con permiso de acceso a notificaciones.`,
  };
}

/**
 * Alerts every user whose push ingest has gone quiet. Only users with a push
 * subscription are checked: they are the ones who can be reached, and a
 * subscription is what marks the reader as expected to be running.
 */
export async function alertStaleIngest(now: number): Promise<StalenessReport[]> {
  const supabase = getSupabaseAdmin();

  const { data: subscriptions, error } = await supabase
    .from("push_subscriptions")
    .select("user_id");

  if (error) {
    console.error("[push-ingest][staleness] could not read subscriptions:", error.message);
    return [];
  }

  const userIds = [...new Set((subscriptions ?? []).map((s) => s.user_id))];
  const reports: StalenessReport[] = [];

  for (const userId of userIds) {
    const { data: latest, error: latestError } = await supabase
      .from("push_raw_log")
      .select("received_at")
      .eq("user_id", userId)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestError) {
      console.error("[push-ingest][staleness] could not read raw log:", latestError.message);
      continue;
    }

    const lastSeenAt = latest?.received_at ?? null;
    const { stale, hoursSince } = evaluateStaleness(lastSeenAt, now);

    let alerted = false;
    if (stale && hoursSince !== null) {
      const { sent } = await sendPushNotification(userId, {
        ...buildAlert(hoursSince),
        tag: "ingest-stale",
        data: { url: "/" },
      });
      alerted = sent > 0;
    }

    reports.push({ user_id: userId, last_seen_at: lastSeenAt, hours_since: hoursSince, stale, alerted });
  }

  return reports;
}
