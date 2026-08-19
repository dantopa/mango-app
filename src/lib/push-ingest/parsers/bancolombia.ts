import type { ParseResult, ParserFn, PushPayload } from "../types";
import { resolveTxDate, TZ_OFFSETS } from "../dates";
import { parseCopAmount, normalizeDate } from "@/lib/sync/gmail/money";

// --- Classification regexes (ordered most-specific first) ---

// `\s+` por el mismo motivo que en sync/gmail: el texto largo de la notificación
// puede venir cortado, y un ingreso mal clasificado se vuelve un gasto inventado.
const RE_ENTRADA = /recibiste\s+(una\s+transferencia|un\s+pago)/i;
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
 * Every Bancolombia notification observed so far comes from the same account;
 * `card_last4` is what disambiguates it downstream if that ever stops holding.
 */
const ACCOUNT_NAME = "Bancolombia Ahorros";

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
export const bancolombiaParser: ParserFn = (payload: PushPayload): ParseResult => {
  const text = payload.text;

  // 1. Classification — ordered most specific first
  if (RE_ENTRADA.test(text)) {
    return { kind: "ignore", reason: "incoming transfer, not an expense" };
  }

  const amount = extractAmount(text);
  if (amount === null || amount <= 0) return { kind: "unknown" };

  const cardDigitsMatch = text.match(RE_CARD_DIGITS);
  const cardDigits = cardDigitsMatch ? cardDigitsMatch[1] : null;

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
    // Has an amount but no recognized operation type — worth escalating.
    return { kind: "unknown" };
  }

  return {
    kind: "transaction",
    tx: {
      amount_native: amount,
      native_currency: "COP",
      merchant,
      tx_date: txDate,
      description_raw: text,
      account_name: ACCOUNT_NAME,
      card_last4: cardDigits,
    },
  };
};
