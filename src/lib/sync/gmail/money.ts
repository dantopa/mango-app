/**
 * Shared COP money parsing utilities.
 *
 * Extracted from src/lib/push-ingest/parsers/bancolombia.ts so both
 * the push-notification parser and the Gmail sync parsers can reuse them.
 */

/**
 * Parse COP amounts with multiple format variants:
 * 1. CO format with comma as decimal: dots are thousands, comma has ≤2 digits after
 *    (e.g. `7.500,00` → 7500.00, `7.900` with comma elsewhere)
 * 2. EN format with comma as thousands: comma has 3 digits after, dots are decimal
 *    (e.g. `47,000.00` → 47000.00, `1,900,000.00` → 1900000.00)
 * 3. No comma, ends in .\d{2} → already decimal (e.g. `359702.00` → 359702.00)
 * 4. No comma, no decimal → integer, remove dots (e.g. `7.900` → 7900)
 *
 * Heuristic: if comma is followed by exactly 3 digits (and possibly more ,NNN groups),
 * it's EN thousands. Otherwise it's CO decimal.
 */
export function parseCopAmount(raw: string): number {
  if (raw.includes(",")) {
    // Check if comma is used as thousands separator (EN format):
    // Pattern: ,\d{3} followed by end, dot, or another comma
    const isEnglishFormat = /,\d{3}(?:[.,]|$)/.test(raw);

    if (isEnglishFormat) {
      // EN format: commas are thousands, dot is decimal
      const cleaned = raw.replace(/,/g, "");
      return parseFloat(cleaned);
    }

    // CO format: dots are thousands separators, comma is decimal
    const cleaned = raw.replace(/\./g, "").replace(",", ".");
    return parseFloat(cleaned);
  }

  // No comma — check if ends in .\d{2} (decimal point)
  if (/\.\d{2}$/.test(raw)) {
    return parseFloat(raw);
  }

  // No comma, no decimal ending → integer with dots as thousands
  const cleaned = raw.replace(/\./g, "");
  return parseFloat(cleaned);
}

/**
 * Normalize date string (DD/MM/YY or DD/MM/YYYY) to ISO YYYY-MM-DD.
 */
export function normalizeDate(dateStr: string): string {
  const [day, month, yearRaw] = dateStr.split("/");
  let year = yearRaw;
  if (year.length === 2) {
    // Assume 2000s
    year = `20${year}`;
  }
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}
