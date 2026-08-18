import { describe, it, expect } from "vitest";
import { parseAmount, detectCurrency, isKnownCurrency } from "./money";

describe("parseAmount", () => {
  it("reads a dot followed by two digits as a decimal separator", () => {
    // Regression: this returned 855, which is how 111 Google Wallet notifications
    // inflated into ~$267k of phantom expenses.
    expect(parseAmount("8.55")).toBe(8.55);
    expect(parseAmount("192.60")).toBe(192.6);
    expect(parseAmount("2.25")).toBe(2.25);
    expect(parseAmount("50.00")).toBe(50);
  });

  it("reads a lone separator followed by three digits as thousands", () => {
    expect(parseAmount("33.300")).toBe(33300);
    expect(parseAmount("827.583")).toBe(827583);
    expect(parseAmount("1.234.567")).toBe(1234567);
  });

  it("uses the rightmost separator as the decimal when both are present", () => {
    expect(parseAmount("7,500.00")).toBe(7500); // Google Wallet, US format
    expect(parseAmount("23.280,00")).toBe(23280); // BBVA, Argentine format
    expect(parseAmount("108.544,64")).toBe(108544.64);
    expect(parseAmount("156,240.00")).toBe(156240);
  });

  it("reads a comma followed by two digits as a decimal separator", () => {
    expect(parseAmount("16,91")).toBe(16.91);
    expect(parseAmount("0,00")).toBe(0);
  });

  it("groups thousands for currencies written without decimals", () => {
    expect(parseAmount("1.500", "COP")).toBe(1500);
    expect(parseAmount("1.50", "COP")).toBe(null); // not a valid 3-digit group
    expect(parseAmount("1.50", "USD")).toBe(1.5);
  });

  it("keeps the sign of a refund", () => {
    expect(parseAmount("-COP124,414.00")).toBe(-124414);
    expect(parseAmount("-14,962.00")).toBe(-14962);
  });

  it("strips currency codes, symbols and spacing", () => {
    expect(parseAmount("COP7,500.00")).toBe(7500);
    expect(parseAmount("$ 33.300")).toBe(33300);
    expect(parseAmount("USD16,91")).toBe(16.91);
    expect(parseAmount("ARS 2.000,00")).toBe(2000);
  });

  it("returns null instead of guessing on ambiguous or malformed input", () => {
    expect(parseAmount("12.3456")).toBe(null);
    expect(parseAmount("12.")).toBe(null);
    expect(parseAmount("1.23.456")).toBe(null); // inconsistent grouping
    expect(parseAmount("")).toBe(null);
    expect(parseAmount("sin monto")).toBe(null);
  });
});

describe("detectCurrency", () => {
  it("reads an ISO code glued to the amount", () => {
    expect(detectCurrency("Por USD16,91 a RESTAURANTES TIP T")).toBe("USD");
    expect(detectCurrency("Por ARS23.280,00 a CUOTA SOCIAL")).toBe("ARS");
    expect(detectCurrency("COP7,500.00 con Debito Mastercard")).toBe("COP");
  });

  it("prefers USDT over USD", () => {
    expect(detectCurrency("Pago de 100 USDT")).toBe("USDT");
  });

  it("reads symbols that are unambiguous", () => {
    expect(detectCurrency("Pago de €12,50 en LIDL")).toBe("EUR");
    expect(detectCurrency("US$25.00 con Wise Card")).toBe("USD");
  });

  it("returns null for a bare $ — it means COP, USD or ARS depending on the card", () => {
    expect(detectCurrency("$8.55 con Mastercard Nexo Card ••4186")).toBe(null);
    expect(detectCurrency("Tu compra en EXITO por $ 33.300 fue exitosa")).toBe(null);
  });

  it("does not match a code inside a word", () => {
    expect(detectCurrency("Se envio una COPIA del comprobante")).toBe(null);
  });
});

describe("isKnownCurrency", () => {
  it("accepts the currencies the ingest can convert", () => {
    expect(isKnownCurrency("usd")).toBe(true);
    expect(isKnownCurrency("COP")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isKnownCurrency("XYZ")).toBe(false);
    expect(isKnownCurrency("")).toBe(false);
  });
});
