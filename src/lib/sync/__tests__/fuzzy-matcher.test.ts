import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { compareMerchants, normalizeMerchant } from "../fuzzy-matcher";

// --- Unit tests: Token containment with real cases ---
// **Validates: Requirements 7.8**

describe("compareMerchants — token containment", () => {
  it('"DIDI" vs "DLO Didi" → match', () => {
    expect(compareMerchants("DIDI", "DLO Didi")).toBe("match");
  });

  it('"DLO Didi" vs "DIDI" → match (conmutativo)', () => {
    expect(compareMerchants("DLO Didi", "DIDI")).toBe("match");
  });

  it('"MULTIPLEX" vs "MULTIPLEX VIVA ENVIG" → match', () => {
    expect(compareMerchants("MULTIPLEX", "MULTIPLEX VIVA ENVIG")).toBe("match");
  });

  it('"MULTIPLEX VIVA ENVIG" vs "MULTIPLEX" → match (conmutativo)', () => {
    expect(compareMerchants("MULTIPLEX VIVA ENVIG", "MULTIPLEX")).toBe("match");
  });

  it('"RAPPI" vs "RAPPI TIENDA" → match (token containment)', () => {
    expect(compareMerchants("RAPPI", "RAPPI TIENDA")).toBe("match");
  });

  it('"PQUE ECOLOGICO" vs "PQUE ECOLOGICO PIEDRAS" → match', () => {
    expect(compareMerchants("PQUE ECOLOGICO", "PQUE ECOLOGICO PIEDRAS")).toBe(
      "match"
    );
  });

  it("unrelated merchants → no_match (token containment does not apply)", () => {
    expect(compareMerchants("DIDI", "RAPPI")).toBe("no_match");
  });

  it('"PALOMMA SAS" vs "Arriendo" → no_match', () => {
    expect(compareMerchants("PALOMMA SAS", "Arriendo")).toBe("no_match");
  });
});

// --- Property-based test: Commutativity of compareMerchants ---
// **Validates: Requirements 7.8**

describe("Property 7: Token containment commutativity", () => {
  it("compareMerchants(a, b) === compareMerchants(b, a) for all inputs", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.string({ minLength: 1, maxLength: 30 }),
        (a, b) => {
          expect(compareMerchants(a, b)).toBe(compareMerchants(b, a));
        }
      ),
      { numRuns: 500 }
    );
  });

  it("when tokens(norm(a)) ⊆ tokens(norm(b)) → compareMerchants(a, b) === 'match'", () => {
    // Generate pairs where the shorter is a subset of the longer
    const tokenSubsetArb = fc
      .tuple(
        fc.array(fc.stringMatching(/^[A-Z]{2,8}$/), {
          minLength: 1,
          maxLength: 3,
        }),
        fc.array(fc.stringMatching(/^[A-Z]{2,8}$/), {
          minLength: 1,
          maxLength: 3,
        })
      )
      .map(([base, extra]) => {
        const shorter = base.join(" ");
        const longer = [...base, ...extra].join(" ");
        return [shorter, longer] as const;
      });

    fc.assert(
      fc.property(tokenSubsetArb, ([shorter, longer]) => {
        const result = compareMerchants(shorter, longer);
        expect(result).toBe("match");
      }),
      { numRuns: 300 }
    );
  });

  it("token containment is commutative: result is the same regardless of argument order", () => {
    // Generate merchants where one contains all tokens of the other
    const tokenSubsetArb = fc
      .tuple(
        fc.array(fc.stringMatching(/^[A-Z]{2,8}$/), {
          minLength: 1,
          maxLength: 2,
        }),
        fc.array(fc.stringMatching(/^[A-Z]{2,8}$/), {
          minLength: 1,
          maxLength: 3,
        })
      )
      .map(([base, extra]) => {
        const shorter = base.join(" ");
        const longer = [...base, ...extra].join(" ");
        return [shorter, longer] as const;
      });

    fc.assert(
      fc.property(tokenSubsetArb, ([shorter, longer]) => {
        expect(compareMerchants(shorter, longer)).toBe(
          compareMerchants(longer, shorter)
        );
      }),
      { numRuns: 300 }
    );
  });
});
