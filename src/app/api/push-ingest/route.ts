import { NextResponse } from "next/server";

import { validateAuth } from "@/lib/push-ingest/auth";
import { executePipeline } from "@/lib/push-ingest/pipeline";
import { checkRateLimit } from "@/lib/push-ingest/rate-limiter";
import { pushPayloadSchema } from "@/lib/push-ingest/schemas";
import { getSupabaseAdmin } from "@/lib/push-ingest/supabase-admin";
import type { IngestMode } from "@/lib/push-ingest/types";

const OWNER_USER_ID =
  process.env.MAQUINITA_OWNER_USER_ID ??
  "49b33f55-dcf2-4370-ba9a-204b91f2551d";

/** Resolve the ingest mode from env — anything other than "full_pipeline" defaults to "log_only" */
function resolveMode(): IngestMode {
  const raw = process.env.PUSH_INGEST_MODE;
  return raw === "full_pipeline" ? "full_pipeline" : "log_only";
}

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

    // 3. Auth validation
    const authResult = validateAuth(request.headers.get("authorization"));
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

    // 5. Zod validation
    const parseResult = pushPayloadSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { errors: parseResult.error.flatten().fieldErrors },
        { status: 422 },
      );
    }

    const payload = parseResult.data;

    // 6. Determine mode
    const mode = resolveMode();

    // 7. INSERT into push_raw_log
    // Table not yet in generated Database types — cast to bypass strict table union until types are regenerated
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = getSupabaseAdmin() as any;
    const { error: insertError } = await supabase
      .from("push_raw_log")
      .insert({
        user_id: OWNER_USER_ID,
        package_name: payload.packageName,
        payload: payload,
        received_at: new Date().toISOString(),
      });

    if (insertError) {
      return NextResponse.json({ error: "log_failed" }, { status: 500 });
    }

    // 8. In log_only mode (or Phase 0), respond immediately
    if (mode === "log_only") {
      return NextResponse.json({ status: "logged" });
    }

    // 9. full_pipeline mode — execute the full pipeline
    const result = await executePipeline(payload, mode);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: "internal_server_error" },
      { status: 500 },
    );
  }
}
