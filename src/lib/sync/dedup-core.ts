/**
 * Unified dedup decision engine.
 *
 * Single function `resolveDuplicate()` that both push and sync pipelines call
 * to decide whether a candidate transaction is new, a duplicate, needs review,
 * or should upgrade an existing transaction.
 *
 * The identity ladder (levels 0–6) evaluates candidates against existing
 * transactions in the `transactions` table (canonical source of truth).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { compareMerchants } from "./fuzzy-matcher";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DedupCandidate {
  amount_native: number;
  native_currency: string;
  amount_usd: number | null;
  merchant: string | null;
  card_last4: string | null;
  tx_date: string; // YYYY-MM-DD
  external_ts: string | null; // ISO timestamp; null if source doesn't have it
}

export type DedupDecision =
  | { action: "insert" }
  | { action: "insert_review"; reason: string }
  | { action: "discard"; reason: string; matchedTxId: string }
  | { action: "upgrade"; reason: string; matchedTxId: string };

export interface DedupOpts {
  consumptionMap?: Map<string, boolean>; // multiplicity (sync batch)
  excludeClaimedTxIds?: string[]; // multiplicity (push): tx IDs already claimed by another notification
  fineWindowSec?: number; // default 90
  usdTolerancePct?: number; // default 5 (level 1c) / 2 (level 3)
  /** Pre-fetched existing transactions — skips the DB query when provided.
   *  Used by evaluateCandidate (sync wrapper) which queries with its own shape. */
  _prefetchedTxs?: Array<{
    id: string;
    merchant: string | null;
    amount_native: number;
    native_currency: string;
    amount_usd: number | null;
    card_last4: string | null;
    tx_date: string;
    external_ts: string | null;
    description_raw: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// Internal types for the existing transaction rows we query
// ---------------------------------------------------------------------------

interface ExistingTx {
  id: string;
  merchant: string | null;
  amount_native: number;
  native_currency: string;
  amount_usd: number | null;
  card_last4: string | null;
  tx_date: string;
  external_ts: string | null;
  description_raw: string | null;
}

// ---------------------------------------------------------------------------
// Quality function (Req 5.1)
// ---------------------------------------------------------------------------

/**
 * Heuristic: returns true if the currency is a local POS currency (not USD).
 * For Colombian purchases, COP is the ground-truth POS currency;
 * USD is the settlement currency from the issuing bank (includes spread).
 */
function isLocalPosCurrency(currency: string): boolean {
  // The local POS currency is anything that's NOT USD (COP, ARS, etc.)
  return currency !== "USD";
}

/**
 * Quality score for a transaction version. Higher = better data.
 * Components:
 *   +4  has merchant
 *   +2  has card_last4
 *   +1  local POS currency (COP for Colombia > USD settlement)
 */
export function quality(tx: {
  merchant: string | null;
  card_last4: string | null;
  native_currency: string;
}): number {
  let s = 0;
  if (tx.merchant) s += 4;
  if (tx.card_last4) s += 2;
  if (isLocalPosCurrency(tx.native_currency)) s += 1;
  return s;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CARD_LAST4_REGEX = /[*•]{1,2}(\d{4})\b/;

/** Extract card_last4 from description_raw as fallback */
function extractCardLast4(descriptionRaw: string | null): string | null {
  if (!descriptionRaw) return null;
  const match = descriptionRaw.match(CARD_LAST4_REGEX);
  return match ? match[1] : null;
}

/** Returns ±1 day date window around given YYYY-MM-DD */
function getDateWindow(txDate: string): { dateFrom: string; dateTo: string } {
  const date = new Date(txDate + "T12:00:00Z");
  const prev = new Date(date);
  prev.setUTCDate(prev.getUTCDate() - 1);
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + 1);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { dateFrom: fmt(prev), dateTo: fmt(next) };
}

/** Check if two external_ts are within the given window (seconds) */
function withinFineWindow(
  tsA: string | null,
  tsB: string | null,
  windowSec: number
): boolean {
  if (!tsA || !tsB) return false;
  const a = new Date(tsA).getTime();
  const b = new Date(tsB).getTime();
  if (isNaN(a) || isNaN(b)) return false;
  return Math.abs(a - b) <= windowSec * 1000;
}

/** Check if two USD amounts are within a tolerance percentage */
function withinUsdTolerance(
  usdA: number | null,
  usdB: number | null,
  tolerancePct: number
): boolean {
  if (usdA == null || usdB == null) return false;
  if (usdA === 0 && usdB === 0) return true;
  const avg = (Math.abs(usdA) + Math.abs(usdB)) / 2;
  if (avg === 0) return true;
  const diff = Math.abs(usdA - usdB);
  return (diff / avg) * 100 <= tolerancePct;
}

/** Decide discard vs upgrade based on quality comparison */
function discardOrUpgrade(
  candidate: DedupCandidate,
  existing: ExistingTx,
  reason: string
): DedupDecision {
  const candidateQuality = quality({
    merchant: candidate.merchant,
    card_last4: candidate.card_last4,
    native_currency: candidate.native_currency,
  });
  const existingQuality = quality({
    merchant: existing.merchant,
    card_last4: existing.card_last4,
    native_currency: existing.native_currency,
  });

  if (candidateQuality > existingQuality) {
    return { action: "upgrade", reason, matchedTxId: existing.id };
  }
  return { action: "discard", reason, matchedTxId: existing.id };
}

/** Get the effective card_last4 from either the column or extracted from description_raw */
function getEffectiveLast4(tx: ExistingTx): string | null {
  return tx.card_last4 ?? extractCardLast4(tx.description_raw);
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Resolves whether a candidate transaction is a duplicate, new, should
 * upgrade an existing record, or needs human review.
 *
 * Evaluates the identity ladder (levels 0–6) against existing transactions
 * in the `transactions` table for the given user.
 *
 * @param candidate - Normalized candidate from any source
 * @param userId - The user who owns the transactions
 * @param supabase - Supabase client (injected for testability)
 * @param opts - Optional configuration (consumptionMap, tolerances)
 */
export async function resolveDuplicate(
  candidate: DedupCandidate,
  userId: string,
  supabase: SupabaseClient<Database>,
  opts?: DedupOpts
): Promise<DedupDecision> {
  const fineWindowSec = opts?.fineWindowSec ?? 90;
  const usdTolerancePct = opts?.usdTolerancePct ?? 5;
  const consumptionMap = opts?.consumptionMap;
  const excludeClaimedTxIds = opts?.excludeClaimedTxIds;

  const { dateFrom, dateTo } = getDateWindow(candidate.tx_date);

  // --- Get existing transactions within ±1 day window ---
  let allTxs: ExistingTx[];

  if (opts?._prefetchedTxs) {
    // Caller already fetched the data (e.g., evaluateCandidate sync wrapper)
    allTxs = opts._prefetchedTxs.map((row) => ({
      id: row.id,
      merchant: row.merchant,
      amount_native: row.amount_native,
      native_currency: row.native_currency,
      amount_usd: row.amount_usd,
      card_last4: row.card_last4,
      tx_date: row.tx_date,
      external_ts: row.external_ts,
      description_raw: row.description_raw,
    }));
  } else {
    // Query existing transactions — broader set, filter in code for various levels.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = (supabase as any)
      .from("transactions")
      .select(
        "id, merchant, amount_native, native_currency, amount_usd, card_last4, tx_date, external_ts, description_raw"
      )
      .eq("user_id", userId)
      .gte("tx_date", dateFrom)
      .lte("tx_date", dateTo);

    const { data: rawTxs, error } = await query;

    if (error) {
      // Fail open: if we can't query, treat as no match → insert (never lose a transaction)
      console.error("[dedup-core] transactions query error:", error.message);
      return { action: "insert" };
    }

    allTxs = (rawTxs ?? []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (row: any) => ({
        id: row.id as string,
        merchant: row.merchant as string | null,
        amount_native: row.amount_native as number,
        native_currency: row.native_currency as string,
        amount_usd: row.amount_usd as number | null,
        card_last4: row.card_last4 as string | null,
        tx_date: row.tx_date as string,
        external_ts: row.external_ts as string | null,
        description_raw: row.description_raw as string | null,
      })
    );
  }

  // Filter out already-consumed transactions (multiplicity)
  // - consumptionMap: sync batch tracks consumed IDs in memory
  // - excludeClaimedTxIds: push pipeline passes IDs already claimed by other notifications
  const claimedSet = excludeClaimedTxIds?.length
    ? new Set(excludeClaimedTxIds)
    : null;

  const availableTxs = allTxs.filter((tx) => {
    if (consumptionMap?.get(tx.id)) return false;
    if (claimedSet?.has(tx.id)) return false;
    return true;
  });

  if (availableTxs.length === 0) {
    return { action: "insert" };
  }

  const candidateLast4 = candidate.card_last4;

  // === Level 0: no merchant + same currency + same amount + date match ===
  if (!candidate.merchant) {
    const sameCurrencyAmountMatch = availableTxs.find(
      (tx) =>
        tx.native_currency === candidate.native_currency &&
        tx.amount_native === candidate.amount_native
    );
    if (sameCurrencyAmountMatch) {
      if (consumptionMap) consumptionMap.set(sameCurrencyAmountMatch.id, true);
      return {
        action: "discard",
        reason: "no_merchant",
        matchedTxId: sameCurrencyAmountMatch.id,
      };
    }
  }

  // === Level 1: card_last4 match + same currency + same amount + date ±1 day ===
  if (candidateLast4) {
    for (const tx of availableTxs) {
      const txLast4 = getEffectiveLast4(tx);
      if (
        txLast4 &&
        txLast4 === candidateLast4 &&
        tx.native_currency === candidate.native_currency &&
        tx.amount_native === candidate.amount_native
      ) {
        if (consumptionMap) consumptionMap.set(tx.id, true);
        return { action: "discard", reason: "card_match", matchedTxId: tx.id };
      }
    }
  }

  // === Level 1c: cross-currency card match ===
  // card_last4 match + merchant match + external_ts ±90s + different currencies
  if (candidateLast4 && candidate.external_ts) {
    for (const tx of availableTxs) {
      const txLast4 = getEffectiveLast4(tx);
      if (!txLast4 || txLast4 !== candidateLast4) continue;
      if (tx.native_currency === candidate.native_currency) continue; // same currency → not cross-currency

      const merchantResult = compareMerchants(candidate.merchant, tx.merchant);
      if (merchantResult !== "match") continue;

      // Fine window: both must have external_ts
      if (!withinFineWindow(candidate.external_ts, tx.external_ts, fineWindowSec)) continue;

      // USD corroborator
      if (withinUsdTolerance(candidate.amount_usd, tx.amount_usd, usdTolerancePct)) {
        // Level 1c: confirmed cross-currency duplicate
        if (consumptionMap) consumptionMap.set(tx.id, true);
        return discardOrUpgrade(candidate, tx, "cross_currency_card_match");
      } else {
        // Level 1c-rev: USD drift → needs review
        return {
          action: "insert_review",
          reason: "cross_currency_amount_drift",
        };
      }
    }
  }

  // === Level 2: same currency amount match + date ±1 day + merchant match ===
  if (candidate.merchant) {
    for (const tx of availableTxs) {
      if (
        tx.native_currency === candidate.native_currency &&
        tx.amount_native === candidate.amount_native
      ) {
        const merchantResult = compareMerchants(candidate.merchant, tx.merchant);
        if (merchantResult === "match") {
          if (consumptionMap) consumptionMap.set(tx.id, true);
          return discardOrUpgrade(candidate, tx, "merchant_match");
        }
      }
    }
  }

  // === Level 3: no common last4 + merchant match + fine window + amount_usd ±2% ===
  if (candidate.merchant && candidate.external_ts) {
    const level3Tolerance = 2; // stricter tolerance without card evidence
    for (const tx of availableTxs) {
      // Must NOT have a common card_last4
      const txLast4 = getEffectiveLast4(tx);
      const hasCommonLast4 = candidateLast4 && txLast4 && candidateLast4 === txLast4;
      if (hasCommonLast4) continue;

      const merchantResult = compareMerchants(candidate.merchant, tx.merchant);
      if (merchantResult !== "match") continue;

      // Fine window: both must have external_ts
      if (!withinFineWindow(candidate.external_ts, tx.external_ts, fineWindowSec)) continue;

      // USD corroborator with stricter tolerance
      if (withinUsdTolerance(candidate.amount_usd, tx.amount_usd, level3Tolerance)) {
        return {
          action: "insert_review",
          reason: "cross_currency_no_card",
        };
      }
    }
  }

  // === Level 4: same amount + date + merchant ambiguous ===
  if (candidate.merchant) {
    for (const tx of availableTxs) {
      if (
        tx.native_currency === candidate.native_currency &&
        tx.amount_native === candidate.amount_native
      ) {
        const merchantResult = compareMerchants(candidate.merchant, tx.merchant);
        if (merchantResult === "ambiguous") {
          return {
            action: "insert_review",
            reason: "ambiguous_merchant_match",
          };
        }
      }
    }
  }

  // === Level 5: same amount + date + merchant no_match, no common last4 ===
  for (const tx of availableTxs) {
    if (
      tx.native_currency === candidate.native_currency &&
      tx.amount_native === candidate.amount_native
    ) {
      const txLast4 = getEffectiveLast4(tx);
      const hasCommonLast4 = candidateLast4 && txLast4 && candidateLast4 === txLast4;
      if (hasCommonLast4) continue;

      // Only trigger if merchants truly differ (no_match) or candidate has merchant
      if (candidate.merchant) {
        const merchantResult = compareMerchants(candidate.merchant, tx.merchant);
        if (merchantResult === "no_match") {
          return {
            action: "insert_review",
            reason: "same_amount_date_diff_merchant",
          };
        }
      }
    }
  }

  // === Level 6: no match at all ===
  return { action: "insert" };
}
