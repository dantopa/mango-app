/**
 * Converts HTML to normalized plain text.
 * Pure function — no external dependencies.
 *
 * Key behaviors:
 * - Strips script/style blocks entirely
 * - Removes HTML comments
 * - Decodes named + numeric HTML entities (including Spanish accented chars)
 * - Replaces block-level tags with newlines
 * - Adds space separators for <td> (so table cells aren't concatenated)
 * - Strips all remaining tags
 * - Collapses whitespace (multiple spaces → single, multiple newlines → max 2)
 * - Trims result
 */

/** Named HTML entities → decoded character */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  // Spanish accented (lowercase)
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  uuml: "ü",
  // Spanish accented (uppercase)
  Aacute: "Á",
  Eacute: "É",
  Iacute: "Í",
  Oacute: "Ó",
  Uacute: "Ú",
  Ntilde: "Ñ",
  Uuml: "Ü",
  // Other common
  iexcl: "¡",
  iquest: "¿",
  laquo: "«",
  raquo: "»",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  middot: "·",
  bull: "•",
  ldquo: "\u201C",
  rdquo: "\u201D",
  lsquo: "\u2018",
  rsquo: "\u2019",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
};

/**
 * Decode a single HTML entity reference (named, decimal, or hex).
 */
function decodeEntity(match: string, named: string | undefined, decimal: string | undefined, hex: string | undefined): string {
  if (named) {
    return NAMED_ENTITIES[named] ?? match;
  }
  if (decimal) {
    const code = parseInt(decimal, 10);
    return isNaN(code) ? match : String.fromCharCode(code);
  }
  if (hex) {
    const code = parseInt(hex, 16);
    return isNaN(code) ? match : String.fromCharCode(code);
  }
  return match;
}

export function htmlToText(html: string): string {
  let text = html;

  // 1. Remove script/style blocks entirely (including content)
  text = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");

  // 2. Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // 3. Replace block-level closing tags with newlines
  text = text.replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n");

  // 4. Replace <br> with newline
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // 5. Replace </td> with space (so table cells get separation)
  text = text.replace(/<\/td>/gi, " ");

  // 6. Replace opening block-level tags that imply line breaks
  text = text.replace(/<(p|div|tr|li|h[1-6])\b[^>]*>/gi, "\n");

  // 7. Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // 8. Decode HTML entities (named, decimal &#NNN;, hex &#xHHH;)
  text = text.replace(
    /&(?:([a-zA-Z]+)|#(\d+)|#x([0-9a-fA-F]+));/g,
    (match, named, decimal, hex) => decodeEntity(match, named, decimal, hex),
  );

  // 9. Collapse horizontal whitespace (spaces/tabs → single space per line)
  text = text.replace(/[ \t]+/g, " ");

  // 10. Trim each line
  text = text
    .split("\n")
    .map((line) => line.trim())
    .join("\n");

  // 11. Collapse multiple newlines (max 2 consecutive)
  text = text.replace(/\n{3,}/g, "\n\n");

  // 12. Final trim
  return text.trim();
}
