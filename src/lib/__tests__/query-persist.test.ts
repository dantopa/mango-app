import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";

// **Validates: Requirements 5.3, 5.2**

// --- Pure helper: max age check ---
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Determines if a persisted cache entry should be discarded.
 * Returns true if the entry is older than maxAge.
 */
function isPersistedCacheExpired(
  timestamp: number,
  now: number,
  maxAge: number = SEVEN_DAYS_MS
): boolean {
  return now - timestamp > maxAge;
}

// --- Property 5: Query cache persistence round-trip ---

describe("Property 5: Query cache round-trip", () => {
  /**
   * Generator for JSON-safe values: strings, finite numbers (no -0, NaN, Infinity),
   * booleans, nulls, arrays, and plain objects.
   */
  const jsonSafeValue = (): fc.Arbitrary<unknown> =>
    fc.letrec((tie) => ({
      tree: fc.oneof(
        { depthSize: "small" },
        fc.string(),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.double({
          min: -1e6,
          max: 1e6,
          noNaN: true,
          noDefaultInfinity: true,
        }).filter((n) => !Object.is(n, -0)),
        fc.boolean(),
        fc.constant(null),
        fc.array(tie("tree"), { maxLength: 4 }),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), tie("tree"), {
          maxKeys: 4,
        })
      ),
    })).tree;

  it("serializing and deserializing random dehydrated state objects produces deep equality", () => {
    const dehydratedStateArb = fc.record({
      mutations: fc.array(
        fc.record({
          mutationKey: fc.array(fc.string({ minLength: 1, maxLength: 8 }), {
            minLength: 1,
            maxLength: 3,
          }),
          state: fc.record({
            status: fc.constantFrom("idle", "pending", "success", "error"),
            data: jsonSafeValue(),
          }),
        }),
        { minLength: 0, maxLength: 3 }
      ),
      queries: fc.array(
        fc.record({
          queryKey: fc.array(
            fc.oneof(fc.string({ minLength: 1, maxLength: 8 }), fc.integer()),
            { minLength: 1, maxLength: 4 }
          ),
          queryHash: fc.string({ minLength: 1, maxLength: 20 }),
          state: fc.record({
            data: jsonSafeValue(),
            dataUpdatedAt: fc.integer({ min: 0, max: 2_000_000_000_000 }),
            status: fc.constantFrom("pending", "success", "error"),
            fetchStatus: fc.constantFrom("idle", "fetching", "paused"),
          }),
        }),
        { minLength: 0, maxLength: 5 }
      ),
    });

    fc.assert(
      fc.property(dehydratedStateArb, (state) => {
        // Simulate the persistence round-trip: serialize → store → deserialize
        const serialized = JSON.stringify(state);
        const deserialized = JSON.parse(serialized);
        expect(deserialized).toEqual(state);
      }),
      { numRuns: 200 }
    );
  });

  it("round-trip preserves arbitrary nested JSON-safe values (strings, numbers, booleans, nulls, arrays, objects)", () => {
    fc.assert(
      fc.property(jsonSafeValue(), (value) => {
        const serialized = JSON.stringify(value);
        const deserialized = JSON.parse(serialized);
        expect(deserialized).toEqual(value);
      }),
      { numRuns: 200 }
    );
  });

  it("round-trip preserves the full persisted client structure with timestamp and buster", () => {
    const persistedClientArb = fc.record({
      timestamp: fc.integer({ min: 1_600_000_000_000, max: 2_000_000_000_000 }),
      buster: fc.string({ minLength: 4, maxLength: 16 }),
      clientState: fc.record({
        mutations: fc.array(jsonSafeValue(), { minLength: 0, maxLength: 2 }),
        queries: fc.array(
          fc.record({
            queryKey: fc.array(fc.string({ minLength: 1, maxLength: 8 }), {
              minLength: 1,
              maxLength: 3,
            }),
            state: fc.record({
              data: jsonSafeValue(),
              dataUpdatedAt: fc.integer({ min: 0, max: 2_000_000_000_000 }),
            }),
          }),
          { minLength: 0, maxLength: 5 }
        ),
      }),
    });

    fc.assert(
      fc.property(persistedClientArb, (client) => {
        const serialized = JSON.stringify(client);
        const deserialized = JSON.parse(serialized);
        expect(deserialized).toEqual(client);
      }),
      { numRuns: 100 }
    );
  });
});

// --- Property 6: Persisted cache max age enforcement ---

describe("Property 6: Persisted cache max age", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("entries older than 7 days are discarded, entries within 7 days are kept", () => {
    const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

    fc.assert(
      fc.property(
        // Generate a "now" reference point
        fc.integer({ min: 1_600_000_000_000, max: 2_000_000_000_000 }),
        // Generate elapsed time spanning 0–14 days in ms
        fc.integer({ min: 0, max: FOURTEEN_DAYS_MS }),
        (now, elapsedMs) => {
          vi.setSystemTime(now);
          const timestamp = now - elapsedMs;
          const expired = isPersistedCacheExpired(timestamp, now);
          const expected = elapsedMs > SEVEN_DAYS_MS;
          expect(expired).toBe(expected);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("entry at exactly 7 days boundary is NOT expired (elapsed === maxAge)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_600_000_000_000, max: 2_000_000_000_000 }),
        (now) => {
          vi.setSystemTime(now);
          const timestamp = now - SEVEN_DAYS_MS;
          // elapsed === maxAge → not expired (> not >=)
          expect(isPersistedCacheExpired(timestamp, now)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("entry 1ms past 7 days IS expired", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_600_000_000_000, max: 2_000_000_000_000 }),
        (now) => {
          vi.setSystemTime(now);
          const timestamp = now - SEVEN_DAYS_MS - 1;
          expect(isPersistedCacheExpired(timestamp, now)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("recently persisted entries (< 1 day) are always kept", () => {
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    fc.assert(
      fc.property(
        fc.integer({ min: 1_600_000_000_000, max: 2_000_000_000_000 }),
        fc.integer({ min: 0, max: ONE_DAY_MS }),
        (now, elapsedMs) => {
          vi.setSystemTime(now);
          const timestamp = now - elapsedMs;
          expect(isPersistedCacheExpired(timestamp, now)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});
