import { NextResponse } from "next/server";

import { enrollDevice, enrollSchema } from "@/lib/push-ingest/devices";
import { checkRateLimit } from "@/lib/push-ingest/rate-limiter";

/**
 * Step one of pairing, called by the Android app with no credentials — it does
 * not have any yet. That is safe because the body carries only digests: the row
 * this creates has no owner and authenticates nothing until the pairing code is
 * approved from a signed-in session.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const forwarded = request.headers.get("x-forwarded-for");
    const ip = forwarded?.split(",")[0]?.trim() ?? "unknown";

    // Unauthenticated and it writes, so the rate limit is the only thing keeping
    // this from being a way to fill the table.
    const rateResult = checkRateLimit(ip);
    if (!rateResult.allowed) {
      return NextResponse.json(
        { error: "rate_limited" },
        { status: 429, headers: { "Retry-After": String(rateResult.retryAfter) } },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }

    const parsed = enrollSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_enrollment" }, { status: 400 });
    }

    const device = await enrollDevice(parsed.data, new Date());
    if (!device) {
      return NextResponse.json({ error: "enroll_failed" }, { status: 500 });
    }

    return NextResponse.json({
      status: "pending",
      pairing_expires_at: device.pairing_expires_at,
    });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
