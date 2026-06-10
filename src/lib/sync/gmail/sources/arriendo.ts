import type { GmailSourceDef, ParsedEmail } from "../types";
import type { CandidateTransaction } from "../../types";
import { parseCopAmount, normalizeDate } from "../money";

// --- Extraction regexes ---

const RE_ESTADO = /Estado\s+(.+?)(?:\n|$)/;
const RE_VALOR_TOTAL = /Valor total\s+\$\s*([\d.,]+)/;
const RE_FECHA = /Fecha:\s*(\d{2}\/\d{2}\/\d{4})/;
const RE_DESCRIPCION = /Descripci[óo]n del pago[:\s]*(.+?)(?:\n|$)/;
const RE_REFERENCIA = /N\. referencia[:\s]*(\S+)/;

/**
 * Build the Gmail search query for Arriendo (Palomma) emails in a given month.
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

  return `from:(info@palomma.com) subject:("Confirmación de Pago") after:${afterDate} before:${beforeDate}`;
}

/**
 * Parse a Palomma arriendo payment confirmation email into candidate transactions.
 * Returns [] if Estado is not "Aprobado", amount is not parseable, or date is missing.
 */
function parse(email: ParsedEmail): CandidateTransaction[] {
  const text = email.bodyText;

  // Only emit candidate if Estado is "Aprobado"
  const estadoMatch = text.match(RE_ESTADO);
  if (!estadoMatch || estadoMatch[1].trim() !== "Aprobado") return [];

  // Extract valor total
  const valorMatch = text.match(RE_VALOR_TOTAL);
  if (!valorMatch) return [];

  const amount = parseCopAmount(valorMatch[1]);
  if (!amount || amount <= 0 || isNaN(amount)) return [];

  // Extract date
  const fechaMatch = text.match(RE_FECHA);
  if (!fechaMatch) return [];

  const txDate = normalizeDate(fechaMatch[1]);

  // Extract description + reference for description_raw
  const descMatch = text.match(RE_DESCRIPCION);
  const refMatch = text.match(RE_REFERENCIA);

  const description = descMatch ? descMatch[1].trim() : "";
  const reference = refMatch ? refMatch[1].trim() : "";

  const descriptionRaw = reference
    ? `${description} · Ref: ${reference}`
    : description;

  return [
    {
      amount_native: amount,
      native_currency: "COP",
      merchant: "Arriendo",
      tx_date: txDate,
      description_raw: descriptionRaw,
      account_name: "Bancolombia Ahorros",
      source: "sync_gmail_arriendo",
      expense_type: "fixed",
    },
  ];
}

export const arriendoDef: GmailSourceDef = {
  id: "arriendo",
  syncSource: "sync_gmail_arriendo",
  accountName: "Bancolombia Ahorros",
  closeItemSource: "Arriendo",
  requiresResults: true,
  buildQuery,
  parse,
};
