import type { CandidateTransaction, DedupDecision } from "./types";
import { compareMerchants } from "./fuzzy-matcher";
import { getSupabaseAdmin } from "../push-ingest/supabase-admin";

/**
 * Map tracking how many times each existing transaction has been "consumed"
 * (matched as duplicate) by candidates in the current batch run.
 * Key = existing transaction ID, Value = number of times consumed.
 */
export type ConsumptionMap = Map<string, number>;

/**
 * Regex to extract the last 4 digits of a card from description_raw.
 * Matches patterns like *5685, ••5685, •5685, **5685
 */
const CARD_LAST4_REGEX = /[*•]{1,2}(\d{4})\b/;

/**
 * Extracts card_last4 from a transaction's description_raw.
 * Returns the 4-digit string or null if not found.
 */
export function extractCardLast4(descriptionRaw: string | null): string | null {
  if (!descriptionRaw) return null;
  const match = descriptionRaw.match(CARD_LAST4_REGEX);
  return match ? match[1] : null;
}

/**
 * Returns a ±1 day date window around the given date string (YYYY-MM-DD).
 */
function getDateWindow(txDate: string): { dateFrom: string; dateTo: string } {
  const date = new Date(txDate + "T12:00:00Z"); // noon to avoid DST issues
  const prev = new Date(date);
  prev.setUTCDate(prev.getUTCDate() - 1);
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + 1);

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { dateFrom: fmt(prev), dateTo: fmt(next) };
}

/**
 * Evalúa si una candidata es duplicado de alguna transacción existente.
 *
 * Escalera de matching (Wave 7):
 *
 * | Nivel | Clave                                                       | Veredicto      |
 * |-------|-------------------------------------------------------------|----------------|
 * | 1     | card_last4 igual + monto igual + fecha ±1 día               | discard        |
 * | 2     | monto igual + fecha ±1 día + merchant match (fuzzy)         | discard        |
 * | 3     | monto igual + fecha ±1 día + merchant ambiguous             | insert_review  |
 * | 4     | monto igual + fecha ±1 día + merchant no_match y sin last4  | insert_review  |
 * | 5     | sin coincidencia                                            | insert         |
 *
 * Paso 2: push_ingest_log acotado a created_at ±1 día (no mes completo).
 *
 * Multiplicidad: when `consumptionMap` is provided, each existing transaction
 * can only be "consumed" (matched) once. If a previous candidate in the same
 * batch already consumed it, it's no longer available for dedup. When a discard
 * decision is made, the matched transaction's count in the map is incremented.
 */
export async function evaluateCandidate(
  candidate: CandidateTransaction,
  userId: string,
  _monthStart: string,
  _monthEnd: string,
  consumptionMap?: ConsumptionMap
): Promise<DedupDecision> {
  const supabase = getSupabaseAdmin();

  // Compute ±1 day window around candidate's tx_date
  const { dateFrom, dateTo } = getDateWindow(candidate.tx_date);

  // 1. Query existing transactions: same amount_native + date ±1 day window
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existingTxs, error: txError } = await (supabase as any)
    .from("transactions")
    .select("id, merchant, amount_native, tx_date, description_raw")
    .eq("user_id", userId)
    .eq("amount_native", candidate.amount_native)
    .gte("tx_date", dateFrom)
    .lte("tx_date", dateTo);

  if (txError) {
    // Fail open: if we can't query, treat as no match (insert)
    console.error("[dedup] transactions query error:", txError.message);
    return { action: "insert" };
  }

  if (existingTxs && existingTxs.length > 0) {
    // Filter out existing transactions that have already been fully consumed
    // by previous candidates in this batch run
    const availableTxs = consumptionMap
      ? existingTxs.filter((tx: { id: string }) => {
          const consumed = consumptionMap.get(tx.id) ?? 0;
          // Each existing transaction can only be consumed once (1:1 matching)
          return consumed < 1;
        })
      : existingTxs;

    // If all existing matches have been consumed, fall through to push_ingest_log check
    if (availableTxs.length === 0) {
      // Skip to step 2 (push_ingest_log)
    } else {
      // Extract candidate's card_last4 (from the field if present, otherwise from description_raw)
      const candidateLast4 =
        (candidate as CandidateTransaction & { card_last4?: string | null }).card_last4 ??
        extractCardLast4(candidate.description_raw);

      // --- Level 1: card_last4 match ---
      if (candidateLast4) {
        for (const existing of availableTxs) {
          const existingLast4 = extractCardLast4(existing.description_raw);
          if (existingLast4 && existingLast4 === candidateLast4) {
            // Same card + same amount + date within ±1 day → discard (regardless of merchant)
            if (consumptionMap) {
              consumptionMap.set(existing.id, (consumptionMap.get(existing.id) ?? 0) + 1);
            }
            return { action: "discard", reason: "duplicate_card_match" };
          }
        }
      }

      // --- Levels 2–4: merchant-based matching ---
      let firstMatchId: string | null = null;
      let matchCount = 0;
      let ambiguousCount = 0;
      let noMatchWithoutLast4 = 0;

      // Special case: if candidate has no merchant, any amount+date match is
      // strong evidence of duplicate (e.g., QR payments where email has no merchant
      // but the API MCP source does). Discard immediately.
      if (!candidate.merchant) {
        const firstAvailable = availableTxs[0];
        if (consumptionMap && firstAvailable) {
          consumptionMap.set(firstAvailable.id, (consumptionMap.get(firstAvailable.id) ?? 0) + 1);
        }
        return { action: "discard", reason: "duplicate_amount_date_no_merchant" };
      }

      for (const existing of availableTxs) {
        const comparison = compareMerchants(candidate.merchant, existing.merchant);

        if (comparison === "match") {
          if (matchCount === 0) firstMatchId = existing.id;
          matchCount++;
        } else if (comparison === "ambiguous") {
          ambiguousCount++;
        } else {
          // no_match: check if existing has a common last4 with candidate
          const existingLast4 = extractCardLast4(existing.description_raw);
          const hasCommonLast4 = candidateLast4 && existingLast4 && candidateLast4 === existingLast4;
          if (!hasCommonLast4) {
            noMatchWithoutLast4++;
          }
        }
      }

      // Level 2: merchant fuzzy match → discard
      if (matchCount > 0) {
        if (consumptionMap && firstMatchId) {
          consumptionMap.set(firstMatchId, (consumptionMap.get(firstMatchId) ?? 0) + 1);
        }
        return { action: "discard", reason: "duplicate_merchant_match" };
      }

      // Level 3: ambiguous merchant → insert_review
      if (ambiguousCount > 0) {
        return {
          action: "insert_review",
          reason: "ambiguous_merchant_match",
        };
      }

      // Level 4: amount+date match, merchants differ, no common last4 → insert_review
      if (noMatchWithoutLast4 > 0) {
        return {
          action: "insert_review",
          reason: "same_amount_date_different_merchant",
        };
      }
    }
  }

  // 2. Check push_ingest_log — constrained to created_at ±1 day (not full month)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: pushLogs, error: pushError } = await (supabase as any)
    .from("push_ingest_log")
    .select("dedup_key, amount_native")
    .eq("status", "registered")
    .eq("amount_native", candidate.amount_native)
    .gte("created_at", `${dateFrom}T00:00:00`)
    .lte("created_at", `${dateTo}T23:59:59`);

  if (!pushError && pushLogs && pushLogs.length > 0) {
    return { action: "discard", reason: "already_captured_by_push" };
  }

  // Level 5: No match at all → insert
  return { action: "insert" };
}
