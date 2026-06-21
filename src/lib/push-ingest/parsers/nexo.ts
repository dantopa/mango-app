import type { ParsedTransaction, ParserFn, PushPayload } from "../types";
import { resolveTxDate } from "../dates";

/**
 * Nexo Card push notification parser.
 * Handles: "Pago de {AMOUNT} {CURRENCY} (€X.XX) en {MERCHANT}. Cashback..."
 * Ignores: promo notifications ("Opera más con menos", "Usa Futures", etc)
 */

// Nexo Card payment pattern (Spanish)
const RE_PAGO = /pago de ([\d.,]+) (\w+) .* en (.+?)\.?\s*(?:Cashback|$)/i;

// English variant: "Payment of X.XX USD at MERCHANT"
const RE_PAYMENT_EN = /payment of ([\d.,]+) (\w+) .* at (.+?)\.?\s*(?:Cashback|$)/i;

// Promotional/non-financial patterns to skip
const RE_PROMO = /opera más|usa futures|multiplica|saldo de trading|precio de|descubre|aprovecha/i;

export const nexoParser: ParserFn = (payload: PushPayload): ParsedTransaction | null => {
  const text = payload.text;

  // Skip promos
  if (RE_PROMO.test(text)) return null;

  // Try Spanish pattern first
  let match = text.match(RE_PAGO);
  if (!match) {
    // Try English pattern
    match = text.match(RE_PAYMENT_EN);
  }
  if (!match) return null;

  const amountRaw = match[1];
  const currency = match[2].toUpperCase();
  const merchant = match[3].trim();

  const amount = parseFloat(amountRaw.replace(",", "."));
  if (!amount || amount <= 0) return null;

  return {
    amount_native: amount,
    native_currency: currency === "USD" ? "USD" : currency,
    merchant,
    tx_date: resolveTxDate(payload.timestamp),
    description_raw: text,
    account_name: "Nexo Card",
  };
};
