import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { getRefreshToken } from "@/lib/sync/gmail/token-store";

/**
 * GET /api/gmail/status
 * Returns whether Gmail is connected (refresh token exists in Vault).
 * Used by the SyncDialog to decide whether to show the "Conectar Gmail" CTA.
 */
export async function GET() {
  // Verify Supabase session
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json(
      { error: "No autenticado" },
      { status: 401 },
    );
  }

  const token = await getRefreshToken();

  return NextResponse.json({ connected: !!token });
}
