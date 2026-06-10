/**
 * Fuzzy merchant matcher for expense sync deduplication.
 * Pure functions — no I/O, no side effects.
 */

/** Corporate suffixes to remove during normalization */
const CORPORATE_SUFFIXES = [
  "S\\.A\\.S\\.",
  "S\\.A\\.",
  "S\\.L\\.",
  "SAS",
  "SA",
  "LTDA",
  "COL",
];

// Build a regex that matches any suffix at the end (as whole word)
const SUFFIX_REGEX = new RegExp(
  `\\b(${CORPORATE_SUFFIXES.join("|")})\\b`,
  "g"
);

/**
 * Normaliza un nombre de comercio para comparación.
 * Transformaciones (en orden):
 * 1. Uppercase
 * 2. Eliminar sufijos corporativos (SA, SAS, S.A., S.A.S., LTDA, COL, S.L.)
 * 3. Eliminar caracteres no alfanuméricos (excepto espacios)
 * 4. Colapsar espacios múltiples
 * 5. Trim
 */
export function normalizeMerchant(raw: string | null): string {
  if (raw == null) return "";

  let result = raw.toUpperCase();
  result = result.replace(SUFFIX_REGEX, "");
  result = result.replace(/[^A-Z0-9\s]/g, "");
  result = result.replace(/\s+/g, " ");
  result = result.trim();

  return result;
}

/**
 * Computes the Levenshtein distance between two strings.
 * Simple implementation — not optimized for large strings.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Early exits
  if (m === 0) return n;
  if (n === 0) return m;

  // Use a single-row DP approach for memory efficiency
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // insertion
        prev[j] + 1, // deletion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

/**
 * Compara dos merchants normalizados.
 * Returns: "match" | "no_match" | "ambiguous"
 *
 * Reglas:
 * - Iguales → match
 * - Uno es prefijo del otro → match (truncamiento)
 * - Token containment: tokens(corto) ⊆ tokens(largo) → match
 * - Diferencia <= 3 chars (Levenshtein) → ambiguous
 * - Diferencia > 3 chars sin relación de prefijo → no_match
 */
export function compareMerchants(
  a: string | null,
  b: string | null
): "match" | "no_match" | "ambiguous" {
  const normA = normalizeMerchant(a);
  const normB = normalizeMerchant(b);

  // Both empty → match
  if (normA === "" && normB === "") return "match";

  // One empty, other not → no_match
  if (normA === "" || normB === "") return "no_match";

  // Exact match
  if (normA === normB) return "match";

  // Prefix check — one is prefix of the other (truncation tolerance)
  if (normA.startsWith(normB) || normB.startsWith(normA)) return "match";

  // Token containment — all tokens of the shorter string are contained in the longer one
  // Also allows prefix-matching of individual tokens (handles API truncation like "DATI" ≈ "DATING")
  const tokensA = normA.split(" ").filter((t) => t.length > 0);
  const tokensB = normB.split(" ").filter((t) => t.length > 0);
  const [shorter, longer] =
    tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];

  if (shorter.length > 0) {
    // Strict containment: every token in shorter exists exactly in longer
    if (shorter.every((t) => longer.includes(t))) return "match";

    // Prefix token containment: every token in shorter is a prefix of (or matches) some token in longer
    // (handles truncation: "DATI" matches "DATING", "PERGAMINO" matches "PERGAMINO")
    const prefixMatch = shorter.every((shortToken) =>
      longer.some((longToken) =>
        longToken.startsWith(shortToken) || shortToken.startsWith(longToken)
      )
    );
    if (prefixMatch) return "match";
  }

  // Levenshtein distance
  const distance = levenshtein(normA, normB);
  if (distance <= 3) return "ambiguous";

  return "no_match";
}
