/**
 * Gate for notifications coming from SMS apps.
 *
 * A messaging app forwards every SMS the phone receives: bank alerts, but also
 * 2FA codes, operator promos and messages from people. Without a gate all of it
 * was stored in push_raw_log, and whatever no parser recognized was sent to the
 * AI — a Coomeva approval code went to OpenAI that way, and a DirecTV promo came
 * one account lookup away from being registered as an expense. Anyone who can
 * text the phone could also forge a "Bancolombia: Compraste ..." line.
 *
 * So an SMS is only let through when its sender is a known bank short code, and
 * never when it carries a one-time code, whoever sent it. A rejected SMS is not
 * stored anywhere.
 */

/** Packages that forward SMS; everything else is an app with its own sender. */
export const SMS_PACKAGES = new Set([
  "com.google.android.apps.messaging", // Google Messages
  "com.samsung.android.messaging", // Samsung Messages
  "com.android.mms", // AOSP SMS
]);

/**
 * Bank short codes seen sending real movements (push_raw_log, Jun–Sep 2026).
 * Extend with SMS_SENDER_ALLOWLIST (comma separated) instead of editing this.
 */
const DEFAULT_SENDERS = [
  "85540", // Bancolombia: compras
  "85784", // Bancolombia: compras y pagos
  "85286", // Bancolombia: transferencias
  "50150", // BBVA
];

/**
 * A one-time code: "clave ... 12345", "código: 123456", "OTP 1234". Matched on
 * the word followed closely by the digits, so "Usa codigo TIGOON" is not one.
 */
const RE_ONE_TIME_CODE =
  /\b(?:c[oó]digo|clave(?:\s+din[aá]mica)?|otp|token|pin)\b[^0-9]{0,40}\b\d{4,8}\b/i;

export type SmsGateResult = { ok: true } | { ok: false; reason: string };

/** Lowercase letters and digits only: "+57 85540" and "85540" are the same sender. */
export function normalizeSender(sender: string): string {
  return sender.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function allowedSenders(env: string | undefined = process.env.SMS_SENDER_ALLOWLIST): Set<string> {
  const extra = (env ?? "").split(",").map(normalizeSender).filter(Boolean);
  return new Set([...DEFAULT_SENDERS.map(normalizeSender), ...extra]);
}

export function isSmsPackage(packageName: string): boolean {
  return SMS_PACKAGES.has(packageName);
}

/**
 * Decides whether an SMS may enter the pipeline. Notifications from other
 * packages always pass: the app itself is the sender.
 *
 * The sender is the notification title, which is how Android messaging apps
 * show it. A sender saved as a contact shows the contact's name instead of the
 * number and is rejected — that is the price of not trusting display names.
 */
export function checkSms(
  packageName: string,
  title: string,
  text: string,
  senders: Set<string> = allowedSenders(),
): SmsGateResult {
  if (!isSmsPackage(packageName)) return { ok: true };

  if (RE_ONE_TIME_CODE.test(text)) return { ok: false, reason: "sms_one_time_code" };

  const sender = normalizeSender(title);
  if (!sender || !senders.has(sender)) return { ok: false, reason: "sms_sender_not_allowed" };

  return { ok: true };
}
