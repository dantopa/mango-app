import type { ParseResult, ParserFn, PushPayload } from "../types";
import { resolveTxDate } from "../dates";
import { isKnownCurrency, parseAmount } from "../money";

/**
 * Nexo Card push notification parser.
 * Handles: "Pago de {AMOUNT} {CURRENCY} (€X.XX) en {MERCHANT}. Cashback..."
 *          "Payment of {AMOUNT} {CURRENCY} (€X.XX) at {MERCHANT}."
 *          "Pago de €0.91 en {MERCHANT}. Cashback..."     (symbol before the amount)
 *          "Retiro en efectivo de €20.78(23.75 USD) en {MERCHANT}."
 *          "Reembolso de € 43.78(50.00 USD) de {MERCHANT}."
 * Ignores: promos, price alerts and balance updates.
 */

// Anchored to the "(€X.XX)" EUR-equivalent that always precedes "en"/"at":
// a bare ".*" here greedily matches through to the LAST "en" in the string,
// which crypto-cashback notifications ("... en MERCHANT. Cashback en
// cripto: ...") also contain, corrupting the merchant into the cashback text.
const RE_PAGO = /pago de ([\d.,]+) (\w+) \([^)]*\) en (.+?)\.?\s*(?:Cashback|$)/i;
const RE_PAYMENT_EN = /payment of ([\d.,]+) (\w+) \([^)]*\) at (.+?)\.?\s*(?:Cashback|$)/i;

/**
 * The same payment with a currency symbol in front of the amount. Before this
 * existed, "Pago de €0.91 en PAYPAL *PEACOCKTVLL" went through a path that
 * dropped the decimal point and stored 91 USD — €9.12 became 912 USD.
 */
const RE_PAGO_SYMBOL = /pago de ([€$])\s?([\d.,]+) en (.+?)\.?\s*(?:Cashback|$)/i;

/** Cash withdrawal: the euro amount, then what the USD card was debited. */
const RE_RETIRO = /retiro en efectivo de ([€$])\s?([\d.,]+)\s*\([^)]*\) en (.+?)\.?\s*$/i;

/** A refund to the card, stored negative (it cancels a charge, it is not income). */
const RE_REEMBOLSO = /reembolso de ([€$])\s?([\d.,]+)\s*(?:\([^)]*\))? de (.+?)\.?\s*$/i;

/**
 * "€" is always euros. A bare "$" on the Nexo card is its own currency (USD),
 * which the pipeline resolves from the account, so it stays null here.
 */
function symbolCurrency(symbol: string): string | null {
  return symbol === "€" ? "EUR" : null;
}

const RE_PROMO = /opera más|usa futures|multiplica|saldo de trading|precio de|descubre|aprovecha/i;

export const nexoParser: ParserFn = (payload: PushPayload): ParseResult => {
  const text = payload.text;

  if (RE_PROMO.test(text)) {
    return { kind: "ignore", reason: "promotional notification" };
  }

  const match = text.match(RE_PAGO) ?? text.match(RE_PAYMENT_EN);
  if (!match) return parseSymbolFormats(payload);

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

/** "Pago de €X en …", "Retiro en efectivo de €X(Y USD) en …", "Reembolso de € X(Y USD) de …". */
function parseSymbolFormats(payload: PushPayload): ParseResult {
  const text = payload.text;
  const refund = text.match(RE_REEMBOLSO);
  const match = refund ?? text.match(RE_PAGO_SYMBOL) ?? text.match(RE_RETIRO);
  if (!match) return { kind: "unknown" };

  const [, symbol, amountRaw, merchant] = match;
  const currency = symbolCurrency(symbol);
  // Two-decimal amounts: parse as such even when the card's currency is not known yet.
  const amount = parseAmount(amountRaw, currency ?? "USD");
  if (amount === null || amount <= 0) return { kind: "unknown" };

  return {
    kind: "transaction",
    tx: {
      amount_native: refund ? -amount : amount,
      native_currency: currency,
      merchant: merchant.trim(),
      tx_date: resolveTxDate(payload.timestamp),
      description_raw: text,
      account_name: "Nexo Card",
    },
  };
}
