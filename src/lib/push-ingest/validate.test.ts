import { describe, it, expect } from "vitest";
import { validateParsedTransaction, type ResolvedTransaction } from "./validate";

const TODAY = "2026-08-18";

const valid: ResolvedTransaction = {
  amount_native: 8.55,
  native_currency: "USD",
  merchant: "MANOLO RESTAURANT",
  tx_date: "2026-08-17",
  description_raw: "MANOLO RESTAURANT - $8.55 con Mastercard Nexo Card ••4186",
  account_name: "Nexo Card",
  card_last4: "4186",
};

function errorsOf(overrides: Partial<ResolvedTransaction>, today = TODAY): string[] {
  const result = validateParsedTransaction({ ...valid, ...overrides }, { today });
  return result.ok ? [] : result.errors;
}

describe("validateParsedTransaction", () => {
  it("accepts a well-formed transaction", () => {
    expect(validateParsedTransaction(valid, { today: TODAY })).toEqual({ ok: true });
  });

  it("accepts a refund as a negative amount", () => {
    expect(errorsOf({ amount_native: -124414, native_currency: "COP" })).toEqual([]);
  });

  it("rejects a zero amount — that is a declined purchase, not an expense", () => {
    expect(errorsOf({ amount_native: 0 })).toContain("amount_native is 0");
  });

  it("rejects NaN and absurd amounts", () => {
    expect(errorsOf({ amount_native: Number.NaN })[0]).toContain("not a number");
    expect(errorsOf({ amount_native: 5e9 })[0]).toContain("out of range");
  });

  it("rejects a currency the ingest cannot convert", () => {
    expect(errorsOf({ native_currency: "XYZ" })[0]).toContain("unknown currency");
  });

  it("rejects impossible and malformed dates", () => {
    expect(errorsOf({ tx_date: "2026-02-31" })[0]).toContain("not a valid");
    expect(errorsOf({ tx_date: "17/08/2026" })[0]).toContain("not a valid");
  });

  it("rejects a date outside the accepted window", () => {
    expect(errorsOf({ tx_date: "2026-05-01" })[0]).toContain("days old");
    expect(errorsOf({ tx_date: "2026-09-01" })[0]).toContain("in the future");
  });

  it("tolerates a device clock one day ahead", () => {
    expect(errorsOf({ tx_date: "2026-08-19" })).toEqual([]);
  });

  it("accepts an old date when the window is widened for a reprocess", () => {
    const result = validateParsedTransaction(
      { ...valid, tx_date: "2026-06-11" },
      { today: TODAY, maxPastDays: 3650 },
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects an empty description", () => {
    expect(errorsOf({ description_raw: "   " })[0]).toContain("description_raw is empty");
  });

  it("rejects card digits that are not 4 digits", () => {
    expect(errorsOf({ card_last4: "••4186" })[0]).toContain("not 4 digits");
  });

  it("accepts a missing merchant and a missing card", () => {
    expect(errorsOf({ merchant: null, card_last4: null })).toEqual([]);
  });

  it("reports every problem at once", () => {
    const errors = errorsOf({ amount_native: 0, native_currency: "XYZ", tx_date: "nope" });
    expect(errors).toHaveLength(3);
  });
});
