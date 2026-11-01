import { z } from "zod";

import { PACKAGE_WHITELIST } from "./package-whitelist";
import { getSupabaseAdmin } from "./supabase-admin";

/**
 * Which apps' notifications are accepted, per user.
 *
 * The built-in list (PACKAGE_WHITELIST) is the starting point. On top of it the
 * user's decisions in push_ingest_apps add apps nobody hard-coded and block ones
 * that turned out to be noise. The phone downloads the result, so adding a bank no
 * longer means rebuilding the APK.
 */

/**
 * Apps whose notifications are people talking, not money moving. They are never
 * accepted, whatever a decision row says: one tap on the wrong "Sí" must not start
 * shipping someone's chats to the server. The phone has the same list.
 */
export const NEVER_ALLOWED = new Set([
  "com.whatsapp",
  "com.whatsapp.w4b",
  "org.telegram.messenger",
  "org.thoughtcrime.securesms", // Signal
  "com.facebook.orca", // Messenger
  "com.instagram.android",
  "com.discord",
  "com.slack",
  "com.google.android.gm", // Gmail
  "com.microsoft.office.outlook",
  "com.google.android.apps.dynamite", // Google Chat
  "com.microsoft.teams",
  "com.snapchat.android",
  "com.twitter.android",
  "com.zhiliaoapp.musically", // TikTok
]);

export const appDecisionSchema = z.object({
  packageName: z
    .string()
    .max(255)
    .regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/, "not an Android package name"),
  label: z.string().trim().max(80).optional().nullable(),
  decision: z.enum(["allowed", "blocked"]),
});

export type AppDecision = z.infer<typeof appDecisionSchema>;

export type DecisionRow = {
  package_name: string;
  label?: string | null;
  decision: string;
};

export type PackagePolicy = {
  allowed: ReadonlySet<string>;
  blocked: ReadonlySet<string>;
};

/**
 * Defaults plus decisions. A decision wins over a default in both directions, and
 * NEVER_ALLOWED wins over everything.
 */
export function buildPolicy(
  rows: readonly DecisionRow[],
  defaults: ReadonlySet<string> = PACKAGE_WHITELIST,
): PackagePolicy {
  const allowed = new Set(defaults);
  const blocked = new Set<string>();

  for (const row of rows) {
    if (row.decision === "allowed") {
      allowed.add(row.package_name);
      blocked.delete(row.package_name);
    } else if (row.decision === "blocked") {
      blocked.add(row.package_name);
      allowed.delete(row.package_name);
    }
  }

  for (const pkg of NEVER_ALLOWED) {
    allowed.delete(pkg);
    blocked.add(pkg);
  }

  return { allowed, blocked };
}

export function isAllowed(policy: PackagePolicy, packageName: string): boolean {
  return policy.allowed.has(packageName);
}

/**
 * The user's policy, read fresh. One indexed query of a handful of rows: cheap
 * enough to run per notification, and a cache would only delay a decision the
 * user just made on the phone.
 *
 * On a read error the defaults are returned, never an empty list: losing an
 * expense from a known bank is worse than briefly ignoring a new decision.
 */
export async function loadPackagePolicy(userId: string): Promise<PackagePolicy> {
  const { data, error } = await getSupabaseAdmin()
    .from("push_ingest_apps")
    .select("package_name, label, decision")
    .eq("user_id", userId);

  if (error) {
    console.error("[push-ingest] package policy read failed:", error.message);
    return buildPolicy([]);
  }
  return buildPolicy(data ?? []);
}

/** Records a decision; the latest one for a package replaces the previous. */
export async function saveAppDecision(
  userId: string,
  decision: AppDecision,
  via: "device" | "web",
): Promise<{ ok: true } | { ok: false; reason: "never_allowed" | "db_error" }> {
  if (decision.decision === "allowed" && NEVER_ALLOWED.has(decision.packageName)) {
    return { ok: false, reason: "never_allowed" };
  }

  const { error } = await getSupabaseAdmin()
    .from("push_ingest_apps")
    .upsert(
      {
        user_id: userId,
        package_name: decision.packageName,
        label: decision.label || null,
        decision: decision.decision,
        decided_via: via,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,package_name" },
    );

  if (error) {
    console.error("[push-ingest] app decision save failed:", error.message);
    return { ok: false, reason: "db_error" };
  }
  return { ok: true };
}
