import type { ParsedTransaction, ParserFn, PushPayload } from "../types";
import { resolveTxDate, TZ_OFFSETS } from "../dates";
import { parseCopAmount, normalizeDate } from "@/lib/sync/gmail/money";

// --- Classification regexes (ordered most-specific first) ---

const RE_ENTRADA = /(recibiste una transferencia|recibiste un pago)/i;
const RE_PAGO_QR = /pagaste .* por codigo QR/i;
const RE_PAGO_SERVICIO = /pagaste \$[\d.,]+ a/i;
const RE_COMPRA = /compraste \$[\d.,]+ en/i;
const RE_TRANSFERENCIA = /transferiste \$/i;

// --- Amount extraction ---

const RE_AMOUNT = /\$([\d.,]+)/;

// --- Card digits ---

const RE_CARD_DIGITS = /\*(\d{4})\b/;

// --- Date extraction ---

const RE_DATE = /(\d{2}\/\d{2}\/\d{2,4})/;

/**
 * Derive payment type from text.
 */
function derivePaymentType(text: string): string {
  if (/T\.Deb/i.test(text)) return "debito";
  if (/T\.Cred/i.test(text)) return "credito";
  if (/codigo QR/i.test(text)) return "pse_qr";
  if (RE_TRANSFERENCIA.test(text)) return "transferencia";
  return "otro";
}

/**
 * Map card digits to account name.
 * For now all cards default to "Bancolombia Ahorros".
 */
function resolveAccountName(_digits: string | null): string {
  return "Bancolombia Ahorros";
}

/**
 * Extract amount from text. Returns null if no amount found.
 */
function extractAmount(text: string): number | null {
  const match = text.match(RE_AMOUNT);
  if (!match) return null;
  return parseCopAmount(match[1]);
}

/**
 * Extract merchant name from a COMPRA text.
 * Pattern: "compraste $X en MERCHANT con tu ..."
 */
function extractMerchantFromCompra(text: string): string | null {
  const match = text.match(/compraste \$[\d.,]+ en (.+?) con tu/i);
  if (match) return match[1].trim();
  // Fallback: everything after "en" to end
  const fallback = text.match(/compraste \$[\d.,]+ en (.+?)(?:,|$)/i);
  return fallback ? fallback[1].trim() : null;
}

/**
 * Extract beneficiary from a PAGO_SERVICIO text.
 * Pattern: "pagaste $X a BENEFICIARY ..."
 */
function extractBeneficiaryFromPago(text: string): string | null {
  const match = text.match(/pagaste \$[\d.,]+ a (.+?)(?:\.|,| desde|$)/i);
  return match ? match[1].trim() : null;
}

/**
 * Extract destination from TRANSFERENCIA text.
 * Pattern: "transferiste $X a ... cta *XXXX"
 */
function extractDestinationFromTransfer(text: string): string | null {
  const match = text.match(/transferiste \$[\d.,]+ a (.+?)(?:\.|,|$)/i);
  return match ? match[1].trim() : null;
}

/**
 * Bancolombia push notification parser.
 * Handles: COMPRA, PAGO_QR, PAGO_SERVICIO, TRANSFERENCIA.
 * Ignores: ENTRADA (not an expense).
 */
export const bancolombiaParser: ParserFn = (payload: PushPayload): ParsedTransaction | null => {
  const text = payload.text;

  // 1. Classification — ordered most specific first
  if (RE_ENTRADA.test(text)) {
    // Income — not an expense
    return null;
  }

  const amount = extractAmount(text);
  if (amount === null || amount <= 0) return null;

  const cardDigitsMatch = text.match(RE_CARD_DIGITS);
  const cardDigits = cardDigitsMatch ? cardDigitsMatch[1] : null;
  const accountName = resolveAccountName(cardDigits);

  const dateMatch = text.match(RE_DATE);
  let txDate: string;
  if (dateMatch) {
    txDate = normalizeDate(dateMatch[1]);
  } else {
    txDate = resolveTxDate(payload.timestamp, TZ_OFFSETS.BOGOTA);
  }

  let merchant: string | null = null;

  if (RE_PAGO_QR.test(text)) {
    // QR payment — merchant is between "pagaste" and "por codigo QR"
    const qrMatch = text.match(/pagaste \$[\d.,]+ en (.+?) por codigo QR/i);
    merchant = qrMatch ? qrMatch[1].trim() : null;
  } else if (RE_COMPRA.test(text)) {
    merchant = extractMerchantFromCompra(text);
  } else if (RE_PAGO_SERVICIO.test(text)) {
    merchant = extractBeneficiaryFromPago(text);
  } else if (RE_TRANSFERENCIA.test(text)) {
    merchant = extractDestinationFromTransfer(text);
  } else {
    // No classification matched
    return null;
  }

  return {
    amount_native: amount,
    native_currency: "COP",
    merchant,
    tx_date: txDate,
    description_raw: text,
    account_name: accountName,
  };
};
