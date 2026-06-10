import type { CandidateTransaction } from "../types";

/** Respuesta cruda del MCP bancolombia_get_transactions */
export interface BancolombiaRawTx {
  date: string; // "2024/01/15"
  description: string;
  amount: number;
  type: string; // "CREDITO" (outflow) | "DEBITO" (inflow) — API invierte la convención
  office: string;
}

/**
 * Transforma response de MCP → CandidateTransaction[].
 * Filtra solo tipo "CREDITO" (que en la API de Bancolombia = débito/gasto real).
 * Nota: la API de Bancolombia invierte la convención:
 * "CREDITO" = salida de dinero (gasto), "DEBITO" = entrada de dinero.
 */
export function adaptBancolombia(
  rawTxs: BancolombiaRawTx[]
): CandidateTransaction[] {
  return rawTxs
    .filter((tx) => tx.type === "CREDITO")
    .map((tx) => ({
      amount_native: Math.abs(tx.amount),
      native_currency: "COP",
      merchant: tx.description || null,
      tx_date: tx.date.replace(/\//g, "-"),
      description_raw: tx.description,
      account_name: "Bancolombia Ahorros",
      source: "sync_bancolombia" as const,
    }));
}
