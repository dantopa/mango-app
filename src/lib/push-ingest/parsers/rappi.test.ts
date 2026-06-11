import { describe, it, expect } from "vitest";
import { rappiParser } from "./rappi";
import type { PushPayload } from "../types";

const basePayload: PushPayload = {
  packageName: "com.grability.rappi",
  title: "RappiCard",
  text: "",
  timestamp: Date.now(),
};

describe("rappiParser", () => {
  describe("parses purchase notifications", () => {
    it("parses standard purchase notification", () => {
      const payload: PushPayload = {
        ...basePayload,
        text: "Tu compra en EXITO ENVIGADO por $ 33.300 fue exitosa",
      };
      const result = rappiParser(payload);
      expect(result).not.toBeNull();
      expect(result!.amount_native).toBe(33300);
      expect(result!.native_currency).toBe("COP");
      expect(result!.merchant).toBe("EXITO ENVIGADO");
      expect(result!.account_name).toBe("Rappi");
    });

    it("parses purchase with large amount (thousands separator)", () => {
      const payload: PushPayload = {
        ...basePayload,
        text: "Tu compra en AMAZON CO por $ 827.583 fue exitosa",
      };
      const result = rappiParser(payload);
      expect(result).not.toBeNull();
      expect(result!.amount_native).toBe(827583);
      expect(result!.merchant).toBe("AMAZON CO");
    });

    it("parses purchase with small amount (no separator)", () => {
      const payload: PushPayload = {
        ...basePayload,
        text: "Tu compra en TIENDA LOCAL por $ 500 fue exitosa",
      };
      const result = rappiParser(payload);
      expect(result).not.toBeNull();
      expect(result!.amount_native).toBe(500);
      expect(result!.merchant).toBe("TIENDA LOCAL");
    });

    it("sets tx_date to today in YYYY-MM-DD format", () => {
      const payload: PushPayload = {
        ...basePayload,
        text: "Tu compra en CAFE VELVET por $ 12.000 fue exitosa",
      };
      const result = rappiParser(payload);
      expect(result).not.toBeNull();
      expect(result!.tx_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("includes full text as description_raw", () => {
      const text = "Tu compra en PAN PA YA por $ 8.500 fue exitosa";
      const payload: PushPayload = { ...basePayload, text };
      const result = rappiParser(payload);
      expect(result).not.toBeNull();
      expect(result!.description_raw).toBe(text);
    });
  });

  describe("ignores non-financial notifications", () => {
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
        const payload: PushPayload = { ...basePayload, text };
        expect(rappiParser(payload)).toBeNull();
      }
    });

    it("ignores delivery notifications in title", () => {
      const payload: PushPayload = {
        ...basePayload,
        title: "Tu pedido entregado",
        text: "Califica tu experiencia",
      };
      expect(rappiParser(payload)).toBeNull();
    });

    it("returns null for text that doesn't match purchase pattern", () => {
      const payload: PushPayload = {
        ...basePayload,
        text: "¡Tienes un cupón de descuento del 20%!",
      };
      expect(rappiParser(payload)).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("returns null for empty text", () => {
      const payload: PushPayload = { ...basePayload, text: "" };
      expect(rappiParser(payload)).toBeNull();
    });

    it("handles merchant names with special characters", () => {
      const payload: PushPayload = {
        ...basePayload,
        text: "Tu compra en D1 - SABANETA #23 por $ 45.200 fue exitosa",
      };
      const result = rappiParser(payload);
      expect(result).not.toBeNull();
      expect(result!.merchant).toBe("D1 - SABANETA #23");
    });
  });
});
