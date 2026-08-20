import type { PushPayload, PipelineResult, IngestMode, ParseResult } from "./types";
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
import { resolveAccount, type AccountCandidate } from "./account-resolver";
import { epochToLocalDate, TZ_OFFSETS } from "./dates";
import { validateParsedTransaction, type ResolvedTransaction } from "./validate";
import { resolveDuplicate } from "../sync/dedup-core";
import type { DedupCandidate } from "../sync/dedup-core";
import type { Database } from "../supabase/database.types";
import { shouldTryLlmFallback, tryTemplateParser, llmFallbackParser } from "./parsers/llm-fallback";
import "./parsers"; // side-effect: registers all parsers

const OWNER_USER_ID = "e99371b1-6163-4216-b624-c79d8ee01520";

const GOOGLE_WALLET_PACKAGE = "com.google.android.apps.walletnfcrel";

/** Postgres unique_violation — the dedup key was already claimed. */
const PG_UNIQUE_VIOLATION = "23505";

type SupabaseAdmin = ReturnType<typeof getSupabaseAdmin>;
type IngestLogPatch = Database["public"]["Tables"]["push_ingest_log"]["Update"];
type IngestLogInsert = Database["public"]["Tables"]["push_ingest_log"]["Insert"];

export type PipelineOptions = {
  /**
   * How far back a transaction may be dated. Widened when reprocessing raw logs
   * recorded weeks ago; the default is the live-ingest window.
   */
  maxPastDays?: number;
  /**
   * Retries a notification whose ingest-log row already exists, which normally
   * stops the pipeline as a duplicate. Only for recovering rows a previous run
   * failed on: a row that already produced a transaction is still refused.
   */
  force?: boolean;
};

/**
 * Patches the ingest log row for a dedup key, logging the error instead of
 * discarding it: a rejected write leaves the row on its previous status, which
 * is how a stale CHECK constraint kept 55 rows stuck on "processing" unnoticed.
 */
async function patchIngestLog(
  supabase: SupabaseAdmin,
  dedupKey: string,
  patch: IngestLogPatch,
): Promise<void> {
  const { error } = await supabase.from("push_ingest_log").update(patch).eq("dedup_key", dedupKey);
  if (error) {
    console.error(
      `[push-ingest][log] update to status=${patch.status ?? "?"} failed for ${dedupKey}:`,
      error.message,
    );
  }
}

/**
 * Claims a notification by inserting its ingest-log row.
 *
 * `dedup_key` is the primary key, so this insert *is* the lock: if two requests
 * carry the same notification (the forwarder retries, or a cron overlaps a
 * webhook), exactly one insert succeeds and the loser stops here. The earlier
 * read-then-write check left a window in which both sides inserted the same
 * expense twice.
 */
async function claimIngest(
  supabase: SupabaseAdmin,
  row: IngestLogInsert,
  force: boolean,
): Promise<"claimed" | "already_claimed"> {
  const { error } = await supabase.from("push_ingest_log").insert(row);
  if (!error) return "claimed";

  if (error.code === PG_UNIQUE_VIOLATION) {
    return force ? reclaimIngest(supabase, row) : "already_claimed";
  }

  // Any other failure means the row is missing and later status patches will be
  // no-ops, so the notification would go untracked. Log loudly and keep going:
  // registering the expense matters more than logging it.
  console.error(`[push-ingest][log] insert failed for ${row.dedup_key}:`, error.message);
  return "claimed";
}

/**
 * Takes over an ingest-log row a previous run left behind, clearing its error and
 * stamping `reprocessed_at`.
 *
 * A row that already carries a transaction is never taken over — reprocessing it
 * would register the same expense a second time. This is the last line of
 * defence; the caller is expected to select retryable rows in the first place.
 */
async function reclaimIngest(
  supabase: SupabaseAdmin,
  row: IngestLogInsert,
): Promise<"claimed" | "already_claimed"> {
  const { data: existing, error } = await supabase
    .from("push_ingest_log")
    .select("transaction_id")
    .eq("dedup_key", row.dedup_key)
    .maybeSingle();

  if (error || !existing) {
    console.error(
      `[push-ingest][log] reclaim of ${row.dedup_key} aborted:`,
      error?.message ?? "row not found",
    );
    return "already_claimed";
  }
  if (existing.transaction_id) return "already_claimed";

  const { error: patchError } = await supabase
    .from("push_ingest_log")
    .update({ ...row, error_message: null, reprocessed_at: new Date().toISOString() })
    .eq("dedup_key", row.dedup_key);

  if (patchError) {
    console.error(`[push-ingest][log] reclaim of ${row.dedup_key} failed:`, patchError.message);
    return "already_claimed";
  }
  return "claimed";
}

async function fetchAccounts(supabase: SupabaseAdmin, userId: string): Promise<AccountCandidate[]> {
  const { data, error } = await supabase
    .from("accounts")
    .select("id, name, native_currency, card_digits")
    .eq("user_id", userId)
    .eq("is_active", true);

  if (error) {
    console.error("[push-ingest] accounts query failed:", error.message);
    return [];
  }
  return (data ?? []) as AccountCandidate[];
}

/** Loads the account list at most once per notification, and only if needed. */
function accountLoader(supabase: SupabaseAdmin, userId: string): () => Promise<AccountCandidate[]> {
  let cached: AccountCandidate[] | null = null;
  return async () => (cached ??= await fetchAccounts(supabase, userId));
}

/**
 * Parsing ladder: hand-written parser → learned template → AI.
 *
 * Each step only escalates on `unknown`. An explicit `ignore` — a declined
 * purchase, a delivery update — ends the ladder, which is what keeps the AI from
 * ever being asked about (and inventing an expense out of) a notification we
 * already understand.
 */
async function runParsers(
  payload: PushPayload,
  userId: string,
  loadAccounts: () => Promise<AccountCandidate[]>,
): Promise<ParseResult> {
  const parser = getParser(payload.packageName);
  const deterministic = parser ? parser(payload) : ({ kind: "unknown" } as const);
  if (deterministic.kind !== "unknown") return deterministic;

  const fromTemplate = await tryTemplateParser(payload, userId);
  if (fromTemplate.kind !== "unknown") return fromTemplate;

  if (!shouldTryLlmFallback(payload.packageName, payload.title)) return { kind: "unknown" };

  console.log(`[push-ingest] no parser/template for ${payload.packageName}, escalating to AI`);
  return llmFallbackParser(payload, userId, await loadAccounts());
}

export async function executePipeline(
  payload: PushPayload,
  mode: IngestMode,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  // If log_only, we shouldn't even be here (caller handles), but just in case:
  if (mode === "log_only") return { status: "logged" };

  const supabase = getSupabaseAdmin();
  const loadAccounts = accountLoader(supabase, OWNER_USER_ID);
  const force = options.force ?? false;

  // 1. Dedup key — cheap pre-check; the authoritative gate is the insert below.
  const dedupKey = computeDedupKey(payload);
  if (!force && (await isDuplicate(dedupKey))) {
    return { status: "duplicate", dedup_key: dedupKey };
  }

  // 2. Parse
  const parseResult = await runParsers(payload, OWNER_USER_ID, loadAccounts);

  if (parseResult.kind === "unknown") {
    // Logged even though nothing could be extracted: this is the only trace a
    // dropped notification leaves outside push_raw_log. Without it, a real
    // expense vanishes with zero visibility — which is exactly what happened
    // with the Nexo COP amounts before this row existed.
    const claim = await claimIngest(supabase, {
      dedup_key: dedupKey,
      user_id: OWNER_USER_ID,
      package_name: payload.packageName,
      status: "no_parser",
    }, force);
    if (claim === "already_claimed") return { status: "duplicate", dedup_key: dedupKey };
    return { status: "no_parser", package_name: payload.packageName };
  }

  if (parseResult.kind === "ignore") {
    // Recorded so a retry of the same notification never re-parses it, and so
    // the ignored volume is measurable instead of invisible.
    const claim = await claimIngest(supabase, {
      dedup_key: dedupKey,
      user_id: OWNER_USER_ID,
      package_name: payload.packageName,
      status: "ignored",
      error_message: parseResult.reason,
    }, force);
    if (claim === "already_claimed") return { status: "duplicate", dedup_key: dedupKey };
    return { status: "ignored", reason: parseResult.reason };
  }

  const parsed = parseResult.tx;

  // 3. Claim the notification before doing anything with side effects.
  const claim = await claimIngest(supabase, {
    dedup_key: dedupKey,
    user_id: OWNER_USER_ID,
    package_name: payload.packageName,
    amount_native: parsed.amount_native,
    native_currency: parsed.native_currency,
    merchant: parsed.merchant,
    status: "processing",
  }, force);
  if (claim === "already_claimed") return { status: "duplicate", dedup_key: dedupKey };

  // 4. Resolve the account. This runs before FX and before any dedup query
  // because the account determines the currency of a bare "$", and because a
  // notification we cannot attribute must not touch `transactions` at all.
  const resolution = resolveAccount(await loadAccounts(), {
    cardLast4: parsed.card_last4,
    accountName: parsed.account_name,
  });
  if (!resolution.ok) {
    await patchIngestLog(supabase, dedupKey, {
      status: "registration_failed",
      error_message: resolution.reason,
    });
    return { status: "registration_failed", error: resolution.reason };
  }
  const account = resolution.account;

  const resolved: ResolvedTransaction = {
    ...parsed,
    native_currency: parsed.native_currency ?? account.native_currency,
  };

  // 5. Validate — the single gate every extraction passes, whether it came from
  // a hand-written parser, a learned template or the AI.
  const validation = validateParsedTransaction(resolved, {
    today: epochToLocalDate(Date.now(), TZ_OFFSETS.BOGOTA),
    maxPastDays: options.maxPastDays,
  });
  if (!validation.ok) {
    const error = validation.errors.join("; ");
    await patchIngestLog(supabase, dedupKey, { status: "registration_failed", error_message: error });
    console.error(`[push-ingest][validate] rejected ${dedupKey}: ${error}`);
    return { status: "registration_failed", error };
  }

  await patchIngestLog(supabase, dedupKey, { native_currency: resolved.native_currency });

  // 6. Google Wallet 3-minute echo dedup
  // If same amount+currency was registered by a DIFFERENT source within 3 minutes,
  // and one of the two sides is Google Wallet, discard the current notification.
  {
    const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const { data: recentTxs } = await supabase
      .from("transactions")
      .select("id, created_at")
      .eq("user_id", OWNER_USER_ID)
      .eq("amount_native", resolved.amount_native)
      .eq("native_currency", resolved.native_currency)
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
          await patchIngestLog(supabase, dedupKey, { status: "deduped_wallet_echo" });
          console.log(`[push-ingest][wallet-echo] discarded duplicate: current=${payload.packageName}, existing matched wallet echo`);
          return { status: "deduped_wallet_echo" };
        }
      }
    }
  }

  // 8. Classify (transfer vs expense)
  // Un ingreso no pasa por acá: no es un gasto ni un pago, y una regla de
  // transferencia que matchee al remitente lo descartaría en vez de registrarlo.
  const classification = resolved.is_income
    ? null
    : await classifyTransaction(resolved, OWNER_USER_ID);
  if (classification?.type === "transfer") {
    await patchIngestLog(supabase, dedupKey, { status: "transfer" });
    return { status: "registered", transaction_id: "transfer-skipped" };
  }

  // 9. FX conversion (before dedup so amount_usd is available for cross-currency matching)
  const fxResult = await resolveRate(resolved.native_currency);
  if (!fxResult.ok) {
    await patchIngestLog(supabase, dedupKey, { status: "fx_pending" });
    return { status: "fx_pending", dedup_key: dedupKey };
  }
  const amountUsd = calculateUsd(resolved.amount_native, fxResult.rate);

  // Compute externalTs early (needed for cross-currency dedup)
  const externalTs = typeof payload.timestamp === "number"
    ? new Date(payload.timestamp).toISOString()
    : typeof payload.timestamp === "string"
      ? payload.timestamp
      : null;

  // 10. Cross-source dedup via unified resolveDuplicate against transactions table
  const dedupCandidate: DedupCandidate = {
    amount_native: resolved.amount_native,
    native_currency: resolved.native_currency,
    amount_usd: amountUsd,
    merchant: resolved.merchant,
    card_last4: resolved.card_last4 ?? null,
    tx_date: resolved.tx_date,
    external_ts: externalTs,
  };

  // Get transaction IDs already claimed by the SAME package (multiplicity guard).
  // Only exclude same-source claims — cross-source claims must remain in the
  // candidate pool so Level 2 (merchant + amount + date) can detect them as dupes.
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
    await patchIngestLog(supabase, dedupKey, {
      status: "deduped_cross_source",
      transaction_id: dedupDecision.matchedTxId,
    });
    console.log(`[push-ingest][dedup] discard: ${dedupDecision.reason}, matched=${dedupDecision.matchedTxId}`);
    return { status: "deduped_cross_source", kept_key: dedupDecision.matchedTxId };
  } else if (dedupDecision.action === "upgrade") {
    // UPDATE the matched transaction in-place with the candidate's better data.
    // id remains stable — no DELETE+INSERT.
    const { error: upgradeError } = await supabase
      .from("transactions")
      .update({
        merchant: resolved.merchant,
        amount_native: resolved.amount_native,
        native_currency: resolved.native_currency,
        amount_usd: amountUsd,
        fx_rate_to_usd: fxResult.rate,
        card_last4: resolved.card_last4 ?? null,
        external_ts: externalTs,
        description_raw: resolved.description_raw,
        source: "push_ingest",
      })
      .eq("id", dedupDecision.matchedTxId);
    if (upgradeError) {
      console.error("[push-ingest][dedup] upgrade error:", upgradeError.message);
    }
    await patchIngestLog(supabase, dedupKey, {
      status: "upgraded_cross_source",
      transaction_id: dedupDecision.matchedTxId,
    });
    console.log(`[push-ingest][dedup] upgrade: ${dedupDecision.reason}, matched=${dedupDecision.matchedTxId}`);
    return { status: "deduped_cross_source", kept_key: dedupDecision.matchedTxId };
  } else if (dedupDecision.action === "insert_review") {
    needsReview = true;
    console.log(`[push-ingest][dedup] insert_review: ${dedupDecision.reason}`);
  }
  // action === "insert" → continue pipeline normally

  // 11. Categorize (deterministic first, AI fallback)
  // Las categorías son de gasto: un ingreso queda sin categoría, y eso no es una
  // revisión pendiente ni vale una llamada de IA.
  let categoryId: string | null = null;
  let catMatched = resolved.is_income === true;

  if (!catMatched) {
    const catResult = await categorize(resolved.merchant, OWNER_USER_ID, resolved.description_raw);

    if (catResult.matched) {
      categoryId = catResult.category_id;
      catMatched = true;
    } else {
      const aiResult = await categorizeWithAi(resolved.merchant, resolved.description_raw, OWNER_USER_ID);
      if (aiResult.matched) {
        categoryId = aiResult.category_id;
        catMatched = true;
      }
    }
  }

  if (!catMatched || classification?.type === "unknown") needsReview = true;

  // 12. Insert transaction
  const { data: txData, error: txError } = await supabase
    .from("transactions")
    .insert({
      user_id: OWNER_USER_ID,
      account_id: account.id,
      tx_date: resolved.tx_date,
      description_raw: resolved.description_raw,
      merchant: resolved.merchant,
      amount_native: resolved.amount_native,
      native_currency: resolved.native_currency,
      fx_rate_to_usd: fxResult.rate,
      amount_usd: amountUsd,
      category_id: categoryId,
      // Un negativo que no es ingreso es una devolución: cancela un gasto y por
      // eso queda como pago, igual que en el sync.
      is_payment: !resolved.is_income && resolved.amount_native < 0,
      needs_review: needsReview,
      source: "push_ingest",
      country: "CO", // Default for now
      expense_type: "variable",
      card_last4: resolved.card_last4 ?? null,
      external_ts: externalTs,
    })
    .select("id")
    .single();

  if (txError || !txData) {
    console.error(`[push-ingest] transaction insert failed for ${dedupKey}:`, txError?.message ?? "unknown");
    await patchIngestLog(supabase, dedupKey, {
      status: "registration_failed",
      error_message: txError?.message ?? "unknown",
    });
    return { status: "registration_failed", error: txError?.message ?? "unknown insert error" };
  }

  // 13. Update ingest log with success
  await patchIngestLog(supabase, dedupKey, {
    status: "registered",
    transaction_id: txData.id,
    amount_usd: amountUsd,
  });

  // 14. Evaluate semaphore and alert if state changed
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

      console.log("[push-ingest][semaphore]", JSON.stringify({
        state: semaphoreResult.state,
        spent: accumulatedSpend,
        ceiling,
        pct: semaphoreResult.pct,
        daily_budget: Math.round(Math.max(0, (ceiling - accumulatedSpend) / (daysInMonth - currentDay + 1)) * 100) / 100,
      }));

      // El semáforo de antes de esta compra. Comparar los dos es lo que detecta el
      // cruce de línea; sin gasto previo en el mes no hay estado anterior.
      const spendBefore = accumulatedSpend - amountUsd;
      const previousSemaphore = spendBefore > 0
        ? computeSemaphore({
            accumulated_spend: spendBefore,
            ceiling,
            current_day: currentDay,
            days_in_month: daysInMonth,
          })
        : null;

      await checkAndAlert(OWNER_USER_ID, previousSemaphore, semaphoreResult);
    }
  } catch (e) {
    console.error("[push-ingest][semaphore] error:", e);
  }

  // 15. Send web push notification
  try {
    // El monto de un ingreso se guarda negativo, pero mostrarlo así en el aviso
    // sólo confunde: el signo ya lo dice el título.
    const shownAmount = resolved.is_income ? Math.abs(resolved.amount_native) : resolved.amount_native;
    const shownUsd = resolved.is_income ? Math.abs(amountUsd) : amountUsd;
    const amountFormatted = resolved.native_currency === "USD"
      ? `US$${shownAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
      : `${resolved.native_currency} ${shownAmount.toLocaleString("es-CO")} (~US$${shownUsd.toFixed(2)})`;

    // El semáforo es de presupuesto: en un ingreso no dice nada.
    const semaphoreEmoji = semaphoreResult
      ? { verde: "🟢", amarillo: "🟡", rojo: "🔴" }[semaphoreResult.state]
      : "";
    const semaphoreText = semaphoreResult && !resolved.is_income
      ? ` ${semaphoreEmoji} ${Math.round(semaphoreResult.pct * 100)}% del presupuesto`
      : "";

    await sendPushNotification(OWNER_USER_ID, {
      title: `${resolved.is_income ? "💰" : "💸"} ${amountFormatted}`,
      body: resolved.is_income
        ? `Ingreso de ${resolved.merchant ?? "origen desconocido"}.`
        : `${resolved.merchant ?? "Gasto"} registrado.${semaphoreText}`,
      tag: `tx-${txData.id}`,
      data: { url: "/gastos" },
    });
  } catch (e) {
    console.error("[push-ingest][web-push] error:", e);
  }

  return { status: "registered", transaction_id: txData.id, semaphore: semaphoreResult };
}
