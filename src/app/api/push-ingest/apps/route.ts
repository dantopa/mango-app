import { NextResponse } from "next/server";

import { bearerToken } from "@/lib/push-ingest/auth";
import { authenticateDevice } from "@/lib/push-ingest/devices";
import {
  appDecisionSchema,
  buildPolicy,
  NEVER_ALLOWED,
  saveAppDecision,
} from "@/lib/push-ingest/package-policy";
import { checkRateLimit } from "@/lib/push-ingest/rate-limiter";
import { getSupabaseAdmin } from "@/lib/push-ingest/supabase-admin";
import { isOwner } from "@/lib/owner";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The list of apps the notification reader forwards.
 *
 * GET  → what the phone should listen to: { allowed, blocked, decisions }.
 * POST → records a decision: { packageName, label?, decision: "allowed"|"blocked" }.
 *
 * Two callers, two credentials: the phone with its paired device token (it asks
 * "¿Registrar los pagos de esta app?" and reports the answer), and the settings
 * screen with the browser session. The shared ingest secret is not accepted: it
 * can post notifications, not decide what gets read.
 */
async function resolveCaller(
  request: Request,
): Promise<{ userId: string; via: "device" | "web" } | null> {
  const token = bearerToken(request.headers.get("authorization"));
  if (token) {
    const device = await authenticateDevice(token, new Date());
    return device ? { userId: device.userId, via: "device" } : null;
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isOwner(user.id)) return null;
  return { userId: user.id, via: "web" };
}

function rateLimited(request: Request): NextResponse | null {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const limit = checkRateLimit(`apps:${ip}`);
  if (limit.allowed) return null;
  return NextResponse.json(
    { error: "rate_limited" },
    { status: 429, headers: { ...NO_STORE, "Retry-After": String(limit.retryAfter) } },
  );
}

export async function GET(request: Request): Promise<NextResponse> {
  const limited = rateLimited(request);
  if (limited) return limited;

  const caller = await resolveCaller(request);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });

  const { data, error } = await getSupabaseAdmin()
    .from("push_ingest_apps")
    .select("package_name, label, decision, decided_via, updated_at")
    .eq("user_id", caller.userId)
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("[push-ingest/apps] read failed:", error.message);
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: NO_STORE });
  }

  const policy = buildPolicy(data ?? []);
  return NextResponse.json(
    {
      allowed: [...policy.allowed].sort(),
      blocked: [...policy.blocked].sort(),
      never: [...NEVER_ALLOWED].sort(),
      decisions: data ?? [],
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const limited = rateLimited(request);
  if (limited) return limited;

  const caller = await resolveCaller(request);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: NO_STORE });
  }

  const parsed = appDecisionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_decision" }, { status: 400, headers: NO_STORE });
  }

  const saved = await saveAppDecision(caller.userId, parsed.data, caller.via);
  if (!saved.ok) {
    return saved.reason === "never_allowed"
      ? NextResponse.json({ error: "never_allowed" }, { status: 422, headers: NO_STORE })
      : NextResponse.json({ error: "internal_error" }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json({ status: "saved" }, { headers: NO_STORE });
}
