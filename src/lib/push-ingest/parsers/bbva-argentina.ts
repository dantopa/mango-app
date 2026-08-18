import type { ParseResult, ParserFn, PushPayload } from "../types";
import { resolveTxDate, TZ_OFFSETS } from "../dates";
import { detectCurrency, parseAmount } from "../money";

/**
 * BBVA Argentina push notification parser.
 *
 * Formats observed from real notifications:
 * - approved: title "Compra aprobada"
 *             "Por USD17,70 a BOLD SA*COYO TAC, con tu tarjeta Mastercard *1886"
 *             "Por ARS6.490,00 a DLO*Rappi Pro, con tu tarjeta Mastercard *1886"
 * - declined: title "Compra rechazada"
 *             "Por ARS23.280,00 a CUOTA SOCIAL - CAR, porque tu tarjeta ... está pausada"
 *
 * 49 of the ~55 BBVA notifications in push_raw_log are declined. They must never
 * become transactions, and — critically — they must be reported as `ignore`, not
 * as an unparseable notification: returning null used to send them to the LLM,
 * which happily turned every rejection into a phantom expense.
 *
 * Amounts always use the Argentine convention (dot thousands, comma decimal),
 * including for USD ("USD16,91"); `parseAmount` handles both.
 */

const RE_APPROVED = /compra aprobada/i;
const RE_DECLINED = /compra rechazada|rechazad[ao]|no pudimos procesar/i;

/** "Por <CUR><amount> a <merchant>" — the currency code may be absent ("$"). */
const RE_AMOUNT = /por\s+((?:ARS|USD|U\$S|US\$|\$)\s*[\d.,]+)/i;

/** Merchant sits between " a " and the clause about the card. */
const RE_MERCHANT = / a (.+?)(?:,| con tu| porque| por ingresar)/i;

const RE_CARD_DIGITS = /\*(\d{4})\b/;

export const bbvaArgentinaParser: ParserFn = (payload: PushPayload): ParseResult => {
  const { title, text } = payload;
  const titleAndText = `${title} ${text}`;

  if (RE_DECLINED.test(titleAndText)) {
    return { kind: "ignore", reason: "declined purchase" };
  }
  if (!RE_APPROVED.test(title)) return { kind: "unknown" };

  const amountMatch = text.match(RE_AMOUNT);
  if (!amountMatch) return { kind: "unknown" };

  // A bare "$" from a BBVA app is ARS; an explicit code wins.
  const currency = detectCurrency(amountMatch[1]) ?? "ARS";
  const amount = parseAmount(amountMatch[1], currency);
  if (amount === null || amount <= 0) {
    // "Compra aprobada por ARS0,00" is an authorization hold, not a purchase.
    return { kind: "ignore", reason: "approved purchase with no amount" };
  }

  const merchantMatch = text.match(RE_MERCHANT);
  const cardMatch = text.match(RE_CARD_DIGITS);

  return {
    kind: "transaction",
    tx: {
      amount_native: amount,
      native_currency: currency,
      merchant: merchantMatch ? merchantMatch[1].trim() : null,
      // Buenos Aires (UTC-3).
      tx_date: resolveTxDate(payload.timestamp, TZ_OFFSETS.BUENOS_AIRES),
      description_raw: `${title} - ${text}`,
      // Only a fallback: `card_last4` is what actually resolves the account.
      account_name: /mastercard/i.test(text)
        ? "BBVA Mastercard"
        : /visa/i.test(text)
          ? "BBVA Visa"
          : "BBVA",
      card_last4: cardMatch ? cardMatch[1] : null,
    },
  };
};
