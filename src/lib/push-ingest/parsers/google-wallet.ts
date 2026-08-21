import type { ParseResult, ParserFn, PushPayload } from "../types";
import { resolveTxDate } from "../dates";
import { detectCurrency, parseAmount } from "../money";

/**
 * Google Wallet (tap-to-pay) push notification parser.
 *
 * Every format below is taken verbatim from push_raw_log:
 *
 *   charge   "$14.25 con Mastercard Nexo Card ••4186"
 *   charge   "COP7,525.00 con TARJETA NEGRA RAPPICARD CO ••3679"
 *   declined "RECHAZADO: $50.00 pagado con Signature ••9253"
 *   refund   "Se reembolsó un importe de -COP124,414.00 en TARJETA NEGRA RAPPICARD CO ••3679"
 *   refund   "Se ha reembolsado en la tarjeta Nexo Mastercard ••4186 el siguiente importe: -11.475 COP"
 *   other    "En horario: De MDE a CLO"  (boarding pass — no card, no amount)
 *
 * The merchant is always the notification title.
 *
 * Currency is whatever the text says, not a constant: this parser used to force
 * "COP" and only matched `COP`-prefixed amounts, so every USD notification fell
 * through to the LLM.
 *
 * A bare "$" is USD. Wallet always writes the ISO code for anything else — over
 * 127 bare-"$" notifications in push_raw_log are all two-decimal amounts, and
 * they appear on COP cards too ("$29.73 con TARJETA NEGRA RAPPICARD CO ••3679"
 * next to 58 "COP10,200.00" ones), i.e. international purchases billed in USD.
 * Resolving them by account currency would read $13.28 as 13 pesos.
 */

/** What a bare "$" means in this source. */
const DEFAULT_CURRENCY = "USD";

/** Amount plus the card it was charged to: "<amount> con|en <label> ••1234". */
const RE_CHARGE = /([-−]?\s*(?:COP|ARS|USD|US\$|R\$|€|\$)\s*[\d.,]+)\s+(?:con|en)\s+(.+?)\s*••(\d{4})/i;

/** Google Wallet marks a declined attempt with a leading RECHAZADO/DECLINED. */
const RE_DECLINED = /^\s*(?:RECHAZADO|DECLINED)\b/i;

/** Refunds are phrased as a reimbursement and carry a negative amount. */
const RE_REFUND = /se reembols|refunded/i;

/**
 * A second refund phrasing puts the card before the amount and the currency
 * as a SUFFIX instead of a prefix: "reembolsado en <card> ••1234 ... importe:
 * <amount><currency>". RE_CHARGE never matches this order, so without this it
 * escalates to the AI — which, worse, tends to read "reimbursement" as "not an
 * expense" and drops it via `is_transaction: false` instead of registering it
 * as a negative amount, silently leaving the original charge unreversed.
 */
const RE_REFUND_SUFFIX =
  /reembolsad[oa] en (?:la tarjeta )?(.+?)\s*••(\d{4}).*?importe:\s*([-−]?[\d.,]+)\s*(COP|ARS|USD|USDT|EUR|BRL|MXN|CLP|PEN|UYU|GBP)/i;

/** Any notification mentioning a card is payment-related; the rest is boarding passes and promos. */
const RE_HAS_CARD = /••\d{4}/;

/**
 * Convert epoch ms to YYYY-MM-DD in America/Bogota (UTC-5, no DST).
 * @deprecated Use `resolveTxDate` from `../dates` directly. Kept for test compat.
 */
export function timestampToLocalDate(epochMs: number): string {
  return resolveTxDate(epochMs);
}

export const googleWalletParser: ParserFn = (payload: PushPayload): ParseResult => {
  const { title, text } = payload;

  if (RE_DECLINED.test(text)) {
    return { kind: "ignore", reason: "declined payment" };
  }

  const match = text.match(RE_CHARGE);
  if (!match) {
    const refundMatch = text.match(RE_REFUND_SUFFIX);
    if (refundMatch) {
      const [, cardLabel, cardDigits, amountRaw, currency] = refundMatch;
      const amount = parseAmount(amountRaw, currency);
      if (amount === null || amount === 0) return { kind: "unknown" };
      return {
        kind: "transaction",
        tx: {
          amount_native: -Math.abs(amount),
          native_currency: currency.toUpperCase(),
          merchant: title?.trim() || null,
          tx_date: resolveTxDate(payload.timestamp),
          description_raw: `${title} - ${text}`,
          account_name: cardLabel.trim(),
          card_last4: cardDigits,
        },
      };
    }

    // A card in the text means we should have understood it: escalate. Anything
    // else is a boarding pass, an event ticket or a promo.
    return RE_HAS_CARD.test(text)
      ? { kind: "unknown" }
      : { kind: "ignore", reason: "not a payment notification" };
  }

  const [, amountRaw, cardLabel, cardDigits] = match;
  const currency = detectCurrency(amountRaw) ?? DEFAULT_CURRENCY;
  const amount = parseAmount(amountRaw, currency);
  if (amount === null || amount === 0) return { kind: "unknown" };

  const isRefund = RE_REFUND.test(text);
  // A refund reduces spending, so it is stored negative regardless of how the
  // notification signs it; a charge is always positive.
  const signedAmount = isRefund ? -Math.abs(amount) : Math.abs(amount);

  return {
    kind: "transaction",
    tx: {
      amount_native: signedAmount,
      native_currency: currency,
      merchant: title?.trim() || null,
      // Bogotá (UTC-5): on Vercel the clock is UTC, so a 20:30 purchase would
      // otherwise be dated the next day.
      tx_date: resolveTxDate(payload.timestamp),
      description_raw: `${title} - ${text}`,
      account_name: cardLabel.trim(),
      card_last4: cardDigits,
    },
  };
};
