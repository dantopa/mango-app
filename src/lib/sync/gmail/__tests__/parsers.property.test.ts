import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { createHash } from "crypto";
import { bancolombiaDef } from "../sources/bancolombia";
import { rappicardDef } from "../sources/rappicard";
import { arriendoDef } from "../sources/arriendo";
import { parseCopAmount, normalizeDate } from "../money";
import type { ParsedEmail } from "../types";

// --- Local helper for Property 4 (gmailDedupKey doesn't exist yet — task 3.2) ---
function gmailDedupKey(messageId: string): string {
  return createHash("sha256")
    .update(`gmail|${messageId}`)
    .digest("hex")
    .slice(0, 32);
}

// --- Helpers ---

function makeParsedEmail(bodyText: string): ParsedEmail {
  return {
    messageId: "test-msg-id",
    internalDate: "1717700000000",
    subject: "Test Subject",
    bodyText,
  };
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// --- Property 1: Parsers are total and honest ---
// **Validates: Requirements 3.6, 3.7**

describe("Property 1: Parsers are total and honest", () => {
  const parsers = [
    { name: "bancolombiaDef", def: bancolombiaDef },
    { name: "rappicardDef", def: rappicardDef },
    { name: "arriendoDef", def: arriendoDef },
  ];

  for (const { name, def } of parsers) {
    describe(name, () => {
      it("never throws for arbitrary input strings", () => {
        fc.assert(
          fc.property(fc.string(), (input) => {
            const email = makeParsedEmail(input);
            // Must not throw
            const result = def.parse(email);
            expect(Array.isArray(result)).toBe(true);
          }),
          { numRuns: 200 }
        );
      });

      it("every returned candidate has amount_native > 0, valid tx_date, and non-empty native_currency", () => {
        fc.assert(
          fc.property(fc.string(), (input) => {
            const email = makeParsedEmail(input);
            const result = def.parse(email);

            for (const candidate of result) {
              // amount_native > 0 and not NaN
              expect(candidate.amount_native).toBeGreaterThan(0);
              expect(Number.isNaN(candidate.amount_native)).toBe(false);

              // tx_date matches ISO date pattern
              expect(candidate.tx_date).toMatch(ISO_DATE_RE);

              // native_currency is non-empty
              expect(candidate.native_currency.length).toBeGreaterThan(0);
            }
          }),
          { numRuns: 200 }
        );
      });
    });
  }
});

// --- Property 2: COP amount round-trip ---
// **Validates: Requirements 3.6**

describe("Property 2: COP amount round-trip", () => {
  it("parseCopAmount(String(n)) === n for any positive integer", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 999_999_999 }),
        (n) => {
          expect(parseCopAmount(String(n))).toBe(n);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("parseCopAmount never returns NaN for inputs matching /[\\d.,]+/", () => {
    // Generate strings that look like COP amounts (digits with dots/commas)
    const copAmountArb = fc
      .tuple(
        fc.array(fc.integer({ min: 1, max: 999 }), { minLength: 1, maxLength: 4 }),
        fc.boolean() // whether to include comma + decimals
      )
      .map(([parts, hasDecimals]) => {
        const intPart = parts.join(".");
        if (hasDecimals) {
          const decimals = String(parts[0] % 100).padStart(2, "0");
          return `${intPart},${decimals}`;
        }
        return intPart;
      });

    fc.assert(
      fc.property(copAmountArb, (input) => {
        const result = parseCopAmount(input);
        expect(Number.isNaN(result)).toBe(false);
      }),
      { numRuns: 200 }
    );
  });
});

// --- Property 3: Date normalization ---
// **Validates: Requirements 3.7**

describe("Property 3: Date normalization", () => {
  // Generate valid dates with day 1-28, month 1-12, year 2020-2030
  const validDateArb = fc.tuple(
    fc.integer({ min: 1, max: 28 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 2020, max: 2030 })
  );

  it("normalizeDate(DD/MM/YY) === normalizeDate(DD/MM/YYYY) for any valid date", () => {
    fc.assert(
      fc.property(validDateArb, ([day, month, year]) => {
        const dd = String(day).padStart(2, "0");
        const mm = String(month).padStart(2, "0");
        const yy = String(year).slice(2); // last 2 digits
        const yyyy = String(year);

        const twoDigit = normalizeDate(`${dd}/${mm}/${yy}`);
        const fourDigit = normalizeDate(`${dd}/${mm}/${yyyy}`);

        expect(twoDigit).toBe(fourDigit);
      }),
      { numRuns: 200 }
    );
  });

  it("result is always a valid ISO date matching /^\\d{4}-\\d{2}-\\d{2}$/", () => {
    fc.assert(
      fc.property(validDateArb, ([day, month, year]) => {
        const dd = String(day).padStart(2, "0");
        const mm = String(month).padStart(2, "0");
        const yyyy = String(year);

        const result = normalizeDate(`${dd}/${mm}/${yyyy}`);
        expect(result).toMatch(ISO_DATE_RE);
      }),
      { numRuns: 200 }
    );
  });

  it("result is parseable by new Date() without NaN", () => {
    fc.assert(
      fc.property(validDateArb, ([day, month, year]) => {
        const dd = String(day).padStart(2, "0");
        const mm = String(month).padStart(2, "0");
        const yyyy = String(year);

        const result = normalizeDate(`${dd}/${mm}/${yyyy}`);
        const parsed = new Date(result);
        expect(Number.isNaN(parsed.getTime())).toBe(false);
      }),
      { numRuns: 200 }
    );
  });
});

// --- Property 4: Dedup key determinism ---
// **Validates: Requirements 6.1**

describe("Property 4: Dedup key determinism", () => {
  it("gmailDedupKey is deterministic (same input → same output)", () => {
    fc.assert(
      fc.property(fc.string(), (id) => {
        const result1 = gmailDedupKey(id);
        const result2 = gmailDedupKey(id);
        expect(result1).toBe(result2);
      }),
      { numRuns: 200 }
    );
  });

  it("result is exactly 32 hex characters", () => {
    fc.assert(
      fc.property(fc.string(), (id) => {
        const result = gmailDedupKey(id);
        expect(result).toMatch(/^[0-9a-f]{32}$/);
      }),
      { numRuns: 200 }
    );
  });

  it("different inputs produce different outputs (no collisions in 100 random IDs)", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 100, maxLength: 100 }),
        (ids) => {
          const keys = ids.map(gmailDedupKey);
          const unique = new Set(keys);
          expect(unique.size).toBe(ids.length);
        }
      ),
      { numRuns: 10 }
    );
  });
});
