import type { PushPayload, PipelineResult, IngestMode } from "./types";
import { computeDedupKey, isDuplicate } from "./dedup";
import { getParser } from "./parser-registry";
import { resolveRate, calculateUsd } from "./fx";
import { categorize } from "./categorizer";
import { classifyTransaction } from "./classifier";
import { getSupabaseAdmin } from "./supabase-admin";
import "./parsers"; // side-effect: registers all parsers

const OWNER_USER_ID = process.env.MAQUINITA_OWNER_USER_ID ?? "49b33f55-dcf2-4370-ba9a-204b91f2551d";

export async function executePipeline(payload: PushPayload, mode: IngestMode): Promise<PipelineResult> {
  // If log_only, we shouldn't even be here (caller handles), but just in case:
  if (mode === "log_only") return { status: "logged" };

  // 1. Get parser for this package
  const parser = getParser(payload.packageName);
  if (!parser) return { status: "no_parser", package_name: payload.packageName };

  // 2. Compute dedup key and check
  const dedupKey = computeDedupKey(payload);
  if (await isDuplicate(dedupKey)) return { status: "duplicate", dedup_key: dedupKey };

  // 3. Parse
  const parsed = parser(payload);
  if (!parsed) return { status: "no_parser", package_name: payload.packageName }; // parser returned null = couldn't parse

  // 4. Insert into push_ingest_log with status "processing"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getSupabaseAdmin() as any;
  await supabase.from("push_ingest_log").insert({
    dedup_key: dedupKey,
    user_id: OWNER_USER_ID,
    package_name: payload.packageName,
    amount_native: parsed.amount_native,
    native_currency: parsed.native_currency,
    merchant: parsed.merchant,
    status: "processing",
  });

  // 5. Classify (transfer vs expense)
  const classification = await classifyTransaction(parsed, OWNER_USER_ID);
  if (classification.type === "transfer") {
    await supabase.from("push_ingest_log").update({ status: "transfer" }).eq("dedup_key", dedupKey);
    return { status: "registered", transaction_id: "transfer-skipped" }; // TODO: improve
  }

  // 6. FX conversion
  const fxResult = await resolveRate(parsed.native_currency);
  if (!fxResult.ok) {
    await supabase.from("push_ingest_log").update({ status: "fx_pending" }).eq("dedup_key", dedupKey);
    return { status: "fx_pending", dedup_key: dedupKey };
  }
  const amountUsd = calculateUsd(parsed.amount_native, fxResult.rate);

  // 7. Categorize
  const catResult = await categorize(parsed.merchant, OWNER_USER_ID);
  const categoryId = catResult.matched ? catResult.category_id : null;
  const needsReview = !catResult.matched || classification.type === "unknown";

  // 8. Resolve account
  const { data: accounts } = await supabase
    .from("accounts")
    .select("id, name")
    .eq("user_id", OWNER_USER_ID);
  const account = (accounts ?? []).find(
    (a: { id: string; name: string }) => a.name.toLowerCase() === parsed.account_name.toLowerCase(),
  );
  if (!account) {
    await supabase
      .from("push_ingest_log")
      .update({ status: "registration_failed", error_message: `Account not found: ${parsed.account_name}` })
      .eq("dedup_key", dedupKey);
    return { status: "registration_failed", error: `Account not found: ${parsed.account_name}` };
  }

  // 9. Insert transaction
  const { data: txData, error: txError } = await supabase
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
      needs_review: needsReview,
      source: "push_ingest",
      country: "CO", // Default for now
      expense_type: "variable",
    })
    .select("id")
    .single();

  if (txError || !txData) {
    await supabase
      .from("push_ingest_log")
      .update({ status: "registration_failed", error_message: txError?.message ?? "unknown" })
      .eq("dedup_key", dedupKey);
    return { status: "registration_failed", error: txError?.message ?? "unknown insert error" };
  }

  // 10. Update ingest log with success
  await supabase
    .from("push_ingest_log")
    .update({
      status: "registered",
      transaction_id: txData.id,
      amount_usd: amountUsd,
    })
    .eq("dedup_key", dedupKey);

  return { status: "registered", transaction_id: txData.id };
}
