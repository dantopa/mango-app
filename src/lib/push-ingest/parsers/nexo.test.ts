import { describe, it, expect } from "vitest";
import { nexoParser } from "./nexo";
import type { ParseResult, ParsedTransaction, PushPayload } from "../types";

const basePayload: PushPayload = {
  packageName: "com.nexowallet",
  title: "Nexo",
  text: "",
  timestamp: Date.now(),
};

/** Asserts the parser recognized a transaction and returns it. */
function expectTransaction(result: ParseResult): ParsedTransaction {
  if (result.kind !== "transaction") throw new Error(`expected a transaction, got "${result.kind}"`);
  return result.tx;
}

describe("nexoParser", () => {
  describe("parses Spanish payment notifications", () => {
    it("parses standard 'Pago de' notification with cashback", () => {
      const tx = expectTransaction(
        nexoParser({ ...basePayload, text: "Pago de 15.50 USD (€14.20) en SPOTIFY. Cashback 2%" }),
      );
      expect(tx.amount_native).toBe(15.5);
      expect(tx.native_currency).toBe("USD");
      expect(tx.merchant).toBe("SPOTIFY");
      expect(tx.account_name).toBe("Nexo Card");
    });

    it("parses payment in EUR", () => {
      const tx = expectTransaction(
        nexoParser({ ...basePayload, text: "Pago de 42,99 EUR (€42.99) en AMAZON PRIME. Cashback 0.5%" }),
      );
      expect(tx.amount_native).toBe(42.99);
      expect(tx.native_currency).toBe("EUR");
      expect(tx.merchant).toBe("AMAZON PRIME");
    });

    it("parses payment without explicit cashback suffix", () => {
      const tx = expectTransaction(
        nexoParser({ ...basePayload, text: "Pago de 5.00 USD (€4.60) en GOOGLE ONE." }),
      );
      expect(tx.amount_native).toBe(5.0);
      expect(tx.merchant).toBe("GOOGLE ONE");
    });

    it("parses payment with comma as decimal separator", () => {
      const tx = expectTransaction(
        nexoParser({ ...basePayload, text: "Pago de 3,50 USD (€3.20) en CAFE VELVET. Cashback 2%" }),
      );
      expect(tx.amount_native).toBe(3.5);
    });
  });

  describe("parses English payment notifications", () => {
    it("parses 'Payment of' variant", () => {
      const tx = expectTransaction(
        nexoParser({ ...basePayload, text: "Payment of 29.99 USD (€27.50) at NETFLIX. Cashback 2%" }),
      );
      expect(tx.amount_native).toBe(29.99);
      expect(tx.native_currency).toBe("USD");
      expect(tx.merchant).toBe("NETFLIX");
      expect(tx.account_name).toBe("Nexo Card");
    });

    it("parses English payment without cashback", () => {
      const tx = expectTransaction(
        nexoParser({ ...basePayload, text: "Payment of 12.00 USD (€11.00) at UBER EATS." }),
      );
      expect(tx.amount_native).toBe(12.0);
      expect(tx.merchant).toBe("UBER EATS");
    });
  });

  describe("ignores promotional notifications", () => {
    // These must resolve as "ignore", not "unknown": an unknown escalates to the
    // AI, which is both a wasted call and an invitation to invent an expense.
    const promos = [
      "Opera más con menos. Usa apalancamiento en Nexo Pro.",
      "Usa Futures para multiplicar tus ganancias.",
      "Multiplica tu saldo con staking. Hasta 16% APY.",
      "Saldo de trading: 1,234.56 USD",
      "Precio de BTC alcanzó $100,000",
    ];

    for (const text of promos) {
      it(`ignores: ${text.slice(0, 40)}`, () => {
        expect(nexoParser({ ...basePayload, text }).kind).toBe("ignore");
      });
    }
  });

  describe("edge cases", () => {
    it("reports empty text as unrecognized", () => {
      expect(nexoParser({ ...basePayload, text: "" }).kind).toBe("unknown");
    });

    it("reports unrelated text as unrecognized", () => {
      expect(nexoParser({ ...basePayload, text: "Tu verificación KYC fue aprobada." }).kind).toBe("unknown");
    });

    it("rejects an unknown currency code instead of registering it", () => {
      // "Pago de 10.00 XYZ" is not something we can price; escalate, never guess.
      expect(nexoParser({ ...basePayload, text: "Pago de 10.00 XYZ (€9.20) en TEST." }).kind).toBe("unknown");
    });

    it("sets tx_date to today in YYYY-MM-DD format", () => {
      const tx = expectTransaction(
        nexoParser({ ...basePayload, text: "Pago de 10.00 USD (€9.20) en TEST STORE. Cashback 1%" }),
      );
      expect(tx.tx_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("includes full text as description_raw", () => {
      const text = "Pago de 7.99 USD (€7.30) en DISNEY PLUS. Cashback 2%";
      const tx = expectTransaction(nexoParser({ ...basePayload, text }));
      expect(tx.description_raw).toBe(text);
    });
  });
});
