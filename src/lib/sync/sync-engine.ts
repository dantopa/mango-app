import type { CandidateTransaction, SyncSourceResult } from "./types";
import { evaluateCandidate } from "./dedup-sync";
import { resolveRate, calculateUsd } from "../push-ingest/fx";
import { categorize } from "../push-ingest/categorizer";
import { categorizeWithAi } from "../push-ingest/ai-categorizer";
import { classifyTransaction } from "../push-ingest/classifier";
import { getSupabaseAdmin } from "../push-ingest/supabase-admin";

/**
 * Procesa un batch de candidatas: dedup → FX → classify → categorize → insert.
 * Cada candidata se procesa independientemente (fallo en una no afecta las demás).
 */
export async function processCandidates(
  candidates: CandidateTransaction[],
  userId: string,
  month: string
): Promise<SyncSourceResult> {
  const source = candidates[0]?.source ?? "sync_bancolombia";
  const result: SyncSourceResult = {
    source,
    found: candidates.length,
    inserted: 0,
    duplicates: 0,
    needs_review: 0,
    errors: [],
  };

  if (candidates.length === 0) return result;

  const monthStart = `${month}-01`;
  const monthEnd = getMonthEnd(month);

  const supabase = getSupabaseAdmin();

  // Resolve account_id for this source's account_name (case-insensitive)
  const accountName = candidates[0].account_name;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: account, error: accountError } = await (supabase as any)
    .from("accounts")
    .select("id")
    .eq("user_id", userId)
    .ilike("name", accountName)
    .single();

  if (accountError || !account) {
    result.errors.push(
      `No se encontró la cuenta "${accountName}" para el usuario.`
    );
    return result;
  }

  const accountId = account.id;

  for (const candidate of candidates) {
    try {
      // 1. Dedup
      const decision = await evaluateCandidate(
        candidate,
        userId,
        monthStart,
        monthEnd
      );

      if (decision.action === "discard") {
        result.duplicates++;
        continue;
      }

      // 2. FX conversion
      let fxRate: number;
      let amountUsd: number;

      if (candidate.native_currency === "USD") {
        fxRate = 1;
        amountUsd = candidate.amount_native;
      } else {
        const fxResult = await resolveRate(candidate.native_currency);
        if (!fxResult.ok) {
          result.errors.push(
            `FX error for ${candidate.merchant ?? "unknown"} (${candidate.tx_date}): ${fxResult.reason}`
          );
          continue;
        }
        fxRate = fxResult.rate;
        amountUsd = calculateUsd(candidate.amount_native, fxRate);
      }

      // 3. Classify (transfer detection)
      const classification = await classifyTransaction(
        {
          merchant: candidate.merchant,
          description_raw: candidate.description_raw,
        },
        userId
      );

      const isPayment = classification.type === "transfer";

      // 4. Categorize (deterministic first, AI fallback)
      const categorizationResult = await categorize(candidate.merchant, userId);

      let categoryId: string | null = null;
      let categorizationMatched = false;

      if (categorizationResult.matched) {
        categoryId = categorizationResult.category_id;
        categorizationMatched = true;
      } else if (candidate.merchant) {
        // AI fallback — also auto-creates a rule for next time
        const aiResult = await categorizeWithAi(
          candidate.merchant,
          candidate.description_raw,
          userId
        );
        if (aiResult.matched) {
          categoryId = aiResult.category_id;
          categorizationMatched = true;
        }
      }

      // Determine needs_review
      const needsReview =
        decision.action === "insert_review" ||
        !categorizationMatched ||
        classification.type === "unknown";

      // 5. Insert into transactions
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: insertError } = await (supabase as any)
        .from("transactions")
        .insert({
          user_id: userId,
          account_id: accountId,
          tx_date: candidate.tx_date,
          description_raw: candidate.description_raw,
          merchant: candidate.merchant,
          amount_native: candidate.amount_native,
          native_currency: candidate.native_currency,
          fx_rate_to_usd: fxRate,
          amount_usd: amountUsd,
          category_id: categoryId,
          is_payment: isPayment,
          needs_review: needsReview,
          source: candidate.source,
          country: "CO",
          expense_type: candidate.expense_type ?? "variable",
        });

      if (insertError) {
        result.errors.push(
          `INSERT error for ${candidate.merchant ?? "unknown"} (${candidate.tx_date}): ${insertError.message}`
        );
        continue;
      }

      result.inserted++;
      if (needsReview) {
        result.needs_review++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(
        `Error processing ${candidate.merchant ?? "unknown"} (${candidate.tx_date}): ${msg}`
      );
    }
  }

  return result;
}

/** Helper: get last day of a month from "YYYY-MM" */
function getMonthEnd(month: string): string {
  const [year, m] = month.split("-").map(Number);
  // Day 0 of next month = last day of current month
  const lastDay = new Date(year, m, 0).getDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
}

/**
 * Re-categoriza transacciones sin categoría del mes usando reglas + AI.
 * También re-clasifica transferencias si hay reglas nuevas.
 * Se ejecuta al final del sync para limpiar pendientes de corridas previas.
 */
export async function recategorizeMonth(
  userId: string,
  month: string
): Promise<{ updated: number; classified: number }> {
  const supabase = getSupabaseAdmin();
  const monthStart = `${month}-01`;
  const monthEnd = getMonthEnd(month);

  let updated = 0;
  let classified = 0;

  // 1. Re-categorize transactions without category
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: uncategorized } = await (supabase as any)
    .from("transactions")
    .select("id, merchant, description_raw")
    .eq("user_id", userId)
    .is("category_id", null)
    .gte("tx_date", monthStart)
    .lte("tx_date", monthEnd);

  if (uncategorized && uncategorized.length > 0) {
    for (const tx of uncategorized as Array<{ id: string; merchant: string | null; description_raw: string }>) {
      if (!tx.merchant) continue;

      // Try deterministic rules first
      const ruleResult = await categorize(tx.merchant, userId);
      if (ruleResult.matched) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any)
          .from("transactions")
          .update({ category_id: ruleResult.category_id, needs_review: false })
          .eq("id", tx.id);
        updated++;
        continue;
      }

      // AI fallback
      const aiResult = await categorizeWithAi(tx.merchant, tx.description_raw, userId);
      if (aiResult.matched) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any)
          .from("transactions")
          .update({ category_id: aiResult.category_id, needs_review: false })
          .eq("id", tx.id);
        updated++;
      }
    }
  }

  // 2. Re-classify transactions that are not yet marked as transfers
  //    (catches cases where rules were added after initial insert)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: unclassified } = await (supabase as any)
    .from("transactions")
    .select("id, merchant, description_raw, is_payment")
    .eq("user_id", userId)
    .eq("is_payment", false)
    .gte("tx_date", monthStart)
    .lte("tx_date", monthEnd);

  if (unclassified && unclassified.length > 0) {
    for (const tx of unclassified as Array<{ id: string; merchant: string | null; description_raw: string; is_payment: boolean }>) {
      const classification = await classifyTransaction(
        { merchant: tx.merchant, description_raw: tx.description_raw },
        userId
      );

      if (classification.type === "transfer") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any)
          .from("transactions")
          .update({ is_payment: true })
          .eq("id", tx.id);
        classified++;
      }
    }
  }

  return { updated, classified };
}
