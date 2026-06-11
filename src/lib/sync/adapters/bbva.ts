import type { CandidateTransaction } from "../types";

/** Raw transaction from bbva_get_card_transactions MCP tool */
export interface BbvaRawTx {
  date: string; // "2026-06-09"
  merchant: string; // concept
  amount: number; // positive = charge
  currency: "ARS" | "USD";
  installments: string | null; // null for NON_FINANCING
  type: string; // "PURCHASE" | "AUTHORIZED" | "CASH_INCOME" etc
  international: boolean;
}

/** Transaction types that represent actual consumer purchases */
const PURCHASE_TYPES = new Set(["PURCHASE", "AUTHORIZED"]);

/** Transaction types that are payments, credits, or non-expense items */
const EXCLUDED_TYPES = new Set(["CASH_INCOME", "PAYMENT", "FEE", "TAX", "INTEREST"]);

/**
 * Transforms BBVA raw transactions → CandidateTransaction[].
 * Filters to purchases only (PURCHASE/AUTHORIZED types with positive amount).
 * Payments, taxes, interests are excluded.
 * International purchases in USD are preserved with fx_rate_to_usd = 1.
 *
 * @param rawTxs - Raw transactions from the MCP provider
 * @param accountName - "BBVA Visa" or "BBVA Mastercard"
 * @param cardLast4 - Last 4 digits of the card (e.g. "9253")
 */
export function adaptBbva(
  rawTxs: BbvaRawTx[],
  accountName: string,
  cardLast4: string
): CandidateTransaction[] {
  return rawTxs
    .filter((tx) => isConsumption(tx))
    .map((tx) => {
      const isUsd = tx.currency === "USD";

      return {
        amount_native: Math.abs(tx.amount),
        native_currency: isUsd ? "USD" : "ARS",
        ...(isUsd ? { fx_rate_to_usd: 1, amount_usd: Math.abs(tx.amount) } : {}),
        merchant: tx.merchant || null,
        tx_date: tx.date,
        description_raw: tx.installments
          ? `${tx.merchant} (cuota ${tx.installments})`
          : tx.merchant,
        account_name: accountName,
        source: "sync_bbva" as const,
        card_last4: cardLast4,
        country: "AR",
      };
    });
}

/**
 * Determines if a transaction is a consumer purchase.
 * Includes PURCHASE and AUTHORIZED types; excludes payments/income/fees.
 * For unknown types, includes them but they'll be marked needs_review
 * by the categorizer (under-count principle: don't discard silently).
 */
function isConsumption(tx: BbvaRawTx): boolean {
  // Always exclude payments/credits (negative amounts handled at provider level,
  // but double-check here)
  if (tx.amount <= 0) return false;

  // Explicitly known purchase types → include
  if (PURCHASE_TYPES.has(tx.type)) return true;

  // Explicitly known non-purchase types → exclude
  if (EXCLUDED_TYPES.has(tx.type)) return false;

  // Unknown type with positive amount → include (under-count principle:
  // better to include and let the categorizer mark needs_review than discard)
  return true;
}
