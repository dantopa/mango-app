import type { PushPayload, PipelineResult, IngestMode } from "./types";
import { computeDedupKey, isDuplicate } from "./dedup";
import { getParser } from "./parser-registry";
import { resolveRate, calculateUsd } from "./fx";
import { categorize } from "./categorizer";
import { categorizeWithAi } from "./ai-categorizer";
import { classifyTransaction } from "./classifier";
import { computeSemaphore } from "./semaphore";
import { checkAndAlert } from "./alert";
import { sendPushNotification } from "./web-push";
import { getSupabaseAdmin } from "./supabase-admin";
import { resolveDuplicate } from "../sync/dedup-core";
import type { DedupCandidate } from "../sync/dedup-core";
import { shouldTryLlmFallback, isFinancialPackage, tryTemplateParser, llmFallbackParser } from "./parsers/llm-fallback";
import "./parsers"; // side-effect: registers all parsers

const OWNER_USER_ID = "e99371b1-6163-4216-b624-c79d8ee01520";

export async function executePipeline(payload: PushPayload, mode: IngestMode): Promise<PipelineResult> {
  // If log_only, we shouldn't even be here (caller handles), but just in case:
  if (mode === "log_only") return { status: "logged" };

  // 1. Get parser for this package
  const parser = getParser(payload.packageName);

  // 2. Compute dedup key and check
  const dedupKey = computeDedupKey(payload);
  if (await isDuplicate(dedupKey)) return { status: "duplicate", dedup_key: dedupKey };

  // 3. Parse — try deterministic parser first, then template DB, then LLM fallback
  let parsed = parser ? parser(payload) : null;
  let isLlmFirstTime = false;

  if (!parsed) {
    // Try auto-learned template from DB
    parsed = await tryTemplateParser(payload);
  }

  if (!parsed) {
    // LLM fallback — only for packages likely to have financial content
    if (shouldTryLlmFallback(payload.packageName, payload.title)) {
      console.log(`[push-ingest] no parser/template for ${payload.packageName}, trying LLM fallback`);
      parsed = await llmFallbackParser(payload);
      if (parsed) isLlmFirstTime = true; // First time for this format
    }
  }

  if (!parsed) {
    return { status: "no_parser", package_name: payload.packageName };
  }

  // 4. Insert into push_ingest_log with status "processing"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getSupabaseAdmin() as any;

  // If LLM detected this for the first time, decide: known financial package → insert directly, unknown → hold for confirmation
  if (isLlmFirstTime) {
    // Known financial packages: trust the LLM extraction and insert directly
    // Confirmation is only for completely unknown packages not in the whitelist
    // (which can't happen here since we only call LLM for whitelisted packages)
    // So: always insert directly from LLM fallback. The template is already saved.
    console.log(`[push-ingest] LLM extracted: ${parsed.merchant} ${parsed.amount_native} ${parsed.native_currency} — inserting directly`);
  }

  await supabase.from("push_ingest_log").insert({
    dedup_key: dedupKey,
    user_id: OWNER_USER_ID,
    package_name: payload.packageName,
    amount_native: parsed.amount_native,
    native_currency: parsed.native_currency,
    merchant: parsed.merchant,
    status: "processing",
  });

  // 4.1. PENDING cleanup — Google Wallet "PENDING" authorization removal
  const GOOGLE_WALLET_PACKAGE = "com.google.android.apps.walletnfcrel";
  if (
    payload.packageName === GOOGLE_WALLET_PACKAGE &&
    parsed.merchant &&
    parsed.merchant.toLowerCase().includes("pending")
  ) {
    // Search for a recently-created transaction with same amount/currency/date
    const { data: pendingMatches } = await supabase
      .from("transactions")
      .select("id")
      .eq("user_id", OWNER_USER_ID)
      .eq("amount_native", parsed.amount_native)
      .eq("native_currency", parsed.native_currency)
      .eq("tx_date", parsed.tx_date)
      .gte("created_at", new Date(Date.now() - 120 * 60 * 1000).toISOString());

    if (pendingMatches && pendingMatches.length > 0) {
      const deletedTxId = pendingMatches[0].id;
      await supabase.from("transactions").delete().eq("id", deletedTxId);
      await supabase.from("push_ingest_log").update({
        status: "pending_cleanup",
        transaction_id: deletedTxId,
      }).eq("dedup_key", dedupKey);
      console.log(`[push-ingest][pending-cleanup] deleted pending tx=${deletedTxId}`);
      return { status: "pending_cleanup" };
    }
    // No match found — still don't register the PENDING notification itself
    await supabase.from("push_ingest_log").update({
      status: "pending_cleanup",
    }).eq("dedup_key", dedupKey);
    console.log(`[push-ingest][pending-cleanup] PENDING notification discarded, no matching tx found`);
    return { status: "pending_cleanup" };
  }

  // 4.2. Google Wallet 3-minute echo dedup
  // If same amount+currency was registered by a DIFFERENT source within 3 minutes,
  // and one of the two sides is Google Wallet, discard the current notification.
  {
    const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const { data: recentTxs } = await supabase
      .from("transactions")
      .select("id, created_at")
      .eq("user_id", OWNER_USER_ID)
      .eq("amount_native", parsed.amount_native)
      .eq("native_currency", parsed.native_currency)
      .gte("created_at", threeMinAgo);

    if (recentTxs && recentTxs.length > 0) {
      // Check if any of these were created by a DIFFERENT package via push_ingest_log
      const recentTxIds = recentTxs.map((tx: { id: string }) => tx.id);
      const { data: ingestLogs } = await supabase
        .from("push_ingest_log")
        .select("transaction_id, package_name")
        .in("transaction_id", recentTxIds)
        .neq("package_name", payload.packageName);

      if (ingestLogs && ingestLogs.length > 0) {
        // One of the two (existing or current) must be Google Wallet
        const currentIsWallet = payload.packageName === GOOGLE_WALLET_PACKAGE;
        const existingIsWallet = ingestLogs.some(
          (log: { package_name: string }) => log.package_name === GOOGLE_WALLET_PACKAGE
        );

        if (currentIsWallet || existingIsWallet) {
          await supabase.from("push_ingest_log").update({
            status: "deduped_wallet_echo",
          }).eq("dedup_key", dedupKey);
          console.log(`[push-ingest][wallet-echo] discarded duplicate: current=${payload.packageName}, existing matched wallet echo`);
          return { status: "deduped_wallet_echo" };
        }
      }
    }
  }

  // 5. Classify (transfer vs expense)
  const classification = await classifyTransaction(parsed, OWNER_USER_ID);
  if (classification.type === "transfer") {
    await supabase.from("push_ingest_log").update({ status: "transfer" }).eq("dedup_key", dedupKey);
    return { status: "registered", transaction_id: "transfer-skipped" };
  }

  // 6. FX conversion (moved before dedup so amount_usd is available for cross-currency matching)
  const fxResult = await resolveRate(parsed.native_currency);
  if (!fxResult.ok) {
    await supabase.from("push_ingest_log").update({ status: "fx_pending" }).eq("dedup_key", dedupKey);
    return { status: "fx_pending", dedup_key: dedupKey };
  }
  const amountUsd = calculateUsd(parsed.amount_native, fxResult.rate);

  // Compute externalTs early (needed for cross-currency dedup)
  const externalTs = typeof payload.timestamp === "number"
    ? new Date(payload.timestamp).toISOString()
    : typeof payload.timestamp === "string"
      ? payload.timestamp
      : null;

  // 5.5. Cross-source dedup via unified resolveDuplicate against transactions table
  const dedupCandidate: DedupCandidate = {
    amount_native: parsed.amount_native,
    native_currency: parsed.native_currency,
    amount_usd: amountUsd,
    merchant: parsed.merchant,
    card_last4: parsed.card_last4 ?? null,
    tx_date: parsed.tx_date,
    external_ts: externalTs,
  };

  // Get transaction IDs already claimed by the SAME package (multiplicity guard).
  // Only exclude same-source claims — cross-source claims must remain in the
  // candidate pool so Level 2 (merchant + amount + date) can detect them as dupes.
  // Bug fix: previously excluded ALL claimed tx IDs regardless of source, which
  // caused cross-source duplicates (e.g., SMS + Google Wallet for the same purchase)
  // to slip through undetected.
  const { data: claimedLogs } = await supabase
    .from("push_ingest_log")
    .select("transaction_id")
    .not("transaction_id", "is", null)
    .eq("user_id", OWNER_USER_ID)
    .eq("package_name", payload.packageName);
  const excludeClaimedTxIds = (claimedLogs ?? [])
    .map((l: { transaction_id: string | null }) => l.transaction_id)
    .filter((id: string | null): id is string => Boolean(id));

  const dedupDecision = await resolveDuplicate(dedupCandidate, OWNER_USER_ID, supabase, {
    excludeClaimedTxIds,
  });

  // Handle the 4 decision branches
  let needsReview = false;
  if (dedupDecision.action === "discard") {
    await supabase.from("push_ingest_log").update({
      status: "deduped_cross_source",
      transaction_id: dedupDecision.matchedTxId,
    }).eq("dedup_key", dedupKey);
    console.log(`[push-ingest][dedup] discard: ${dedupDecision.reason}, matched=${dedupDecision.matchedTxId}`);
    return { status: "deduped_cross_source", kept_key: dedupDecision.matchedTxId };
  } else if (dedupDecision.action === "upgrade") {
    // UPDATE the matched transaction in-place with the candidate's better data (Req 5.2)
    // id remains stable — no DELETE+INSERT. description_raw included for richer context.
    const { error: upgradeError } = await supabase
      .from("transactions")
      .update({
        merchant: parsed.merchant,
        amount_native: parsed.amount_native,
        native_currency: parsed.native_currency,
        amount_usd: amountUsd,
        fx_rate_to_usd: fxResult.rate,
        card_last4: parsed.card_last4 ?? null,
        external_ts: externalTs,
        description_raw: parsed.description_raw,
        source: "push_ingest",
      })
      .eq("id", dedupDecision.matchedTxId);
    if (upgradeError) {
      console.error("[push-ingest][dedup] upgrade error:", upgradeError.message);
    }
    await supabase.from("push_ingest_log").update({
      status: "upgraded_cross_source",
      transaction_id: dedupDecision.matchedTxId,
    }).eq("dedup_key", dedupKey);
    console.log(`[push-ingest][dedup] upgrade: ${dedupDecision.reason}, matched=${dedupDecision.matchedTxId}`);
    return { status: "deduped_cross_source", kept_key: dedupDecision.matchedTxId };
  } else if (dedupDecision.action === "insert_review") {
    needsReview = true;
    console.log(`[push-ingest][dedup] insert_review: ${dedupDecision.reason}`);
  }
  // action === "insert" → continue pipeline normally

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

  const needsReviewCategorization = !catMatched || classification.type === "unknown";
  // Merge: review if dedup said so OR categorization couldn't resolve
  if (needsReviewCategorization) needsReview = true;

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
      card_last4: parsed.card_last4 ?? null,
      external_ts: externalTs,
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

    // Sum all expenses this month (exclude payments only)
    const { data: monthTxns } = await supabase
      .from("transactions")
      .select("amount_usd")
      .eq("user_id", OWNER_USER_ID)
      .eq("is_payment", false)
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

  // 12. Send web push notification
  try {
    const amountFormatted = parsed.native_currency === "USD"
      ? `US$${parsed.amount_native.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
      : `${parsed.native_currency} ${parsed.amount_native.toLocaleString("es-CO")} (~US$${amountUsd.toFixed(2)})`;

    const semaphoreEmoji = semaphoreResult
      ? { verde: "🟢", amarillo: "🟡", rojo: "🔴" }[semaphoreResult.state]
      : "";
    const semaphoreText = semaphoreResult
      ? ` ${semaphoreEmoji} ${Math.round(semaphoreResult.pct * 100)}% del presupuesto`
      : "";

    await sendPushNotification(OWNER_USER_ID, {
      title: `💸 ${amountFormatted}`,
      body: `${parsed.merchant ?? "Gasto"} registrado.${semaphoreText}`,
      tag: `tx-${txData.id}`,
      data: { url: "/gastos" },
    });
  } catch (e) {
    console.error("[push-ingest][web-push] error:", e);
  }

  return { status: "registered", transaction_id: txData.id, semaphore: semaphoreResult };
}
