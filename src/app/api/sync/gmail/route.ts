import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export const maxDuration = 60;

import { createClient } from "@/lib/supabase/server";
import { runGmailMonth } from "@/lib/sync/gmail/orchestrator";
import { recategorizeMonth } from "@/lib/sync/sync-engine";
import { GmailAuthError, GmailApiError } from "@/lib/sync/gmail/client";
import { ERROR_MESSAGES } from "@/lib/sync/types";
import type { SyncErrorResponse } from "@/lib/sync/types";
import type { GmailSourceId, GmailSyncCursor } from "@/lib/sync/gmail/types";

/**
 * POST /api/sync/gmail
 * Body: { month: "YYYY-MM", sources?: GmailSourceId[], cursor?: GmailSyncCursor }
 * Auth: Supabase session cookie
 *
 * Flow:
 * 1. Verify user session
 * 2. Validate request body (month format, optional sources/cursor)
 * 3. Call runGmailMonth with ~20s budget
 * 4. Return { results, next }
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Verify session
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { error: "No autenticado", code: "AUTH_EXPIRED" } satisfies SyncErrorResponse,
        { status: 401 }
      );
    }

    // 2. Parse and validate request body
    const body = await request.json();
    const { month, sources, cursor } = body as {
      month?: string;
      sources?: GmailSourceId[];
      cursor?: GmailSyncCursor;
    };

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json(
        { error: "Formato de mes inválido. Usar YYYY-MM.", code: "GMAIL_API_ERROR" } satisfies SyncErrorResponse,
        { status: 400 }
      );
    }

    // 3. Run Gmail sync with ~20s budget
    const { results, next } = await runGmailMonth(month, sources, cursor);

    // 4. Re-categorize & re-classify, but only once the month is fully paged:
    //    this route is resumed by the client with `next`, and the mop-up pass has
    //    nothing to mop up until the last page is in.
    if (!next) {
      const recat = await recategorizeMonth(user.id, month);
      if (recat.updated > 0 || recat.classified > 0) {
        console.log(`[sync/gmail] recategorized: ${recat.updated} updated, ${recat.classified} reclassified`);
      }
    }

    // 5. Return results
    return NextResponse.json({ results, next });
  } catch (err) {
    // GmailAuthError → 401
    if (err instanceof GmailAuthError) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.GMAIL_AUTH_REQUIRED, code: "GMAIL_AUTH_REQUIRED" } satisfies SyncErrorResponse,
        { status: 401 }
      );
    }

    // GmailApiError → 502
    if (err instanceof GmailApiError) {
      return NextResponse.json(
        { error: ERROR_MESSAGES.GMAIL_API_ERROR, code: "GMAIL_API_ERROR" } satisfies SyncErrorResponse,
        { status: 502 }
      );
    }

    console.error("[sync/gmail] error:", err);
    return NextResponse.json(
      { error: "Error interno del servidor", code: "GMAIL_API_ERROR" } satisfies SyncErrorResponse,
      { status: 500 }
    );
  }
}
