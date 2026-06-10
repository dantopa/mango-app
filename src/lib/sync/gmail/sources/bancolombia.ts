import type { GmailSourceDef, ParsedEmail } from "../types";
import type { CandidateTransaction } from "../../types";
import { parseCopAmount, normalizeDate } from "../money";

// --- Classification regexes (ordered most-specific first) ---

const RE_INGRESO = /(recibiste una transferencia|recibiste un pago)/i;
const RE_COMPRA = /compraste \$[\d.,]+ en/i;
const RE_PAGO_SERVICIO = /pagaste \$[\d.,]+ a .+ desde tu producto/i;
const RE_QR = /pagaste .* por codigo QR/i;
const RE_BREB_LLAVE = /transferiste \$[\d.,]+ a la llave/i;
const RE_BOTON = /transferiste \$[\d.,]+ por Boton Bancolombia/i;
const RE_TRANSFERENCIA = /transferiste \$[\d.,]+ desde tu cuenta/i;

// --- Extraction regexes ---

const RE_AMOUNT = /\$([\d.,]+)/;
const RE_DATE = /(\d{2}\/\d{2}\/\d{2,4})/;

/**
 * Build the Gmail search query for Bancolombia emails in a given month.
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

  return `from:(an.notificacionesbancolombia.com) after:${afterDate} before:${beforeDate}`;
}

/**
 * Parse a Bancolombia email body into candidate transactions.
 * Returns [] for non-transactional emails, ingresos, or when data extraction fails.
 */
function parse(email: ParsedEmail): CandidateTransaction[] {
  const text = email.bodyText;

  // Skip ingresos (income, not an expense)
  if (RE_INGRESO.test(text)) {
    return [];
  }

  // Extract amount
  const amountMatch = text.match(RE_AMOUNT);
  if (!amountMatch) return [];

  const amount = parseCopAmount(amountMatch[1]);
  if (!amount || amount <= 0 || isNaN(amount)) return [];

  // Extract date
  const dateMatch = text.match(RE_DATE);
  if (!dateMatch) return [];

  const txDate = normalizeDate(dateMatch[1]);

  // Determine merchant by variant
  let merchant: string | null = null;

  if (RE_COMPRA.test(text)) {
    // "Compraste $X en MERCHANT con tu T.Deb/T.Cred *NNNN, el DD/MM/YYYY"
    const m = text.match(/compraste \$[\d.,]+ en (.+?) con tu/i);
    merchant = m ? m[1].trim() : null;
  } else if (RE_PAGO_SERVICIO.test(text)) {
    // "Pagaste $X a BENEFICIARIO desde tu producto NNNN el DD/MM/YYYY"
    const m = text.match(/pagaste \$[\d.,]+ a (.+?) desde tu producto/i);
    merchant = m ? m[1].trim() : null;
  } else if (RE_QR.test(text)) {
    // "pagaste $X por codigo QR desde tu cuenta *NNNN a la llave NNNN el DD/MM/YYYY"
    // Llave numérica → no merchant name
    merchant = null;
  } else if (RE_BOTON.test(text)) {
    // "Transferiste $X por Boton Bancolombia a DESTINATARIO desde producto *NNNN. DD/MM/YYYY"
    const m = text.match(
      /transferiste \$[\d.,]+ por Boton Bancolombia a (.+?) desde producto/i
    );
    merchant = m ? m[1].trim() : null;
  } else if (RE_BREB_LLAVE.test(text)) {
    // "transferiste $X a la llave @user desde tu cuenta *NNNN a NOMBRE el DD/MM/YY"
    const m = text.match(
      /transferiste \$[\d.,]+ a la llave \S+ desde tu cuenta \*\d+ a (.+?) el/i
    );
    merchant = m ? m[1].trim() : null;
  } else if (RE_TRANSFERENCIA.test(text)) {
    // "Transferiste $X desde tu cuenta *NNNN a la cuenta *NNNN el DD/MM/YYYY"
    const m = text.match(/a la cuenta \*(\d+)/i);
    merchant = m ? `Cuenta *${m[1]}` : null;
  } else {
    // No recognized pattern → not a transaction we can parse
    return [];
  }

  return [
    {
      amount_native: amount,
      native_currency: "COP",
      merchant,
      tx_date: txDate,
      description_raw: text.trim(),
      account_name: "Bancolombia",
      source: "sync_gmail_bancolombia",
    },
  ];
}

export const bancolombiaDef: GmailSourceDef = {
  id: "bancolombia",
  syncSource: "sync_gmail_bancolombia",
  accountName: "Bancolombia",
  closeItemSource: "Bancolombia",
  buildQuery,
  parse,
};
