import type { ParsedTransaction, ParserFn, PushPayload } from "../types";

/**
 * Rappi / RappiCard push notification parser.
 * Handles: "Tu compra en {MERCHANT} por $ {AMOUNT} fue exitosa"
 * Ignores: delivery notifications ("pedido entregado", "en camino", etc)
 */

// RappiCard purchase pattern
const RE_COMPRA = /tu compra en (.+?) por \$ ([\d.,]+) fue exitosa/i;

// Patterns that indicate non-financial notifications (delivery updates)
const RE_DELIVERY = /pedido (entregado|cancelado)|en camino|ya casi llega|alístate|llegó.*pedido/i;

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseAmount(raw: string): number {
  // "33.300" or "827.583" — Colombian format: dots are thousands, no decimals
  return parseFloat(raw.replace(/\./g, "").replace(",", "."));
}

export const rappiParser: ParserFn = (payload: PushPayload): ParsedTransaction | null => {
  const text = payload.text;
  const title = payload.title;

  // Skip delivery/non-financial notifications
  if (RE_DELIVERY.test(text) || RE_DELIVERY.test(title)) {
    return null;
  }

  // Only parse purchase confirmations
  const match = text.match(RE_COMPRA);
  if (!match) return null;

  const merchant = match[1].trim();
  const amount = parseAmount(match[2]);

  if (!amount || amount <= 0) return null;

  return {
    amount_native: amount,
    native_currency: "COP",
    merchant,
    tx_date: todayISO(),
    description_raw: text,
    account_name: "Rappi",
  };
};
