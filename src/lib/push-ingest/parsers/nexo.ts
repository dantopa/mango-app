import type { ParseResult, ParserFn, PushPayload } from "../types";
import { resolveTxDate } from "../dates";
import { isKnownCurrency, parseAmount } from "../money";

/**
 * Nexo Card push notification parser.
 * Handles: "Pago de {AMOUNT} {CURRENCY} (€X.XX) en {MERCHANT}. Cashback..."
 *          "Payment of {AMOUNT} {CURRENCY} (€X.XX) at {MERCHANT}."
 * Ignores: promos, price alerts and balance updates.
 */

// Anchored to the "(€X.XX)" EUR-equivalent that always precedes "en"/"at":
// a bare ".*" here greedily matches through to the LAST "en" in the string,
// which crypto-cashback notifications ("... en MERCHANT. Cashback en
// cripto: ...") also contain, corrupting the merchant into the cashback text.
const RE_PAGO = /pago de ([\d.,]+) (\w+) \([^)]*\) en (.+?)\.?\s*(?:Cashback|$)/i;
const RE_PAYMENT_EN = /payment of ([\d.,]+) (\w+) \([^)]*\) at (.+?)\.?\s*(?:Cashback|$)/i;

const RE_PROMO = /opera más|usa futures|multiplica|saldo de trading|precio de|descubre|aprovecha/i;

export const nexoParser: ParserFn = (payload: PushPayload): ParseResult => {
  const text = payload.text;

  if (RE_PROMO.test(text)) {
    return { kind: "ignore", reason: "promotional notification" };
  }

  const match = text.match(RE_PAGO) ?? text.match(RE_PAYMENT_EN);
  if (!match) return { kind: "unknown" };

  const currency = match[2].toUpperCase();
  if (!isKnownCurrency(currency)) return { kind: "unknown" };

  const amount = parseAmount(match[1], currency);
  if (amount === null || amount <= 0) return { kind: "unknown" };

  return {
    kind: "transaction",
    tx: {
      amount_native: amount,
      native_currency: currency,
      merchant: match[3].trim(),
      tx_date: resolveTxDate(payload.timestamp),
      description_raw: text,
      account_name: "Nexo Card",
    },
  };
};
