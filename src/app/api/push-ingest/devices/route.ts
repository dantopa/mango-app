import { NextResponse } from "next/server";

import { pairDevice, pairSchema } from "@/lib/push-ingest/devices";
import { getSupabaseAdmin } from "@/lib/push-ingest/supabase-admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Step two of pairing: the signed-in browser approves a pending enrolment.
 *
 * This is the only place a device gets an owner, which is what makes the session
 * the actual authorisation for the phone's token.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }

    const parsed = pairSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_code" }, { status: 400 });
    }

    const device = await pairDevice(parsed.data.code, user.id, new Date());
    if (!device) {
      // Unknown, expired and already-used all answer the same, so the endpoint
      // cannot be used to probe which codes exist.
      return NextResponse.json({ error: "invalid_code" }, { status: 400 });
    }

    return NextResponse.json({ status: "paired", label: device.label });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

/** Paired devices, so a phone that was lost can be recognised and revoked. */
export async function GET(): Promise<NextResponse> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const { data, error } = await getSupabaseAdmin()
      .from("push_ingest_devices")
      .select("id, label, paired_at, last_used_at, revoked_at")
      .eq("user_id", user.id)
      .order("paired_at", { ascending: false });

    if (error) {
      console.error("[push-ingest] device list failed:", error.message);
      return NextResponse.json({ error: "list_failed" }, { status: 500 });
    }

    return NextResponse.json({ devices: data });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

/**
 * Revokes instead of deleting: the row is what a future request's token hashes
 * to, so keeping it is what makes the rejection deliberate rather than a miss.
 */
export async function DELETE(request: Request): Promise<NextResponse> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }

    const { id } = body as { id?: unknown };
    if (typeof id !== "string" || id.length === 0) {
      return NextResponse.json({ error: "missing_id" }, { status: 400 });
    }

    const { error } = await getSupabaseAdmin()
      .from("push_ingest_devices")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", user.id);

    if (error) {
      console.error("[push-ingest] device revoke failed:", error.message);
      return NextResponse.json({ error: "revoke_failed" }, { status: 500 });
    }

    return NextResponse.json({ status: "revoked" });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
