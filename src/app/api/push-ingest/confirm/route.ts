import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/push-ingest/supabase-admin";
import { resolveRate, calculateUsd } from "@/lib/push-ingest/fx";
import { categorize } from "@/lib/push-ingest/categorizer";
import { categorizeWithAi } from "@/lib/push-ingest/ai-categorizer";
import { classifyTransaction } from "@/lib/push-ingest/classifier";
import { resolveAccount, type AccountCandidate } from "@/lib/push-ingest/account-resolver";
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

  const admin = getSupabaseAdmin();

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
    const { error } = await admin.from("push_ingest_log").update({ status: "no_parser" }).eq("dedup_key", dedup_key);
    if (error) {
      console.error(`[push-ingest][confirm] reject update failed for ${dedup_key}:`, error.message);
    }
    return NextResponse.json({ status: "rejected" });
  }

  // Approve — insert the transaction
  const parsed: ParsedTransaction = JSON.parse(String(entry.pending_data));

  // Resolve the account first: it decides the currency of a bare "$", and a
  // notification we cannot attribute must not reach `transactions`.
  const { data: accounts } = await admin
    .from("accounts")
    .select("id, name, native_currency, card_digits")
    .eq("user_id", OWNER_USER_ID)
    .eq("is_active", true);
  const resolution = resolveAccount((accounts ?? []) as AccountCandidate[], {
    cardLast4: parsed.card_last4,
    accountName: parsed.account_name,
  });
  if (!resolution.ok) {
    const { error } = await admin.from("push_ingest_log")
      .update({ status: "registration_failed", error_message: resolution.reason })
      .eq("dedup_key", dedup_key);
    if (error) {
      console.error(`[push-ingest][confirm] registration_failed update failed for ${dedup_key}:`, error.message);
    }
    return NextResponse.json({ error: resolution.reason }, { status: 400 });
  }
  const account = resolution.account;
  const nativeCurrency = parsed.native_currency ?? account.native_currency;

  // FX
  const fxResult = await resolveRate(nativeCurrency);
  if (!fxResult.ok) {
    const { error } = await admin.from("push_ingest_log").update({ status: "fx_pending" }).eq("dedup_key", dedup_key);
    if (error) {
      console.error(`[push-ingest][confirm] fx_pending update failed for ${dedup_key}:`, error.message);
    }
    return NextResponse.json({ status: "fx_pending" });
  }
  const amountUsd = calculateUsd(parsed.amount_native, fxResult.rate);

  // Classify
  const classification = await classifyTransaction(parsed, OWNER_USER_ID);
  if (classification.type === "transfer") {
    const { error } = await admin.from("push_ingest_log").update({ status: "transfer" }).eq("dedup_key", dedup_key);
    if (error) {
      console.error(`[push-ingest][confirm] transfer update failed for ${dedup_key}:`, error.message);
    }
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
      native_currency: nativeCurrency,
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
    console.error(`[push-ingest][confirm] transaction insert failed for ${dedup_key}:`, txError?.message ?? "unknown");
    const { error } = await admin.from("push_ingest_log")
      .update({ status: "registration_failed", error_message: txError?.message ?? "unknown" })
      .eq("dedup_key", dedup_key);
    if (error) {
      console.error(`[push-ingest][confirm] registration_failed update failed for ${dedup_key}:`, error.message);
    }
    return NextResponse.json({ error: txError?.message ?? "insert failed" }, { status: 500 });
  }

  // Update ingest log
  const { error: registeredError } = await admin.from("push_ingest_log").update({
    status: "registered",
    transaction_id: txData.id,
    amount_usd: amountUsd,
    pending_data: null,
  }).eq("dedup_key", dedup_key);
  if (registeredError) {
    console.error(`[push-ingest][confirm] registered update failed for ${dedup_key}:`, registeredError.message);
  }

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

  const admin = getSupabaseAdmin();
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
