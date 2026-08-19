import { NextResponse } from "next/server";

import { validateIngestAuth } from "@/lib/push-ingest/auth";
import { isWhitelistedPackage } from "@/lib/push-ingest/package-whitelist";
import { executePipeline } from "@/lib/push-ingest/pipeline";
import { checkRateLimit } from "@/lib/push-ingest/rate-limiter";
import { pushPayloadSchema } from "@/lib/push-ingest/schemas";
import { getSupabaseAdmin } from "@/lib/push-ingest/supabase-admin";
import type { Json } from "@/lib/supabase/database.types";

const OWNER_USER_ID = "e99371b1-6163-4216-b624-c79d8ee01520";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // 1. Extract IP from x-forwarded-for (Vercel provides this)
    const forwarded = request.headers.get("x-forwarded-for");
    const ip = forwarded?.split(",")[0]?.trim() ?? "unknown";

    // 2. Rate limit check
    const rateResult = checkRateLimit(ip);
    if (!rateResult.allowed) {
      return NextResponse.json(
        { error: "rate_limited" },
        {
          status: 429,
          headers: { "Retry-After": String(rateResult.retryAfter) },
        },
      );
    }

    // 3. Auth validation (shared secret or a paired device token)
    const authResult = await validateIngestAuth(request.headers.get("authorization"));
    if (!authResult.ok) {
      return NextResponse.json(authResult.body, { status: authResult.status });
    }

    // 4. Parse JSON body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }

    // 5. Extract package name and check whitelist
    // Came from request.json(), so every value is JSON-serializable by construction.
    const rawPayload = body as Record<string, Json>;
    const packageName = String(rawPayload.packageName ?? rawPayload.appName ?? rawPayload.package ?? "unknown");

    if (!isWhitelistedPackage(packageName)) {
      return NextResponse.json({ status: "ignored", package_name: packageName });
    }

    // 6. Save raw log (so we never lose a whitelisted notification)
    const supabase = getSupabaseAdmin();

    const { error: rawLogError } = await supabase
      .from("push_raw_log")
      .insert({
        user_id: OWNER_USER_ID,
        package_name: packageName,
        payload: rawPayload,
        received_at: new Date().toISOString(),
      });
    if (rawLogError) {
      // The raw log is the only recovery path for a notification we fail to parse.
      console.error(`[push-ingest] raw log insert failed for ${packageName}:`, rawLogError.message);
    }

    // 7. Validate and run pipeline
    const parseResult = pushPayloadSchema.safeParse(body);
    if (!parseResult.success) {
      // Logged raw but can't process — respond 200 (notification is safe)
      return NextResponse.json({ status: "logged", parse_errors: parseResult.error.flatten().fieldErrors });
    }

    const payload = parseResult.data;
    const result = await executePipeline(payload, "full_pipeline");
    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: "internal_server_error" },
      { status: 500 },
    );
  }
}
