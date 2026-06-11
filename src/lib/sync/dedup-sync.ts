import type { CandidateTransaction, DedupDecision } from "./types";
import { resolveDuplicate, type DedupCandidate, type DedupOpts } from "./dedup-core";
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
 * Maps a reason from resolveDuplicate (dedup-core) to the legacy reason strings
 * that existing sync tests expect.
 */
function mapCoreReasonToSyncReason(coreReason: string): string {
  switch (coreReason) {
    case "card_match":
      return "duplicate_card_match";
    case "no_merchant":
      return "duplicate_amount_date_no_merchant";
    case "merchant_match":
      return "duplicate_merchant_match";
    case "cross_currency_card_match":
      return "duplicate_card_match";
    case "ambiguous_merchant_match":
      return "ambiguous_merchant_match";
    case "same_amount_date_diff_merchant":
      return "same_amount_date_different_merchant";
    case "cross_currency_amount_drift":
      return "cross_currency_amount_drift";
    case "cross_currency_no_card":
      return "cross_currency_no_card";
    default:
      return coreReason;
  }
}

/**
 * Evalúa si una candidata es duplicado de alguna transacción existente.
 *
 * Thin wrapper over `resolveDuplicate` (dedup-core.ts) that:
 * 1. Queries DB with legacy shape (mocks-compatible)
 * 2. Builds a DedupCandidate
 * 3. Delegates to resolveDuplicate
 * 4. Maps the decision back to the sync DedupDecision type
 * 5. Falls through to push_ingest_log check if core says "insert"
 *
 * Preserves the exact same exported signature for backward compatibility.
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
  //    (legacy query shape preserved for mock compatibility)
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

  // If there are existing transactions, delegate to resolveDuplicate
  if (existingTxs && existingTxs.length > 0) {
    // Filter out existing transactions that have already been fully consumed
    // by previous candidates in this batch run
    const availableTxs = consumptionMap
      ? (existingTxs as Array<{ id: string }>).filter((tx) => {
          const consumed = consumptionMap.get(tx.id) ?? 0;
          return consumed < 1;
        })
      : existingTxs;

    // If all existing matches have been consumed by earlier candidates in this
    // batch, this occurrence is a surplus real purchase (Req 7.9: exactly
    // max(0, N−M) inserts). Do NOT fall through to push_ingest_log — those log
    // rows correspond to the already-consumed transactions, and re-matching
    // them would discard the surplus occurrence (defeating multiplicity).
    if (availableTxs.length === 0) {
      return { action: "insert" };
    }

    // Build a boolean-based consumption map for resolveDuplicate from
    // the number-based ConsumptionMap. A tx is "consumed" if count >= 1.
    const boolConsumptionMap: Map<string, boolean> | undefined = consumptionMap
      ? new Map(
          Array.from(consumptionMap.entries())
            .filter(([, count]) => count >= 1)
            .map(([id]) => [id, true])
        )
      : undefined;

    // Transform fetched rows to the format resolveDuplicate expects.
    // Since the query filters by amount_native, all rows have the same amount.
    // We add default values for fields not in the query.
    const prefetchedTxs = (
      existingTxs as Array<{
        id: string;
        merchant: string | null;
        amount_native: number;
        tx_date: string;
        description_raw: string;
      }>
    ).map((tx) => ({
      id: tx.id,
      merchant: tx.merchant,
      amount_native: tx.amount_native,
      native_currency: candidate.native_currency, // same currency (query filtered by amount)
      amount_usd: null as number | null,
      card_last4: null as string | null, // extracted from description_raw by core
      tx_date: tx.tx_date,
      external_ts: null as string | null, // sync doesn't have this
      description_raw: tx.description_raw as string | null,
    }));

    // Build DedupCandidate from CandidateTransaction
    const dedupCandidate: DedupCandidate = {
      amount_native: candidate.amount_native,
      native_currency: candidate.native_currency,
      amount_usd: null, // sync doesn't have amount_usd at dedup time
      merchant: candidate.merchant,
      card_last4: candidate.card_last4 ?? extractCardLast4(candidate.description_raw),
      tx_date: candidate.tx_date,
      external_ts: null, // sync doesn't have external_ts
    };

    const opts: DedupOpts = {
      consumptionMap: boolConsumptionMap,
      _prefetchedTxs: prefetchedTxs,
    };

    const coreDecision = await resolveDuplicate(
      dedupCandidate,
      userId,
      supabase,
      opts
    );

    // Map core decision back to sync DedupDecision type
    if (coreDecision.action === "discard" || coreDecision.action === "upgrade") {
      // Sync treats upgrade as discard (upgrade is a push-pipeline concept)
      const matchedTxId = coreDecision.matchedTxId;
      const reason = mapCoreReasonToSyncReason(coreDecision.reason);

      // Update the number-based consumptionMap to reflect what was consumed
      if (consumptionMap && matchedTxId) {
        consumptionMap.set(matchedTxId, (consumptionMap.get(matchedTxId) ?? 0) + 1);
      }

      // Also sync the bool map back → not needed since we already updated consumptionMap

      return { action: "discard", reason };
    }

    if (coreDecision.action === "insert_review") {
      return {
        action: "insert_review",
        reason: mapCoreReasonToSyncReason(coreDecision.reason),
      };
    }

    // coreDecision.action === "insert" — fall through to push_ingest_log check
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
    // Push log rows are also consumable (1:1), so a single push capture can't
    // discard multiple surplus occurrences in the same batch (Req 7.9).
    const availablePush = consumptionMap
      ? pushLogs.filter(
          (p: { dedup_key: string }) =>
            (consumptionMap.get(`push:${p.dedup_key}`) ?? 0) < 1
        )
      : pushLogs;

    if (availablePush.length > 0) {
      if (consumptionMap) {
        const key = `push:${availablePush[0].dedup_key}`;
        consumptionMap.set(key, (consumptionMap.get(key) ?? 0) + 1);
      }
      return { action: "discard", reason: "already_captured_by_push" };
    }
  }

  // Level 5: No match at all → insert
  return { action: "insert" };
}
