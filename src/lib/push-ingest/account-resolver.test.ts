import { describe, it, expect } from "vitest";
import { resolveAccount, type AccountCandidate } from "./account-resolver";

/** The real account list, with the card mapping seeded by the parser-hardening migration. */
const ACCOUNTS: AccountCandidate[] = [
  { id: "a1", name: "Bancolombia Ahorros", native_currency: "COP", card_digits: ["5685"] },
  { id: "a2", name: "Bancolombia CDT", native_currency: "COP", card_digits: [] },
  { id: "a3", name: "BBVA", native_currency: "ARS", card_digits: [] },
  { id: "a4", name: "BBVA Mastercard", native_currency: "ARS", card_digits: ["1886"] },
  { id: "a5", name: "BBVA Visa", native_currency: "ARS", card_digits: ["9253"] },
  { id: "a6", name: "Nexo", native_currency: "USDT", card_digits: [] },
  { id: "a7", name: "Nexo Card", native_currency: "USD", card_digits: ["4186"] },
  { id: "a8", name: "Rappi", native_currency: "COP", card_digits: ["3679"] },
  { id: "a9", name: "Wise Personal", native_currency: "USD", card_digits: ["6928"] },
];

function expectResolved(result: ReturnType<typeof resolveAccount>, name: string, via: "card" | "name") {
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.account.name).toBe(name);
    expect(result.via).toBe(via);
  }
}

describe("resolveAccount", () => {
  it("resolves by card digits, which is the only key the notification guarantees", () => {
    expectResolved(resolveAccount(ACCOUNTS, { cardLast4: "4186" }), "Nexo Card", "card");
    expectResolved(resolveAccount(ACCOUNTS, { cardLast4: "3679" }), "Rappi", "card");
    expectResolved(resolveAccount(ACCOUNTS, { cardLast4: "9253" }), "BBVA Visa", "card");
    expectResolved(resolveAccount(ACCOUNTS, { cardLast4: "6928" }), "Wise Personal", "card");
  });

  it("prefers card digits over a name that would resolve elsewhere", () => {
    // "Signature ••9253" carries no usable name, and the label would not match BBVA Visa.
    expectResolved(
      resolveAccount(ACCOUNTS, { cardLast4: "9253", accountName: "Signature" }),
      "BBVA Visa",
      "card",
    );
  });

  it("resolves the names that used to fail with Account not found", () => {
    // 111 failures
    expectResolved(resolveAccount(ACCOUNTS, { accountName: "Mastercard Nexo Card ••4186" }), "Nexo Card", "name");
    // 44 failures
    expectResolved(resolveAccount(ACCOUNTS, { accountName: "BBVA Mastercard *1886" }), "BBVA Mastercard", "name");
    // 2 failures
    expectResolved(resolveAccount(ACCOUNTS, { accountName: "BBVA Visa *9253" }), "BBVA Visa", "name");
    // 1 failure
    expectResolved(resolveAccount(ACCOUNTS, { accountName: "RappiCard" }), "Rappi", "name");
    expectResolved(
      resolveAccount(ACCOUNTS, { accountName: "TARJETA NEGRA RAPPICARD CO" }),
      "Rappi",
      "name",
    );
  });

  it("prefers the most specific account name", () => {
    // "BBVA Mastercard *1886" contains both "BBVA" and "BBVA Mastercard".
    expectResolved(resolveAccount(ACCOUNTS, { accountName: "BBVA Mastercard" }), "BBVA Mastercard", "name");
    // "Mastercard Nexo Card ••4186" contains both "Nexo" and "Nexo Card".
    expectResolved(resolveAccount(ACCOUNTS, { accountName: "Nexo Card ••4186" }), "Nexo Card", "name");
  });

  it("matches regardless of case and accents", () => {
    expectResolved(resolveAccount(ACCOUNTS, { accountName: "bancolombia ahorros" }), "Bancolombia Ahorros", "name");
    expectResolved(resolveAccount(ACCOUNTS, { accountName: "Bancolombía Ahórros" }), "Bancolombia Ahorros", "name");
  });

  it("fails instead of guessing when a card maps to several accounts", () => {
    const duplicated: AccountCandidate[] = [
      { id: "x", name: "Uno", native_currency: "USD", card_digits: ["1111"] },
      { id: "y", name: "Dos", native_currency: "USD", card_digits: ["1111"] },
    ];
    const result = resolveAccount(duplicated, { cardLast4: "1111" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("mapped to 2 accounts");
  });

  it("fails instead of guessing when a name matches several accounts equally", () => {
    const ambiguous: AccountCandidate[] = [
      { id: "x", name: "Wise A", native_currency: "USD", card_digits: [] },
      { id: "y", name: "Wise B", native_currency: "USD", card_digits: [] },
    ];
    const result = resolveAccount(ambiguous, { accountName: "pago con Wise A y Wise B" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("more than one account");
  });

  it("falls back to the name when the card is unknown", () => {
    expectResolved(
      resolveAccount(ACCOUNTS, { cardLast4: "0000", accountName: "Nexo Card" }),
      "Nexo Card",
      "name",
    );
  });

  it("reports what it tried when nothing resolves", () => {
    const result = resolveAccount(ACCOUNTS, { cardLast4: "5333", accountName: "AstroPay" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("••5333");
      expect(result.reason).toContain("AstroPay");
    }
  });

  it("reports a missing hint rather than throwing", () => {
    const result = resolveAccount(ACCOUNTS, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no card or name");
  });
});
