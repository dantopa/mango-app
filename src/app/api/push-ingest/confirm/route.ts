import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/push-ingest/supabase-admin";
import { resolveRate, calculateUsd } from "@/lib/push-ingest/fx";
import { categorize } from "@/lib/push-ingest/categorizer";
import { categorizeWithAi } from "@/lib/push-ingest/ai-categorizer";
import { classifyTransaction } from "@/lib/push-ingest/classifier";
import type { ParsedTransaction } from "@/lib/push-ingest/types";

const OWNER_USER_ID = "e99371b1-6163-4216-b624-c79d8ee01520";

/**
 * POST /api/push-ingest/confirm
 * Body: { dedup_key: string, action: "approve" | "reject" }
 *
 * Confirms or rejects a pending LLM-detected transaction.
 * On approve: inserts the transaction (same logic as full pipeline).
 * On reject: marks as no_parser (ignored).
 */
export async function POST(request: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { dedup_key, action } = body as { dedup_key: string; action: string };

  if (!dedup_key || !["approve", "reject"].includes(action)) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = getSupabaseAdmin() as any;

  // Get the pending entry
  const { data: entry, error: fetchError } = await admin
    .from("push_ingest_log")
    .select("*")
    .eq("dedup_key", dedup_key)
    .eq("status", "pending_confirmation")
    .single();

  if (fetchError || !entry) {
    return NextResponse.json({ error: "not found or already processed" }, { status: 404 });
  }

  if (action === "reject") {
    await admin.from("push_ingest_log").update({ status: "no_parser" }).eq("dedup_key", dedup_key);
    return NextResponse.json({ status: "rejected" });
  }

  // Approve — insert the transaction
  const parsed: ParsedTransaction = JSON.parse(entry.pending_data);

  // FX
  const fxResult = await resolveRate(parsed.native_currency);
  if (!fxResult.ok) {
    await admin.from("push_ingest_log").update({ status: "fx_pending" }).eq("dedup_key", dedup_key);
    return NextResponse.json({ status: "fx_pending" });
  }
  const amountUsd = calculateUsd(parsed.amount_native, fxResult.rate);

  // Classify
  const classification = await classifyTransaction(parsed, OWNER_USER_ID);
  if (classification.type === "transfer") {
    await admin.from("push_ingest_log").update({ status: "transfer" }).eq("dedup_key", dedup_key);
    return NextResponse.json({ status: "transfer" });
  }

  // Categorize
  const catResult = await categorize(parsed.merchant, OWNER_USER_ID);
  let categoryId: string | null = null;
  if (catResult.matched) {
    categoryId = catResult.category_id;
  } else if (parsed.merchant) {
    const aiResult = await categorizeWithAi(parsed.merchant, parsed.description_raw, OWNER_USER_ID);
    if (aiResult.matched) categoryId = aiResult.category_id;
  }

  // Resolve account
  const { data: accounts } = await admin
    .from("accounts")
    .select("id, name")
    .eq("user_id", OWNER_USER_ID);
  const account = (accounts ?? []).find(
    (a: { id: string; name: string }) => a.name.toLowerCase() === parsed.account_name.toLowerCase(),
  );
  if (!account) {
    await admin.from("push_ingest_log")
      .update({ status: "registration_failed", error_message: `Account not found: ${parsed.account_name}` })
      .eq("dedup_key", dedup_key);
    return NextResponse.json({ error: `Account not found: ${parsed.account_name}` }, { status: 400 });
  }

  // Insert transaction
  const { data: txData, error: txError } = await admin
    .from("transactions")
    .insert({
      user_id: OWNER_USER_ID,
      account_id: account.id,
      tx_date: parsed.tx_date,
      description_raw: parsed.description_raw,
      merchant: parsed.merchant,
      amount_native: parsed.amount_native,
      native_currency: parsed.native_currency,
      fx_rate_to_usd: fxResult.rate,
      amount_usd: amountUsd,
      category_id: categoryId,
      is_payment: false,
      needs_review: !categoryId,
      source: "push_ingest",
      country: "CO",
      expense_type: "variable",
      card_last4: parsed.card_last4 ?? null,
    })
    .select("id")
    .single();

  if (txError || !txData) {
    await admin.from("push_ingest_log")
      .update({ status: "registration_failed", error_message: txError?.message ?? "unknown" })
      .eq("dedup_key", dedup_key);
    return NextResponse.json({ error: txError?.message ?? "insert failed" }, { status: 500 });
  }

  // Update ingest log
  await admin.from("push_ingest_log").update({
    status: "registered",
    transaction_id: txData.id,
    amount_usd: amountUsd,
    pending_data: null,
  }).eq("dedup_key", dedup_key);

  return NextResponse.json({ status: "approved", transaction_id: txData.id });
}

/**
 * GET /api/push-ingest/confirm
 * Returns all pending confirmations for the current user.
 */
export async function GET(): Promise<NextResponse> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = getSupabaseAdmin() as any;
  const { data, error } = await admin
    .from("push_ingest_log")
    .select("dedup_key, package_name, amount_native, native_currency, merchant, pending_data, created_at")
    .eq("user_id", OWNER_USER_ID)
    .eq("status", "pending_confirmation")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ pending: data ?? [] });
}
