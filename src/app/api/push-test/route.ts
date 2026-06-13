import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendPushNotification } from "@/lib/push-ingest/web-push";

export async function POST(): Promise<NextResponse> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const result = await sendPushNotification(user.id, {
      title: "🔔 Test",
      body: "Las notificaciones están funcionando!",
      tag: "test-push",
    });

    if (result.sent === 0 && result.failed === 0) {
      return NextResponse.json(
        { error: "No hay subscripciones push registradas" },
        { status: 404 },
      );
    }

    return NextResponse.json({ sent: result.sent, failed: result.failed });
  } catch (err) {
    console.error("[push-test] error:", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
