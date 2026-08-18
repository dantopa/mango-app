import { describe, it, expect } from "vitest";
import { rappiParser } from "./rappi";
import type { ParseResult, ParsedTransaction, PushPayload } from "../types";

const basePayload: PushPayload = {
  packageName: "com.grability.rappi",
  title: "RappiCard",
  text: "",
  timestamp: Date.now(),
};

/** Asserts the parser recognized a transaction and returns it. */
function expectTransaction(result: ParseResult): ParsedTransaction {
  if (result.kind !== "transaction") throw new Error(`expected a transaction, got "${result.kind}"`);
  return result.tx;
}

describe("rappiParser", () => {
  describe("parses purchase notifications", () => {
    it("parses standard purchase notification", () => {
      const tx = expectTransaction(
        rappiParser({ ...basePayload, text: "Tu compra en EXITO ENVIGADO por $ 33.300 fue exitosa" }),
      );
      expect(tx.amount_native).toBe(33300);
      expect(tx.native_currency).toBe("COP");
      expect(tx.merchant).toBe("EXITO ENVIGADO");
      expect(tx.account_name).toBe("Rappi");
    });

    it("parses purchase with large amount (thousands separator)", () => {
      const tx = expectTransaction(
        rappiParser({ ...basePayload, text: "Tu compra en AMAZON CO por $ 827.583 fue exitosa" }),
      );
      expect(tx.amount_native).toBe(827583);
      expect(tx.merchant).toBe("AMAZON CO");
    });

    it("parses purchase with small amount (no separator)", () => {
      const tx = expectTransaction(
        rappiParser({ ...basePayload, text: "Tu compra en TIENDA LOCAL por $ 500 fue exitosa" }),
      );
      expect(tx.amount_native).toBe(500);
      expect(tx.merchant).toBe("TIENDA LOCAL");
    });

    it("reads COP cents as thousands, not decimals", () => {
      // COP has no cents: "$ 7.500" is seven thousand five hundred pesos.
      const tx = expectTransaction(
        rappiParser({ ...basePayload, text: "Tu compra en PERGAMINO por $ 7.500 fue exitosa" }),
      );
      expect(tx.amount_native).toBe(7500);
    });

    it("sets tx_date to today in YYYY-MM-DD format", () => {
      const tx = expectTransaction(
        rappiParser({ ...basePayload, text: "Tu compra en CAFE VELVET por $ 12.000 fue exitosa" }),
      );
      expect(tx.tx_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("includes full text as description_raw", () => {
      const text = "Tu compra en PAN PA YA por $ 8.500 fue exitosa";
      const tx = expectTransaction(rappiParser({ ...basePayload, text }));
      expect(tx.description_raw).toBe(text);
    });
  });

  describe("ignores non-financial notifications", () => {
    // Rappi is the noisiest package in push_raw_log (~170 of ~600 notifications).
    // Each of these must be an explicit "ignore" so it never reaches the AI.
    it("ignores delivery notifications in text", () => {
      const deliveryTexts = [
        "Tu pedido entregado en la puerta",
        "Tu pedido ha sido cancelado",
        "Tu pedido está en camino",
        "Ya casi llega tu pedido",
        "Alístate, tu Rappi está cerca",
        "Llegó tu pedido",
      ];
      for (const text of deliveryTexts) {
        expect(rappiParser({ ...basePayload, text }).kind, text).toBe("ignore");
      }
    });

    it("ignores delivery notifications in title", () => {
      const result = rappiParser({
        ...basePayload,
        title: "Tu pedido entregado",
        text: "Califica tu experiencia",
      });
      expect(result.kind).toBe("ignore");
    });

    it("ignores promos", () => {
      expect(rappiParser({ ...basePayload, text: "¡Tienes un cupón de descuento del 20%!" }).kind).toBe("ignore");
    });
  });

  describe("edge cases", () => {
    it("reports empty text as unrecognized", () => {
      expect(rappiParser({ ...basePayload, text: "" }).kind).toBe("unknown");
    });

    it("handles merchant names with special characters", () => {
      const tx = expectTransaction(
        rappiParser({ ...basePayload, text: "Tu compra en D1 - SABANETA #23 por $ 45.200 fue exitosa" }),
      );
      expect(tx.merchant).toBe("D1 - SABANETA #23");
    });
  });
});
