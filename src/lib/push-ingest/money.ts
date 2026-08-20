/**
 * Amount and currency parsing for push notifications.
 *
 * Every source writes money differently and the same app mixes locales:
 *   Google Wallet  "COP7,500.00"  (comma thousands, dot decimal)
 *   Google Wallet  "$8.55"        (dot decimal — USD)
 *   BBVA AR        "ARS23.280,00" (dot thousands, comma decimal)
 *   BBVA AR        "USD16,91"     (comma decimal, even for USD)
 *   Rappi/Bancol.  "33.300"       (dot thousands, no decimals)
 *
 * Guessing per-parser is what produced the worst bug in the ingest: "$8.55"
 * was read as 855 because a lone dot was assumed to be a thousands separator,
 * so 111 notifications inflated into ~$267k of phantom expenses. Separator
 * meaning is decided here, once, by digit count — never by locale guessing.
 */

/** Currencies conventionally written without decimals, so a lone separator groups thousands. */
const ZERO_DECIMAL_CURRENCIES = new Set(["COP", "CLP", "PYG", "JPY", "KRW", "VND", "IDR"]);

/** Currency codes the ingest accepts. Anything else is a red flag, not a currency. */
export const KNOWN_CURRENCIES = new Set([
  "USD", "USDT", "COP", "ARS", "EUR", "BRL", "MXN", "CLP", "PEN", "UYU", "GBP",
]);

/** Currency written as a symbol rather than an ISO code. Bare "$" is deliberately absent: ambiguous. */
const SYMBOL_TO_CURRENCY: ReadonlyArray<readonly [RegExp, string]> = [
  [/US\$|U\$S/i, "USD"],
  [/€/, "EUR"],
  [/R\$/, "BRL"],
  [/£/, "GBP"],
];

/**
 * Parses an amount as written in a notification.
 *
 * Separator rules, applied in order:
 *  - both `.` and `,` present → the rightmost one is the decimal separator
 *  - one separator, appearing more than once → thousands ("1.234.567")
 *  - one separator followed by exactly 3 digits → thousands ("33.300")
 *  - one separator followed by 1-2 digits → decimal ("8.55", "16,91"), unless
 *    the currency is written without decimals, where it groups thousands
 *  - anything else (trailing separator, 4+ trailing digits) → null
 *
 * @param currency ISO code used only to disambiguate a single separator.
 * @returns the signed amount, or null if the text is not an unambiguous number.
 */
export function parseAmount(raw: string, currency?: string | null): number | null {
  const negative = /-/.test(raw);
  const cleaned = raw.replace(/[^\d.,]/g, "");
  if (!/\d/.test(cleaned)) return null;

  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");

  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const decimalSep = lastDot > lastComma ? "." : ",";
    const thousandsSep = decimalSep === "." ? "," : ".";
    const withoutThousands = cleaned.split(thousandsSep).join("");
    // A real decimal separator appears exactly once after the grouping is gone.
    if (withoutThousands.split(decimalSep).length !== 2) return null;
    normalized = withoutThousands.replace(decimalSep, ".");
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const parts = cleaned.split(sep);
    const trailing = parts[parts.length - 1];

    // A zero-decimal currency written with a trailing ".00"/",00" (Nexo Card
    // does this for COP) has no cents to disambiguate — drop the redundant
    // zero suffix instead of forcing it through thousands-grouping, which
    // rejects it outright (only 3-digit groups qualify) and silently drops
    // the whole notification.
    if (
      parts.length === 2 &&
      (trailing.length === 1 || trailing.length === 2) &&
      /^0+$/.test(trailing) &&
      currency &&
      ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase())
    ) {
      normalized = parts[0];
      const value = Number(normalized);
      if (!Number.isFinite(value)) return null;
      return negative ? -value : value;
    }

    const groupsThousands =
      parts.length > 2 ||
      trailing.length === 3 ||
      (currency ? ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) : false);

    if (groupsThousands) {
      // Every group but the first must be exactly 3 digits to be a grouping.
      if (parts.slice(1).some((p) => p.length !== 3)) return null;
      normalized = parts.join("");
    } else {
      if (trailing.length < 1 || trailing.length > 2) return null;
      normalized = `${parts[0]}.${trailing}`;
    }
  } else {
    normalized = cleaned;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/**
 * Detects the currency of a notification from an explicit ISO code or symbol.
 * Returns null for a bare "$", which means COP, USD or ARS depending on the
 * card — the caller must resolve it from the account, never assume.
 */
export function detectCurrency(text: string): string | null {
  // No trailing \b: banks write the code glued to the amount ("USD16,91").
  // (?![a-z]) keeps it from matching inside a word ("COPIA").
  const isoMatch = text.match(/\b(USDT|USD|COP|ARS|EUR|BRL|MXN|CLP|PEN|UYU|GBP)(?![a-z])/i);
  if (isoMatch) return isoMatch[1].toUpperCase();

  for (const [pattern, code] of SYMBOL_TO_CURRENCY) {
    if (pattern.test(text)) return code;
  }
  return null;
}

/** True if the code is a currency the ingest knows how to convert and store. */
export function isKnownCurrency(code: string): boolean {
  return KNOWN_CURRENCIES.has(code.toUpperCase());
}
