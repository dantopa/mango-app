/**
 * Pattern shaping for `merchant_category_rules`.
 *
 * This lives apart from the categorizers because both halves of the product
 * write rules now: the AI fallback on the server, and a manual re-categorization
 * from the browser. Sharing one file is what keeps the two from drifting into
 * different ideas of what a rule looks like.
 */

/** ILIKE wildcards would silently turn a rule into a catch-all. */
const WILDCARDS = /[%_]/;

const MIN_PATTERN_LENGTH = 4;
const MAX_PATTERN_LENGTH = 60;

/** Collapses runs of whitespace so a pattern joined with single spaces still verifies. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * A pattern is only usable if it was *copied* from the text it will match, not
 * invented. Without this check the AI can propose something that reads well and
 * matches nothing — or, worse, matches everything.
 */
export function isUsablePattern(pattern: string, source: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed.length < MIN_PATTERN_LENGTH || trimmed.length > MAX_PATTERN_LENGTH) {
    return false;
  }
  if (WILDCARDS.test(trimmed)) return false;

  return normalize(source).includes(normalize(trimmed));
}

/**
 * Extract a useful pattern from a Bancolombia-style merchant string.
 * Examples:
 *   "COMPRA EN PERGAMINO VIVA ENVIG" → "PERGAMINO VIVA"
 *   "COMPRA INTL Google Bumble Dati" → "Google Bumble"
 *   "PAGO QR ARES BARBERIA" → "ARES BARBERIA"
 *   "PAGO PSE EMPRESAS PUBLICAS D" → "EMPRESAS PUBLICAS"
 *   "Rappi" → "Rappi"
 *   "Anthropic" → "Anthropic"
 */
export function extractPattern(merchant: string): string | null {
  if (!merchant || merchant.length < 3) return null;

  // Strip common Bancolombia prefixes
  const prefixes = [
    /^COMPRA EN\s+/i,
    /^COMPRA INTL\s+/i,
    /^COMPRA\s+/i,
    /^PAGO QR\s+/i,
    /^PAGO PSE\s+/i,
    /^PAGO\s+/i,
  ];

  let cleaned = merchant;
  for (const prefix of prefixes) {
    cleaned = cleaned.replace(prefix, "");
  }

  // Remove trailing location codes (single uppercase words ≤5 chars at end)
  cleaned = cleaned.replace(/\s+[A-Z]{1,5}$/, "").trim();

  // If cleaned result is too short, use original
  if (cleaned.length < 3) return merchant.trim();

  // Take first 2-3 meaningful words (enough to be distinctive)
  const words = cleaned.split(/\s+/).filter((w) => w.length > 1);
  const pattern = words.slice(0, 3).join(" ");

  return pattern || null;
}
