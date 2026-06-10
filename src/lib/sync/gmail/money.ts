/**
 * Shared COP money parsing utilities.
 *
 * Extracted from src/lib/push-ingest/parsers/bancolombia.ts so both
 * the push-notification parser and the Gmail sync parsers can reuse them.
 */

/**
 * Parse COP amounts with 3 variants:
 * 1. Contains `,` → CO format: remove `.` (thousands), change `,`→`.` (e.g. `$7.900,00` → 7900.00)
 * 2. No comma, ends in `.\d{2}` → already decimal (e.g. `$359702.00` → 359702.00)
 * 3. No comma, no decimal → integer, remove `.` (e.g. `$7.900` → 7900)
 */
export function parseCopAmount(raw: string): number {
  if (raw.includes(",")) {
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
