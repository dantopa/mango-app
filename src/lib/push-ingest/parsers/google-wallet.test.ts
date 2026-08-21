import { describe, it, expect } from "vitest";
import { googleWalletParser, timestampToLocalDate } from "./google-wallet";
import type { ParseResult, ParsedTransaction, PushPayload } from "../types";

const basePayload: PushPayload = {
  packageName: "com.google.android.apps.walletnfcrel",
  title: "PERGAMINO VIVA ENVIGAD",
  text: "",
  timestamp: new Date("2026-06-10T15:00:00Z").getTime(),
};

/** Asserts the parser recognized a transaction and returns it. */
function expectTransaction(result: ParseResult): ParsedTransaction {
  if (result.kind !== "transaction") throw new Error(`expected a transaction, got "${result.kind}"`);
  return result.tx;
}

describe("timestampToLocalDate", () => {
  it("converts 01:30 UTC to the previous day in America/Bogota (UTC-5)", () => {
    // 2026-06-10 01:30 UTC = 2026-06-09 20:30 Bogotá → should return 2026-06-09
    const utcTimestamp = new Date("2026-06-10T01:30:00Z").getTime();
    expect(timestampToLocalDate(utcTimestamp)).toBe("2026-06-09");
  });

  it("keeps the same day when UTC time is >= 05:00 (i.e. >= 00:00 Bogotá)", () => {
    // 2026-06-10 05:00 UTC = 2026-06-10 00:00 Bogotá → should return 2026-06-10
    const utcTimestamp = new Date("2026-06-10T05:00:00Z").getTime();
    expect(timestampToLocalDate(utcTimestamp)).toBe("2026-06-10");
  });

  it("converts 04:59 UTC to the previous day in Bogotá", () => {
    // 2026-06-10 04:59 UTC = 2026-06-09 23:59 Bogotá → should return 2026-06-09
    const utcTimestamp = new Date("2026-06-10T04:59:00Z").getTime();
    expect(timestampToLocalDate(utcTimestamp)).toBe("2026-06-09");
  });

  it("handles midnight UTC → previous day in Bogotá", () => {
    // 2026-06-10 00:00 UTC = 2026-06-09 19:00 Bogotá → should return 2026-06-09
    const utcTimestamp = new Date("2026-06-10T00:00:00Z").getTime();
    expect(timestampToLocalDate(utcTimestamp)).toBe("2026-06-09");
  });

  it("handles year boundary correctly", () => {
    // 2026-01-01 03:00 UTC = 2025-12-31 22:00 Bogotá → should return 2025-12-31
    const utcTimestamp = new Date("2026-01-01T03:00:00Z").getTime();
    expect(timestampToLocalDate(utcTimestamp)).toBe("2025-12-31");
  });
});

describe("googleWalletParser — timezone handling", () => {
  it("uses Bogotá date when timestamp is 01:30 UTC (previous day locally)", () => {
    // 2026-06-10 01:30 UTC = 2026-06-09 20:30 Bogotá
    const tx = expectTransaction(
      googleWalletParser({
        ...basePayload,
        text: "COP7,500.00 con Debito Mastercard ••5685",
        timestamp: new Date("2026-06-10T01:30:00Z").getTime(),
      }),
    );
    expect(tx.tx_date).toBe("2026-06-09");
  });

  it("uses same-day Bogotá date when timestamp is 15:00 UTC", () => {
    // 2026-06-10 15:00 UTC = 2026-06-10 10:00 Bogotá
    const tx = expectTransaction(
      googleWalletParser({
        ...basePayload,
        title: "BOLD SA*COYO TAC",
        text: "COP63,400.00 con Debito Mastercard ••5685",
        timestamp: new Date("2026-06-10T15:00:00Z").getTime(),
      }),
    );
    expect(tx.tx_date).toBe("2026-06-10");
  });
});

// Every text below is verbatim from push_raw_log.
describe("googleWalletParser — formats", () => {
  it("parses a COP charge and keeps the card digits", () => {
    const tx = expectTransaction(
      googleWalletParser({ ...basePayload, text: "COP7,525.00 con TARJETA NEGRA RAPPICARD CO ••3679" }),
    );
    expect(tx.amount_native).toBe(7525);
    expect(tx.native_currency).toBe("COP");
    expect(tx.card_last4).toBe("3679");
    expect(tx.account_name).toBe("TARJETA NEGRA RAPPICARD CO");
    expect(tx.merchant).toBe("PERGAMINO VIVA ENVIGAD");
  });

  it("reads a bare '$' as USD with a decimal separator", () => {
    // Regression: "$8.55" was read as 855 COP, which is how 111 Wallet
    // notifications inflated into ~$267k of phantom expenses.
    const tx = expectTransaction(
      googleWalletParser({ ...basePayload, text: "$8.55 con Mastercard Nexo Card ••4186" }),
    );
    expect(tx.amount_native).toBe(8.55);
    expect(tx.native_currency).toBe("USD");
  });

  it("treats a bare '$' as USD even on a COP card (international purchase)", () => {
    const tx = expectTransaction(
      googleWalletParser({ ...basePayload, text: "$29.73 con TARJETA NEGRA RAPPICARD CO ••3679" }),
    );
    expect(tx.amount_native).toBe(29.73);
    expect(tx.native_currency).toBe("USD");
  });

  it("stores a refund as a negative amount", () => {
    const tx = expectTransaction(
      googleWalletParser({
        ...basePayload,
        text: "Se reembolsó un importe de -COP124,414.00 en TARJETA NEGRA RAPPICARD CO ••3679",
      }),
    );
    expect(tx.amount_native).toBe(-124414);
    expect(tx.native_currency).toBe("COP");
  });

  it("stores the 'suffix currency' refund phrasing as a negative amount", () => {
    // Regression: this exact notification escalated to the AI (RE_CHARGE
    // expects "<amount> en <card> ••1234", but here the card comes first and
    // the amount/currency come after "importe:"). The AI then classified it
    // as is_transaction=false — a reimbursement "is not an expense" — so the
    // refund was silently dropped and the original charge stayed unreversed.
    const tx = expectTransaction(
      googleWalletParser({
        ...basePayload,
        title: "UBR* PENDING.UBER.COM",
        text: "Se ha reembolsado en la tarjeta Nexo Mastercard ••4186 el siguiente importe: -11.475 COP",
      }),
    );
    expect(tx.amount_native).toBe(-11475);
    expect(tx.native_currency).toBe("COP");
    expect(tx.card_last4).toBe("4186");
    expect(tx.account_name).toBe("Nexo Mastercard");
    expect(tx.merchant).toBe("UBR* PENDING.UBER.COM");
  });

  it("ignores a declined payment instead of registering it", () => {
    const result = googleWalletParser({
      ...basePayload,
      text: "RECHAZADO: $50.00 pagado con Signature ••9253",
    });
    expect(result.kind).toBe("ignore");
  });

  it("ignores a notification with no card (boarding pass, promo)", () => {
    const result = googleWalletParser({ ...basePayload, text: "En horario: De MDE a CLO" });
    expect(result.kind).toBe("ignore");
  });

  it("escalates an unrecognized format that does mention a card", () => {
    const result = googleWalletParser({ ...basePayload, text: "Algo nuevo con la tarjeta ••4186" });
    expect(result.kind).toBe("unknown");
  });

  it("keeps 'UBR* PENDING.UBER.COM' as an ordinary merchant", () => {
    // "PENDING" is part of Uber's merchant name, not a Wallet status. Treating it
    // as one dropped 31 real charges and could delete an unrelated transaction.
    const tx = expectTransaction(
      googleWalletParser({
        ...basePayload,
        title: "UBR* PENDING.UBER.COM",
        text: "$13.28 con Signature ••9253",
      }),
    );
    expect(tx.merchant).toBe("UBR* PENDING.UBER.COM");
    expect(tx.amount_native).toBe(13.28);
  });
});
