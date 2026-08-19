import type { GmailSourceDef, ParsedEmail } from "../types";
import type { CandidateTransaction } from "../../types";
import { parseCopAmount, normalizeDate, internalDateToLocal } from "../money";

// --- Extraction regexes ---
// Note: html-to-text may produce newlines between label and value (table layout),
// so \s+ covers both inline spaces and newlines.

const RE_MONTO = /Monto\s+\$([\d.,]+)/;
const RE_COMERCIO = /Comercio\s+([\s\S]+?)(?:\s{2,}|\n|Fecha)/;
const RE_FECHA = /Fecha de la transacci[óo]n\s+(\d{2}\/\d{2}\/\d{4})/;
const RE_METODO_PAGO = /[Mm][ée]todo de pago\s+\*(\d{4})/;

/**
 * Build the Gmail search query for RappiCard transaction emails in a given month.
 */
function buildQuery(month: string): string {
  const [yearStr, monthStr] = month.split("-");
  const year = parseInt(yearStr, 10);
  const m = parseInt(monthStr, 10);

  const afterDate = `${year}/${String(m).padStart(2, "0")}/01`;

  // Next month
  let nextYear = year;
  let nextMonth = m + 1;
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear += 1;
  }
  const beforeDate = `${nextYear}/${String(nextMonth).padStart(2, "0")}/01`;

  return `from:(noreply@rappicard.co) subject:("Resumen de transacción") after:${afterDate} before:${beforeDate}`;
}

/**
 * Parse a RappiCard email body into candidate transactions.
 * Returns [] for non-transactional emails (extracto, marketing).
 */
function parse(email: ParsedEmail): CandidateTransaction[] {
  const text = email.bodyText;

  // Discard emails without "Monto" field (extracto mensual, marketing)
  const montoMatch = text.match(RE_MONTO);
  if (!montoMatch) return [];

  const amount = parseCopAmount(montoMatch[1]);
  if (!amount || amount <= 0 || isNaN(amount)) return [];

  // Extract merchant (Comercio)
  const comercioMatch = text.match(RE_COMERCIO);
  const merchant = comercioMatch ? comercioMatch[1].trim() : null;

  // Extract date — fallback to internalDate in America/Bogota
  const fechaMatch = text.match(RE_FECHA);
  let txDate: string;
  if (fechaMatch) {
    txDate = normalizeDate(fechaMatch[1]);
  } else {
    txDate = internalDateToLocal(email.internalDate);
  }

  // Extract card last 4 digits (pattern: Método de pago *NNNN)
  const cardMatch = text.match(RE_METODO_PAGO);
  const card_last4 = cardMatch ? cardMatch[1] : null;

  return [
    {
      amount_native: amount,
      native_currency: "COP",
      merchant,
      tx_date: txDate,
      description_raw: text.trim().slice(0, 200),
      account_name: "Rappi",
      source: "sync_gmail_rappicard",
      card_last4,
    },
  ];
}

export const rappicardDef: GmailSourceDef = {
  id: "rappicard",
  syncSource: "sync_gmail_rappicard",
  accountName: "Rappi",
  closeItemSource: null,
  buildQuery,
  parse,
};
