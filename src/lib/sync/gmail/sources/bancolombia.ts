import type { GmailSourceDef, ParsedEmail } from "../types";
import type { CandidateTransaction } from "../../types";
import { parseCopAmount, normalizeDate } from "../money";

/**
 * The debit card and the savings account are the same Bancolombia account: this
 * source used to write to a separate "Bancolombia Débito", which split the same
 * account across two rows depending on which source saw the purchase (push
 * ingest and the arriendo source already wrote to savings). The duplicate was
 * merged; everything Bancolombia lands here.
 */
const ACCOUNT_NAME = "Bancolombia Ahorros";

// --- Classification regexes (ordered most-specific first) ---

/**
 * `\s+` y no un espacio literal: el `text/plain` de Bancolombia viene cortado a
 * 72 columnas, y `bodyText` prefiere esa parte antes que el HTML. Con espacios
 * literales la frase no matcheaba cuando el corte caía justo en el medio
 * ("recibiste una\ntransferencia"), que es lo que pasaba con todos los ingresos.
 */
const RE_INGRESO = /recibiste\s+(una\s+transferencia|un\s+pago)/i;
const RE_COMPRA = /compraste\s+\$[\d.,]+\s+en/i;
const RE_PAGO_SERVICIO = /pagaste\s+\$[\d.,]+\s+a[\s\S]+?desde\s+tu\s+producto/i;
const RE_QR = /pagaste[\s\S]*?por\s+codigo\s+QR/i;
const RE_BREB_LLAVE = /transferiste\s+\$[\d.,]+\s+a\s+la\s+llave/i;
const RE_BOTON = /transferiste\s+\$[\d.,]+\s+por\s+Boton\s+Bancolombia/i;
const RE_TRANSFERENCIA = /transferiste\s+\$[\d.,]+\s+desde\s+tu\s+cuenta/i;

// --- Extraction regexes ---

const RE_AMOUNT = /\$([\d.,]+)/;
const RE_DATE = /(\d{2}\/\d{2}\/\d{2,4})/;
const RE_CARD_LAST4 = /\*(\d{4})/;

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
    const m = text.match(/compraste\s+\$[\d.,]+\s+en\s+([\s\S]+?)\s+con\s+tu/i);
    merchant = m ? m[1].replace(/\s+/g, " ").trim() : null;
  } else if (RE_PAGO_SERVICIO.test(text)) {
    // "Pagaste $X a BENEFICIARIO desde tu producto NNNN el DD/MM/YYYY"
    const m = text.match(/pagaste\s+\$[\d.,]+\s+a\s+([\s\S]+?)\s+desde\s+tu\s+producto/i);
    merchant = m ? m[1].replace(/\s+/g, " ").trim() : null;
  } else if (RE_QR.test(text)) {
    // "pagaste $X por codigo QR desde tu cuenta *NNNN a la llave NNNN el DD/MM/YYYY"
    // Llave numérica → no merchant name
    merchant = null;
  } else if (RE_BOTON.test(text)) {
    // "Transferiste $X por Boton Bancolombia a DESTINATARIO desde producto *NNNN. DD/MM/YYYY"
    const m = text.match(
      /transferiste\s+\$[\d.,]+\s+por\s+Boton\s+Bancolombia\s+a\s+([\s\S]+?)\s+desde\s+producto/i
    );
    merchant = m ? m[1].replace(/\s+/g, " ").trim() : null;
  } else if (RE_BREB_LLAVE.test(text)) {
    // "transferiste $X a la llave @user desde tu cuenta *NNNN a NOMBRE el DD/MM/YY"
    const m = text.match(
      /transferiste\s+\$[\d.,]+\s+a\s+la\s+llave\s+\S+\s+desde\s+tu\s+cuenta\s+\*\d+\s+a\s+([\s\S]+?)\s+el/i
    );
    merchant = m ? m[1].replace(/\s+/g, " ").trim() : null;
  } else if (RE_TRANSFERENCIA.test(text)) {
    // "Transferiste $X desde tu cuenta *NNNN a la cuenta *NNNN el DD/MM/YYYY"
    const m = text.match(/a\s+la\s+cuenta\s+\*(\d+)/i);
    merchant = m ? `Cuenta *${m[1]}` : null;
  } else {
    // No recognized pattern → not a transaction we can parse
    return [];
  }

  // Extract card last 4 digits (pattern: *NNNN)
  const cardMatch = text.match(RE_CARD_LAST4);
  const card_last4 = cardMatch ? cardMatch[1] : null;

  // Build a clean description_raw: just the transactional sentence
  const sentenceMatch = text.match(
    /(?:Bancolombia:\s*)?(?:Compraste|[Pp]agaste|[Tt]ransferiste|recibiste)\s+\$[\d.,]+[\s\S]*?(?:\d{2}\/\d{2}\/\d{2,4})(?:\s+a\s+las\s+\d{2}:\d{2}(?::\d{2})?)?\.?/
  );
  const descriptionRaw = sentenceMatch
    ? sentenceMatch[0].replace(/\s+/g, " ").trim()
    : text.slice(0, 200);

  return [
    {
      amount_native: amount,
      native_currency: "COP",
      merchant,
      tx_date: txDate,
      description_raw: descriptionRaw,
      account_name: ACCOUNT_NAME,
      source: "sync_gmail_bancolombia",
      card_last4,
    },
  ];
}

export const bancolombiaDef: GmailSourceDef = {
  id: "bancolombia",
  syncSource: "sync_gmail_bancolombia",
  accountName: ACCOUNT_NAME,
  closeItemSource: "Bancolombia",
  buildQuery,
  parse,
};
