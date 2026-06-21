import type { ParsedTransaction, ParserFn, PushPayload } from "../types";
import { resolveTxDate, TZ_OFFSETS } from "../dates";

/**
 * BBVA Argentina push notification parser.
 *
 * Format observed from real notifications:
 * - title: "Compra aprobada"
 * - text: "Por USD17,70 a BOLD SA*COYO TAC, con tu tarjeta Mastercard *1886"
 *         "Por $12.500,00 a MERCADOLIBRE, con tu tarjeta Mastercard *1886"
 *
 * Amount formats:
 * - USD: "USD17,70" — comma as decimal separator
 * - ARS: "$12.500,00" — dot as thousands, comma as decimal (Argentine locale)
 */

// Match "USD{amount}" or "${amount}" or "ARS{amount}" with Argentine locale (dot=thousands, comma=decimal)
const RE_USD_AMOUNT = /USD([\d.,]+)/i;
const RE_ARS_AMOUNT = /(?:ARS|\$)([\d.,]+)/;

// Merchant: everything between " a " and ", con tu"
const RE_MERCHANT = / a (.+?), con tu/i;

// Card last 4 digits
const RE_CARD_DIGITS = /\*(\d{4})\b/;

/**
 * Parse Argentine-locale amount: "17,70" → 17.70 or "12.500,00" → 12500.00
 * Convention: dot = thousands separator, comma = decimal separator
 */
function parseArgAmount(raw: string): number {
  // Remove dots (thousands), replace comma with dot (decimal)
  const cleaned = raw.replace(/\./g, "").replace(",", ".");
  return parseFloat(cleaned);
}

export const bbvaArgentinaParser: ParserFn = (payload: PushPayload): ParsedTransaction | null => {
  const { title, text } = payload;

  // Only parse "Compra aprobada" notifications
  if (!/compra aprobada/i.test(title)) return null;

  // Determine currency and extract amount
  let amountNative: number;
  let nativeCurrency: string;

  const usdMatch = text.match(RE_USD_AMOUNT);
  if (usdMatch) {
    amountNative = parseArgAmount(usdMatch[1]);
    nativeCurrency = "USD";
  } else {
    const arsMatch = text.match(RE_ARS_AMOUNT);
    if (!arsMatch) return null;
    amountNative = parseArgAmount(arsMatch[1]);
    nativeCurrency = "ARS";
  }

  if (amountNative <= 0 || !isFinite(amountNative)) return null;

  // Extract merchant
  const merchantMatch = text.match(RE_MERCHANT);
  const merchant = merchantMatch ? merchantMatch[1].trim() : null;

  // Card digits
  const cardMatch = text.match(RE_CARD_DIGITS);
  const cardDigits = cardMatch ? cardMatch[1] : null;

  // Date from payload timestamp — Buenos Aires (UTC-3)
  const txDate = resolveTxDate(payload.timestamp, TZ_OFFSETS.BUENOS_AIRES);

  // Resolve account by card network mentioned in the notification
  let accountName = "BBVA";
  if (/mastercard/i.test(text)) accountName = "BBVA Mastercard";
  else if (/visa/i.test(text)) accountName = "BBVA Visa";

  return {
    amount_native: amountNative,
    native_currency: nativeCurrency,
    merchant,
    tx_date: txDate,
    description_raw: `${title} - ${text}`,
    account_name: accountName,
    card_last4: cardDigits,
  };
};
