import type { CandidateTransaction } from "../types";

/** Respuesta cruda del MCP nexo_get_card_transactions */
export interface NexoRawTx {
  date: string; // "2024-01-15"
  merchant: string;
  category: string;
  amount_usd: number;
  amount_local: string;
  local_currency: string;
  cashback_usd: string;
  status: string;
  type: string;
}

/**
 * Transforma response de MCP → CandidateTransaction[].
 * Nexo ya reporta en USD, fx_rate_to_usd = 1.
 */
export function adaptNexo(rawTxs: NexoRawTx[]): CandidateTransaction[] {
  return rawTxs.map((tx) => ({
    amount_native: tx.amount_usd,
    native_currency: "USD",
    fx_rate_to_usd: 1,
    amount_usd: tx.amount_usd,
    merchant: tx.merchant || null,
    tx_date: tx.date,
    description_raw: tx.merchant
      ? `${tx.merchant} — ${tx.category}`
      : tx.category,
    account_name: "Nexo Card",
    source: "sync_nexo" as const,
  }));
}
