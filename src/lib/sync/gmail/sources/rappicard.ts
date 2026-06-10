import type { GmailSourceDef, ParsedEmail } from "../types";
import type { CandidateTransaction } from "../../types";
import { parseCopAmount, normalizeDate } from "../money";

// --- Extraction regexes ---
// Note: html-to-text may produce newlines between label and value (table layout),
// so \s+ covers both inline spaces and newlines.

const RE_MONTO = /Monto\s+\$([\d.,]+)/;
const RE_COMERCIO = /Comercio\s+([\s\S]+?)(?:\s{2,}|\n|Fecha)/;
const RE_FECHA = /Fecha de la transacci[óo]n\s+(\d{2}\/\d{2}\/\d{4})/;

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
 * Convert epoch ms internalDate to YYYY-MM-DD in America/Bogota (UTC-5).
 */
function internalDateToLocal(epochMs: string): string {
  const ms = parseInt(epochMs, 10);
  // America/Bogota is UTC-5 (no DST)
  const offsetMs = 5 * 60 * 60 * 1000;
  const local = new Date(ms - offsetMs);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
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

  return [
    {
      amount_native: amount,
      native_currency: "COP",
      merchant,
      tx_date: txDate,
      description_raw: text.trim().slice(0, 200),
      account_name: "RappiCard",
      source: "sync_gmail_rappicard",
    },
  ];
}

export const rappicardDef: GmailSourceDef = {
  id: "rappicard",
  syncSource: "sync_gmail_rappicard",
  accountName: "RappiCard",
  closeItemSource: null,
  buildQuery,
  parse,
};
