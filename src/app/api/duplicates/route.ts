import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { auditMonth } from "@/lib/sync/duplicate-audit";

/** The audit judges up to 25 groups, five at a time, so it needs the long ceiling. */
export const maxDuration = 60;

/**
 * POST /api/duplicates
 * Body: { month: "YYYY-MM" }
 * Auth: Supabase session cookie
 *
 * Returns a *proposal*: which transactions look like the same movement recorded
 * twice, and which one to keep. Deleting happens client-side, on the user's
 * click, under RLS — this route never touches a row.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const body = await request.json();
    const { month } = body as { month?: string };

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json(
        { error: "Formato de mes inválido. Usar YYYY-MM." },
        { status: 400 }
      );
    }

    const result = await auditMonth(user.id, month);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[api/duplicates] error:", err);
    const message = err instanceof Error ? err.message : "Error interno del servidor";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
