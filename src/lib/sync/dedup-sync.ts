import type { CandidateTransaction, DedupDecision } from "./types";
import { compareMerchants } from "./fuzzy-matcher";
import { getSupabaseAdmin } from "../push-ingest/supabase-admin";

/**
 * Evalúa si una candidata es duplicado de alguna transacción existente.
 *
 * Árbol de decisión:
 * 1. Buscar en `transactions`: mismo amount_native + tx_date + account
 *    → Si match exacto (incluyendo merchant fuzzy) → discard
 *    → Si amount+date match pero merchant difiere → insert_review
 * 2. Buscar en `push_ingest_log`: mismo amount + date + status "registered"
 *    → Si existe → discard (ya capturado por push)
 * 3. Si >1 coincidencia ambigua para mismo monto+fecha → insert_review
 * 4. Sin coincidencia → insert
 */
export async function evaluateCandidate(
  candidate: CandidateTransaction,
  userId: string,
  monthStart: string,
  monthEnd: string
): Promise<DedupDecision> {
  const supabase = getSupabaseAdmin();

  // 1. Query existing transactions: same amount_native + tx_date + account
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existingTxs, error: txError } = await (supabase as any)
    .from("transactions")
    .select("id, merchant, amount_native, tx_date")
    .eq("user_id", userId)
    .eq("amount_native", candidate.amount_native)
    .eq("tx_date", candidate.tx_date)
    .gte("tx_date", monthStart)
    .lte("tx_date", monthEnd);

  if (txError) {
    // Fail open: if we can't query, treat as no match (insert)
    console.error("[dedup] transactions query error:", txError.message);
    return { action: "insert" };
  }

  if (existingTxs && existingTxs.length > 0) {
    let matchCount = 0;
    let ambiguousCount = 0;

    for (const existing of existingTxs) {
      const comparison = compareMerchants(candidate.merchant, existing.merchant);

      if (comparison === "match") {
        matchCount++;
      } else if (comparison === "ambiguous") {
        ambiguousCount++;
      }
    }

    // Exact match (merchant fuzzy match) → discard
    if (matchCount > 0) {
      return { action: "discard", reason: "duplicate_merchant_match" };
    }

    // Any ambiguous matches → insert_review (under-count principle)
    if (ambiguousCount > 0) {
      return {
        action: "insert_review",
        reason: "ambiguous_merchant_match",
      };
    }

    // Amount+date match but all merchants clearly differ → insert_review
    return {
      action: "insert_review",
      reason: "same_amount_date_different_merchant",
    };
  }

  // 2. Check push_ingest_log for same amount + date range
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: pushLogs, error: pushError } = await (supabase as any)
    .from("push_ingest_log")
    .select("dedup_key, amount_native")
    .eq("status", "registered")
    .eq("amount_native", candidate.amount_native)
    .gte("created_at", `${monthStart}T00:00:00`)
    .lte("created_at", `${monthEnd}T23:59:59`);

  if (!pushError && pushLogs && pushLogs.length > 0) {
    return { action: "discard", reason: "already_captured_by_push" };
  }

  // 4. No match at all → insert
  return { action: "insert" };
}
