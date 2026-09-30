/**
 * Merchant identity for reconciliation.
 *
 * The same purchase reaches us phrased differently by each notifier, and some
 * rows were stored without a merchant at all (the AI fallback returned null for
 * Google Wallet's "IKEA ENVIGADO: 77.100 COP con Tarjeta Visa ••3679"). Two
 * rows can only be proven to be the same purchase if both have a merchant, so
 * this recovers it from the raw text before comparing.
 */

import { compareMerchants, normalizeMerchant } from "../sync/fuzzy-matcher";

/**
 * Where each notifier puts the merchant in `description_raw`, most specific
 * first. Every pattern is a format observed in push_raw_log / transactions.
 */
const MERCHANT_IN_TEXT: readonly RegExp[] = [
  // RappiCard: "Tu compra en OCTAVA MARAVILLA MIRADOR por $ 216.333 fue exitosa"
  /tu compra en (.+?) por \$/i,
  // Nexo Card: "Pago de 3900.00 COP (€1.05) en IKEA ENVIGADO. Cashback en cripto: …"
  /pago de [\d.,]+ \S+ \([^)]*\) en (.+?)\.?\s*(?:cashback|$)/i,
  // Google Wallet as stored by the AI fallback: "IKEA ENVIGADO: 77.100 COP con Tarjeta Visa ••3679"
  /^(.+?):\s*[-−]?\s*[\d.,]+\s*(?:[A-Z]{3}|US\$)\s+(?:con|en)\s/i,
  // Google Wallet as stored by its parser: "IKEA ENVIGADO - COP7,525.00 con …" / "X - Se ha reembolsado …"
  /^(.+?) - /,
];

/** The row's merchant, or the one embedded in its raw text. Null when neither exists. */
export function effectiveMerchant(merchant: string | null, descriptionRaw: string | null): string | null {
  const stored = merchant?.trim();
  if (stored) return stored;
  if (!descriptionRaw) return null;

  for (const pattern of MERCHANT_IN_TEXT) {
    const match = descriptionRaw.match(pattern);
    const found = match?.[1]?.trim();
    if (found) return found;
  }
  return null;
}

/**
 * Ride-hailing providers that pre-authorize a charge and release it later.
 * Each provider bills under several descriptors, and the charge and its release
 * rarely use the same one ("Uber" on RappiCard vs "UBR* PENDING.UBER.COM" on
 * Google Wallet), so they are compared by provider, not by name.
 */
const PROVIDERS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: "uber", pattern: /\bUBER\b|\bUBR\s*\*|UBER\.COM/i },
  { id: "didi", pattern: /\bDIDI\b|\bDLO\s*\*?\s*DIDI/i },
];

/** The pre-authorizing provider behind a merchant descriptor, if any. */
export function providerOf(merchant: string | null): string | null {
  if (!merchant) return null;
  return PROVIDERS.find((p) => p.pattern.test(merchant))?.id ?? null;
}

/**
 * True when two merchant descriptors name the same business: same provider, or
 * the same normalized name allowing for truncation ("PERGAMINO VIVA ENVIG" vs
 * "PERGAMINO VIVA ENVIGADO"). Unknown merchants never match — a guess here
 * would hide a real purchase.
 */
export function merchantsEquivalent(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (normalizeMerchant(a) === "" || normalizeMerchant(b) === "") return false;

  const providerA = providerOf(a);
  const providerB = providerOf(b);
  if (providerA || providerB) return providerA === providerB;

  return compareMerchants(a, b) === "match";
}
