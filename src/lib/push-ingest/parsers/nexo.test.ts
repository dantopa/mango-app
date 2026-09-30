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

  describe("parses crypto cashback notifications", () => {
    // Regression: "Cashback en cripto: X NEXO" contains its own "en", and the
    // old ".* en" merchant anchor greedily matched that one instead of the
    // "en" before the merchant name, capturing "cripto: X NEXO" as the
    // merchant. This is also the format Nexo actually sends for COP charges.
    it("parses 'Pago de' with a crypto cashback suffix", () => {
      const tx = expectTransaction(
        nexoParser({
          ...basePayload,
          text: "Pago de 19900.00 COP (€5.55) en UBER *ONE MEMBERSHIP U. Cashback en cripto: 0.13442718 NEXO.",
        }),
      );
      expect(tx.amount_native).toBe(19900);
      expect(tx.native_currency).toBe("COP");
      expect(tx.merchant).toBe("UBER *ONE MEMBERSHIP U");
    });

    it("parses a merchant name that itself contains a period", () => {
      const tx = expectTransaction(
        nexoParser({
          ...basePayload,
          text: "Pago de 27.51 USD (€24.08) en UBER *TRIP HELP.UBER.C. Cashback en cripto: 0.54428121 NEXO.",
        }),
      );
      expect(tx.merchant).toBe("UBER *TRIP HELP.UBER.C");
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

  describe("parses notifications with a currency symbol before the amount", () => {
    // Regression (July 2026): "Pago de €0.91 en PAYPAL *PEACOCKTVLL" was stored
    // as 91 USD, and "€9.12" as 912 USD, on the wrong account.
    it("reads '€0.91' as 0.91 EUR, not 91", () => {
      const tx = expectTransaction(
        nexoParser({
          ...basePayload,
          text: "Pago de €0.91 en PAYPAL *PEACOCKTVLL. Cashback en cripto: 0.01322050 NEXO.",
        }),
      );
      expect(tx.amount_native).toBe(0.91);
      expect(tx.native_currency).toBe("EUR");
      expect(tx.merchant).toBe("PAYPAL *PEACOCKTVLL");
      expect(tx.account_name).toBe("Nexo Card");
    });

    it("reads '€9.12' as 9.12 EUR, not 912", () => {
      const tx = expectTransaction(
        nexoParser({ ...basePayload, text: "Pago de €9.12 en PAYPAL *FUBOTV. Cashback en cripto: 0.21579794 NEXO." }),
      );
      expect(tx.amount_native).toBe(9.12);
      expect(tx.native_currency).toBe("EUR");
    });

    it("leaves a bare '$' to the card's own currency", () => {
      const tx = expectTransaction(
        nexoParser({ ...basePayload, text: "Pago de $13.00 en AMAZON MKTPLACE PMTS. Cashback en cripto: 0.23661821 NEXO." }),
      );
      expect(tx.amount_native).toBe(13);
      expect(tx.native_currency).toBeNull();
      expect(tx.merchant).toBe("AMAZON MKTPLACE PMTS");
    });

    it("parses a cash withdrawal in euros", () => {
      const tx = expectTransaction(
        nexoParser({ ...basePayload, text: "Retiro en efectivo de €20.78(23.75 USD) en Alpha Liquidity - Que." }),
      );
      expect(tx.amount_native).toBe(20.78);
      expect(tx.native_currency).toBe("EUR");
      expect(tx.merchant).toBe("Alpha Liquidity - Que");
    });

    it("stores a refund as a negative amount", () => {
      const tx = expectTransaction(
        nexoParser({ ...basePayload, text: "Reembolso de € 43.78(50.00 USD) de WWW.BEDSNDRINKS.COM." }),
      );
      expect(tx.amount_native).toBe(-43.78);
      expect(tx.native_currency).toBe("EUR");
      expect(tx.merchant).toBe("WWW.BEDSNDRINKS.COM");
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
