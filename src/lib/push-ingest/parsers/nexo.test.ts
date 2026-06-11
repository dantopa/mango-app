import { describe, it, expect } from "vitest";
import { nexoParser } from "./nexo";
import type { PushPayload } from "../types";

const basePayload: PushPayload = {
  packageName: "com.nexowallet",
  title: "Nexo",
  text: "",
  timestamp: Date.now(),
};

describe("nexoParser", () => {
  describe("parses Spanish payment notifications", () => {
    it("parses standard 'Pago de' notification with cashback", () => {
      const payload: PushPayload = {
        ...basePayload,
        text: "Pago de 15.50 USD (€14.20) en SPOTIFY. Cashback 2%",
      };
      const result = nexoParser(payload);
      expect(result).not.toBeNull();
      expect(result!.amount_native).toBe(15.5);
      expect(result!.native_currency).toBe("USD");
      expect(result!.merchant).toBe("SPOTIFY");
      expect(result!.account_name).toBe("Nexo Card");
    });

    it("parses payment in EUR", () => {
      const payload: PushPayload = {
        ...basePayload,
        text: "Pago de 42,99 EUR (€42.99) en AMAZON PRIME. Cashback 0.5%",
      };
      const result = nexoParser(payload);
      expect(result).not.toBeNull();
      expect(result!.amount_native).toBe(42.99);
      expect(result!.native_currency).toBe("EUR");
      expect(result!.merchant).toBe("AMAZON PRIME");
    });

    it("parses payment without explicit cashback suffix", () => {
      const payload: PushPayload = {
        ...basePayload,
        text: "Pago de 5.00 USD (€4.60) en GOOGLE ONE.",
      };
      const result = nexoParser(payload);
      expect(result).not.toBeNull();
      expect(result!.amount_native).toBe(5.0);
      expect(result!.merchant).toBe("GOOGLE ONE");
    });

    it("parses payment with comma as decimal separator", () => {
      const payload: PushPayload = {
        ...basePayload,
        text: "Pago de 3,50 USD (€3.20) en CAFE VELVET. Cashback 2%",
      };
      const result = nexoParser(payload);
      expect(result).not.toBeNull();
      expect(result!.amount_native).toBe(3.5);
    });
  });

  describe("parses English payment notifications", () => {
    it("parses 'Payment of' variant", () => {
      const payload: PushPayload = {
        ...basePayload,
        text: "Payment of 29.99 USD (€27.50) at NETFLIX. Cashback 2%",
      };
      const result = nexoParser(payload);
      expect(result).not.toBeNull();
      expect(result!.amount_native).toBe(29.99);
      expect(result!.native_currency).toBe("USD");
      expect(result!.merchant).toBe("NETFLIX");
      expect(result!.account_name).toBe("Nexo Card");
    });

    it("parses English payment without cashback", () => {
      const payload: PushPayload = {
        ...basePayload,
        text: "Payment of 12.00 USD (€11.00) at UBER EATS.",
      };
      const result = nexoParser(payload);
      expect(result).not.toBeNull();
      expect(result!.amount_native).toBe(12.0);
      expect(result!.merchant).toBe("UBER EATS");
    });
  });

  describe("ignores promotional notifications", () => {
    it("ignores 'Opera más con menos' promo", () => {
      const payload: PushPayload = {
        ...basePayload,
        text: "Opera más con menos. Usa apalancamiento en Nexo Pro.",
      };
      expect(nexoParser(payload)).toBeNull();
    });

    it("ignores 'Usa Futures' promo", () => {
      const payload: PushPayload = {
        ...basePayload,
        text: "Usa Futures para multiplicar tus ganancias.",
      };
      expect(nexoParser(payload)).toBeNull();
    });

    it("ignores 'Multiplica' promo", () => {
      const payload: PushPayload = {
        ...basePayload,
        text: "Multiplica tu saldo con staking. Hasta 16% APY.",
      };
      expect(nexoParser(payload)).toBeNull();
    });

    it("ignores balance/price notifications", () => {
      const payload: PushPayload = {
        ...basePayload,
        text: "Saldo de trading: 1,234.56 USD",
      };
      expect(nexoParser(payload)).toBeNull();
    });

    it("ignores 'Precio de' alerts", () => {
      const payload: PushPayload = {
        ...basePayload,
        text: "Precio de BTC alcanzó $100,000",
      };
      expect(nexoParser(payload)).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("returns null for empty text", () => {
      const payload: PushPayload = { ...basePayload, text: "" };
      expect(nexoParser(payload)).toBeNull();
    });

    it("returns null for unrelated text", () => {
      const payload: PushPayload = {
        ...basePayload,
        text: "Tu verificación KYC fue aprobada.",
      };
      expect(nexoParser(payload)).toBeNull();
    });

    it("sets tx_date to today in YYYY-MM-DD format", () => {
      const payload: PushPayload = {
        ...basePayload,
        text: "Pago de 10.00 USD (€9.20) en TEST STORE. Cashback 1%",
      };
      const result = nexoParser(payload);
      expect(result).not.toBeNull();
      expect(result!.tx_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("includes full text as description_raw", () => {
      const text = "Pago de 7.99 USD (€7.30) en DISNEY PLUS. Cashback 2%";
      const payload: PushPayload = { ...basePayload, text };
      const result = nexoParser(payload);
      expect(result).not.toBeNull();
      expect(result!.description_raw).toBe(text);
    });
  });
});
