import type { PushPayload, PipelineResult, IngestMode } from "./types";
import { computeDedupKey, isDuplicate, findCrossSourceDuplicate } from "./dedup";
import { getParser } from "./parser-registry";
import { resolveRate, calculateUsd } from "./fx";
import { categorize } from "./categorizer";
import { categorizeWithAi } from "./ai-categorizer";
import { classifyTransaction } from "./classifier";
import { computeSemaphore } from "./semaphore";
import { checkAndAlert } from "./alert";
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
    return { status: "registered", transaction_id: "transfer-skipped" };
  }

  // 5.5. Cross-source dedup — check if same amount from different package within 2 min
  const postedAt = typeof payload.timestamp === "number"
    ? new Date(payload.timestamp)
    : new Date();
  const crossDup = await findCrossSourceDuplicate(parsed.amount_native, payload.packageName, postedAt);
  if (crossDup) {
    // Same purchase already registered from another source — keep the one with merchant
    const keepExisting = crossDup.merchant !== null;
    if (keepExisting) {
      await supabase.from("push_ingest_log").update({
        status: "deduped_cross_source",
        related_dedup_key: crossDup.dedup_key,
      }).eq("dedup_key", dedupKey);
      return { status: "deduped_cross_source", kept_key: crossDup.dedup_key };
    }
    // This one has better info — mark the other as deduped (but don't delete its transaction)
  }

  // 6. FX conversion
  const fxResult = await resolveRate(parsed.native_currency);
  if (!fxResult.ok) {
    await supabase.from("push_ingest_log").update({ status: "fx_pending" }).eq("dedup_key", dedupKey);
    return { status: "fx_pending", dedup_key: dedupKey };
  }
  const amountUsd = calculateUsd(parsed.amount_native, fxResult.rate);

  // 7. Categorize (deterministic first, AI fallback)
  const catResult = await categorize(parsed.merchant, OWNER_USER_ID);
  let categoryId: string | null = null;
  let catMatched = false;

  if (catResult.matched) {
    categoryId = catResult.category_id;
    catMatched = true;
  } else if (parsed.merchant) {
    const aiResult = await categorizeWithAi(parsed.merchant, parsed.description_raw, OWNER_USER_ID);
    if (aiResult.matched) {
      categoryId = aiResult.category_id;
      catMatched = true;
    }
  }

  const needsReview = !catMatched || classification.type === "unknown";

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

  // 11. Evaluate semaphore and alert if state changed
  let semaphoreResult = undefined;
  try {
    const now = new Date();
    const currentDay = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const monthEnd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;

    // Sum variable expenses this month (exclude payments, fixed, needs_review)
    const { data: monthTxns } = await supabase
      .from("transactions")
      .select("amount_usd")
      .eq("user_id", OWNER_USER_ID)
      .eq("is_payment", false)
      .eq("expense_type", "variable")
      .eq("needs_review", false)
      .gte("tx_date", monthStart)
      .lte("tx_date", monthEnd);

    const accumulatedSpend = (monthTxns ?? []).reduce(
      (sum: number, tx: { amount_usd: number }) => sum + (tx.amount_usd > 0 ? tx.amount_usd : 0),
      0,
    );

    // Read ceiling from user settings (DB), fallback to env var, then 0 (disabled)
    const { data: userSettings } = await supabase
      .from("user_settings")
      .select("budget_ceiling_usd")
      .eq("user_id", OWNER_USER_ID)
      .maybeSingle();
    const ceiling = userSettings?.budget_ceiling_usd
      ? parseFloat(String(userSettings.budget_ceiling_usd))
      : parseFloat(process.env.BUDGET_CEILING_USD ?? "0");
    if (ceiling > 0) {
      semaphoreResult = computeSemaphore({
        accumulated_spend: accumulatedSpend,
        ceiling,
        current_day: currentDay,
        days_in_month: daysInMonth,
      });

      // Alert on state transition
      checkAndAlert(null, semaphoreResult.state); // TODO: track previous state

      console.log("[push-ingest][semaphore]", JSON.stringify({
        state: semaphoreResult.state,
        spent: accumulatedSpend,
        ceiling,
        pct: semaphoreResult.pct,
        daily_budget: Math.round(Math.max(0, (ceiling - accumulatedSpend) / (daysInMonth - currentDay + 1)) * 100) / 100,
      }));
    }
  } catch (e) {
    console.error("[push-ingest][semaphore] error:", e);
  }

  return { status: "registered", transaction_id: txData.id, semaphore: semaphoreResult };
}
