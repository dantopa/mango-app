import { NextResponse } from "next/server";

import { bearerToken } from "@/lib/push-ingest/auth";
import { bogotaMonthInfo } from "@/lib/push-ingest/dates";
import { authenticateDevice } from "@/lib/push-ingest/devices";
import { checkRateLimit } from "@/lib/push-ingest/rate-limiter";
import { getSupabaseAdmin } from "@/lib/push-ingest/supabase-admin";
import { buildWidgetSummary, type LastExpenseRow } from "@/lib/widget-summary";

// Per-request and per-user: a cached answer would show someone else's month.
export const dynamic = "force-dynamic";

const PAGE_SIZE = 1000;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Summary for the Android home-screen widget.
 *
 * Authenticated with a paired *device* token only — not the shared ingest
 * secret, which is a different kind of credential and has no business reading
 * spending. The phone that sends your notifications is the phone that shows
 * them back.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const limit = checkRateLimit(`widget:${ip}`);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(limit.retryAfter) } },
    );
  }

  const token = bearerToken(request.headers.get("authorization"));
  const device = token ? await authenticateDevice(token, new Date()) : null;
  if (!device) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  try {
    const supabase = getSupabaseAdmin();
    const now = Date.now();
    const { start, end } = bogotaMonthInfo(now);

    const [settings, last, monthAmounts] = await Promise.all([
      supabase.from("user_settings").select("budget_ceiling_usd").eq("user_id", device.userId).maybeSingle(),
      supabase
        .from("transactions")
        .select("merchant, amount_usd, tx_date, created_at")
        .eq("user_id", device.userId)
        .eq("status", "active")
        .eq("is_payment", false)
        .gt("amount_usd", 0)
        .order("tx_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      readMonthAmounts(device.userId, start, end),
    ]);

    if (settings.error) throw new Error(settings.error.message);
    if (last.error) throw new Error(last.error.message);

    // Same fallback as the push alerts: the saved ceiling, then the env var.
    const saved = settings.data?.budget_ceiling_usd;
    const ceiling = saved ? parseFloat(String(saved)) : parseFloat(process.env.BUDGET_CEILING_USD ?? "0");

    const summary = buildWidgetSummary({
      monthAmounts,
      ceiling: Number.isFinite(ceiling) ? ceiling : null,
      last: (last.data as LastExpenseRow | null) ?? null,
      now,
    });
    return NextResponse.json(summary, { headers: NO_STORE });
  } catch (e) {
    console.error("[widget] summary failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: NO_STORE });
  }
}

/** Every counted expense of the month, paged: PostgREST silently stops at 1000 rows. */
async function readMonthAmounts(userId: string, start: string, end: string): Promise<number[]> {
  const supabase = getSupabaseAdmin();
  const amounts: number[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("transactions")
      .select("amount_usd")
      .eq("user_id", userId)
      .eq("status", "active")
      .eq("is_payment", false)
      .gt("amount_usd", 0)
      .gte("tx_date", start)
      .lte("tx_date", end)
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    amounts.push(...(data ?? []).map((row) => Number(row.amount_usd)));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return amounts;
}
