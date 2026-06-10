import type { ParsedTransaction, ParserFn, PushPayload } from "../types";

/**
 * Google Wallet push notification parser.
 *
 * Format observed from real notifications:
 * - title: merchant name (e.g. "PERGAMINO VIVA ENVIGAD", "BOLD SA*COYO TAC")
 * - text: "COP{amount} con {card_type} ••{last4}" (e.g. "COP7,500.00 con Debito Mastercard ••5685")
 *
 * Amount format: COP followed by number with comma as thousands separator and dot as decimal
 * (e.g. "COP7,500.00", "COP63,400.00") — note: this is the OPPOSITE locale of Bancolombia emails!
 * Here comma = thousands, dot = decimal (US/international format).
 */

const RE_AMOUNT = /COP([\d,]+\.?\d*)/i;
const RE_CARD_DIGITS = /••(\d{4})/;

/**
 * Parse Google Wallet amount format: COP7,500.00 → 7500.00
 * Uses comma as thousands separator, dot as decimal (international format).
 */
function parseWalletAmount(raw: string): number {
  // Remove commas (thousands separator) and parse as float
  const cleaned = raw.replace(/,/g, "");
  return parseFloat(cleaned);
}

/**
 * Derive payment type from text description.
 */
function derivePaymentType(text: string): string {
  if (/debito/i.test(text)) return "debito";
  if (/credito|credit/i.test(text)) return "credito";
  return "debito"; // default
}

/**
 * Convert epoch ms to YYYY-MM-DD in America/Bogota (UTC-5, no DST).
 * Same pattern as `internalDateToLocal` in the RappiCard Gmail parser.
 */
export function timestampToLocalDate(epochMs: number): string {
  const offsetMs = 5 * 60 * 60 * 1000;
  const local = new Date(epochMs - offsetMs);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Map card digits to account name.
 * TODO: make this configurable via Card_Account_Map
 */
function resolveAccountName(digits: string | null, text: string): string {
  // For now, infer from card type in text
  if (/Black/i.test(text) || /Cred/i.test(text)) return "Rappi"; // RappiCard is the Black card
  return "Bancolombia Ahorros"; // default for debit
}

export const googleWalletParser: ParserFn = (payload: PushPayload): ParsedTransaction | null => {
  const { title, text } = payload;

  // Extract amount from text
  const amountMatch = text.match(RE_AMOUNT);
  if (!amountMatch) return null; // Not a payment notification (could be promo)

  const amount = parseWalletAmount(amountMatch[1]);
  if (amount <= 0 || !isFinite(amount)) return null;

  // Merchant is in the title
  const merchant = title?.trim() || null;

  // Card digits
  const cardMatch = text.match(RE_CARD_DIGITS);
  const cardDigits = cardMatch ? cardMatch[1] : null;

  // Account name from card type in text
  const accountName = resolveAccountName(cardDigits, text);

  // Date: use postedAt from payload, converted to America/Bogota (UTC-5, no DST).
  // On Vercel the server clock is UTC, so a notification at 20:30 Bogotá (01:30 UTC next day)
  // would register the wrong date if we used getFullYear/getMonth/getDate directly.
  const postedAt = typeof payload.timestamp === "number"
    ? new Date(payload.timestamp)
    : new Date();
  const txDate = timestampToLocalDate(postedAt.getTime());

  return {
    amount_native: amount,
    native_currency: "COP",
    merchant,
    tx_date: txDate,
    description_raw: `${title} - ${text}`,
    account_name: accountName,
    card_last4: cardDigits,
  };
};
