import { describe, it, expect } from "vitest";
import { bancolombiaParser } from "./bancolombia";
import type { ParseResult, ParsedTransaction, PushPayload } from "../types";

const basePayload: PushPayload = {
  packageName: "com.todo1.mobile",
  title: "Bancolombia",
  text: "",
  timestamp: Date.now(),
};

/** Asserts the parser recognized a transaction and returns it. */
function expectTransaction(result: ParseResult): ParsedTransaction {
  if (result.kind !== "transaction") throw new Error(`expected a transaction, got "${result.kind}"`);
  return result.tx;
}

describe("bancolombiaParser", () => {
  it("registers an incoming transfer as income, with a negative amount", () => {
    const tx = expectTransaction(
      bancolombiaParser({
        ...basePayload,
        text: "PATRICIO, recibiste una transferencia de SUPRA NEGOCIOS SAS por $970000.00 en tu cuenta *9898 el 05/06/2026 a las 10:30.",
      }),
    );

    expect(tx.amount_native).toBe(-970000);
    expect(tx.is_income).toBe(true);
    expect(tx.merchant).toBe("SUPRA NEGOCIOS SAS");
    expect(tx.tx_date).toBe("2026-06-05");
    expect(tx.card_last4).toBe("9898");
  });

  it("also handles a received payment", () => {
    const tx = expectTransaction(
      bancolombiaParser({
        ...basePayload,
        text: "PATRICIO, recibiste un pago de ACME SAS por $50000.00 en tu cuenta *9898 el 05/06/2026 a las 10:30.",
      }),
    );

    expect(tx.amount_native).toBe(-50000);
    expect(tx.is_income).toBe(true);
    expect(tx.merchant).toBe("ACME SAS");
  });

  it("keeps a purchase positive and not marked as income", () => {
    const tx = expectTransaction(
      bancolombiaParser({
        ...basePayload,
        text: "Compraste $7500.00 en PERGAMINO VIVA ENVIG con tu T.Deb *9898, el 09/06/2026 a las 09:12.",
      }),
    );

    expect(tx.amount_native).toBe(7500);
    expect(tx.is_income).toBeUndefined();
    expect(tx.merchant).toBe("PERGAMINO VIVA ENVIG");
  });

  it("registers a QR payment even without a merchant name", () => {
    const tx = expectTransaction(
      bancolombiaParser({
        ...basePayload,
        text: "PATRICIO, pagaste $25000.00 por codigo QR desde tu cuenta *9898 a la llave 0073300683 el 06/06/2026 a las 13:12.",
      }),
    );

    expect(tx.amount_native).toBe(25000);
    expect(tx.merchant).toBeNull();
    expect(tx.is_income).toBeUndefined();
  });

  it("registers an outgoing transfer as an expense", () => {
    const tx = expectTransaction(
      bancolombiaParser({
        ...basePayload,
        text: "Transferiste $100000.00 a la cuenta *34238965219 el 08/06/2026 a las 15:40.",
      }),
    );

    expect(tx.amount_native).toBe(100000);
    expect(tx.is_income).toBeUndefined();
  });

  it("escalates an unrecognized text", () => {
    expect(
      bancolombiaParser({ ...basePayload, text: "Tu clave dinámica es 123456." }).kind,
    ).toBe("unknown");
  });
});
