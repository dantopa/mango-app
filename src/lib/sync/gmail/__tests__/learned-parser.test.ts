import { describe, it, expect } from "vitest";

import { applyGmailTemplate, templateKey, verifyExtraction, vetTemplate } from "../learned-parser";
import type { Extraction, GmailTemplate } from "../learned-parser";
import { bancolombiaDef } from "../sources/bancolombia";
import type { CandidateTransaction } from "../../types";
import type { ParsedEmail } from "../types";

/** 2026-08-12 15:00 UTC → 2026-08-12 in Bogotá. */
const INTERNAL_DATE = "1786546800000";

const BODY =
  "Bancolombia: Compraste $47.000,00 en TIENDA NUEVA SAS con tu T.Deb *1234, el 12/08/2026 a las 14:32.";

function email(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    messageId: "msg-1",
    internalDate: INTERNAL_DATE,
    subject: "Comprobante de compra",
    bodyText: BODY,
    ...overrides,
  };
}

function template(overrides: Partial<GmailTemplate> = {}): GmailTemplate {
  return {
    id: "t1",
    title_pattern: null,
    text_pattern:
      "Compraste \\$(?<amount>[\\d.,]+) en (?<merchant>[^*]+?) con tu [^*]+\\*(?<card>\\d{4}), el (?<date>\\d{2}/\\d{2}/\\d{4})",
    currency: "COP",
    outcome: "expense",
    hit_count: 0,
    ...overrides,
  };
}

describe("templateKey", () => {
  it("shares the namespace push_ingest_log uses for Gmail", () => {
    expect(templateKey("bancolombia")).toBe("gmail.bancolombia");
  });
});

describe("applyGmailTemplate", () => {
  it("extracts amount, merchant, card and date from the named groups", () => {
    const result = applyGmailTemplate(template(), email(), bancolombiaDef);

    expect(result).toEqual({
      kind: "transaction",
      tx: {
        amount_native: 47000,
        native_currency: "COP",
        merchant: "TIENDA NUEVA SAS",
        tx_date: "2026-08-12",
        description_raw:
          "Compraste $47.000,00 en TIENDA NUEVA SAS con tu T.Deb *1234, el 12/08/2026",
        account_name: "Bancolombia Ahorros",
        source: "sync_gmail_bancolombia",
        card_last4: "1234",
      },
    });
  });

  /** The day the email arrived is the only honest fallback when the body has no date. */
  it("falls back to the arrival date when the pattern captures none", () => {
    const result = applyGmailTemplate(
      template({ text_pattern: "Compraste \\$(?<amount>[\\d.,]+)" }),
      email(),
      bancolombiaDef,
    );

    expect(result.kind).toBe("transaction");
    if (result.kind !== "transaction") return;
    expect(result.tx.tx_date).toBe("2026-08-12");
  });

  it("stores a refund negative", () => {
    const result = applyGmailTemplate(template({ outcome: "refund" }), email(), bancolombiaDef);
    expect(result.kind).toBe("transaction");
    if (result.kind !== "transaction") return;
    expect(result.tx.amount_native).toBe(-47000);
  });

  it("reports an ignore template without extracting anything", () => {
    expect(
      applyGmailTemplate(template({ outcome: "ignore" }), email(), bancolombiaDef),
    ).toEqual({ kind: "ignore" });
  });

  it("does not match a different format", () => {
    const other = email({ bodyText: "Bancolombia: recibiste una transferencia de $10.000,00." });
    expect(applyGmailTemplate(template(), other, bancolombiaDef).kind).toBe("no_match");
  });

  it("respects a subject pattern", () => {
    const t = template({ title_pattern: "Resumen mensual" });
    expect(applyGmailTemplate(t, email(), bancolombiaDef).kind).toBe("no_match");
  });

  it("refuses a pattern with no amount group", () => {
    const t = template({ text_pattern: "Compraste \\$[\\d.,]+" });
    expect(applyGmailTemplate(t, email(), bancolombiaDef).kind).toBe("no_match");
  });

  it("refuses an invalid regex instead of throwing", () => {
    const t = template({ text_pattern: "Compraste (?<amount>[\\d.,]+" });
    expect(applyGmailTemplate(t, email(), bancolombiaDef).kind).toBe("no_match");
  });

  it("refuses a nested quantifier that could blow up", () => {
    const t = template({ text_pattern: "(?<amount>[\\d.,]+)(.+)+" });
    expect(applyGmailTemplate(t, email(), bancolombiaDef).kind).toBe("no_match");
  });
});

function extraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    understood: true,
    is_transaction: true,
    is_refund: false,
    reason: "compra",
    amount_text: "$47.000,00",
    currency: "COP",
    merchant: "TIENDA NUEVA SAS",
    date_text: "12/08/2026",
    text_regex: template().text_pattern,
    ...overrides,
  };
}

describe("verifyExtraction", () => {
  it("accepts an extraction whose every claim is in the email", () => {
    const tx = verifyExtraction(email(), extraction(), bancolombiaDef);
    expect(tx).toMatchObject({
      amount_native: 47000,
      native_currency: "COP",
      tx_date: "2026-08-12",
      account_name: "Bancolombia Ahorros",
    });
  });

  /** The whole point: a number the model made up must never reach the ledger. */
  it("rejects an amount that does not appear in the email", () => {
    expect(verifyExtraction(email(), extraction({ amount_text: "$470.000,00" }), bancolombiaDef)).toBeNull();
  });

  it("rejects a missing amount", () => {
    expect(verifyExtraction(email(), extraction({ amount_text: null }), bancolombiaDef)).toBeNull();
  });

  it("rejects a currency it does not know", () => {
    expect(verifyExtraction(email(), extraction({ currency: "XYZ" }), bancolombiaDef)).toBeNull();
    expect(verifyExtraction(email(), extraction({ currency: null }), bancolombiaDef)).toBeNull();
  });

  it("ignores an invented date and falls back to the arrival date", () => {
    const tx = verifyExtraction(email(), extraction({ date_text: "01/01/2020" }), bancolombiaDef);
    expect(tx?.tx_date).toBe("2026-08-12");
  });

  it("stores a refund negative", () => {
    const tx = verifyExtraction(email(), extraction({ is_refund: true }), bancolombiaDef);
    expect(tx?.amount_native).toBe(-47000);
  });
});

describe("vetTemplate", () => {
  const GOOD_PATTERN = template().text_pattern;

  /** What `verifyExtraction` independently derived; the pattern has to match it. */
  const expected: CandidateTransaction = {
    amount_native: 47000,
    native_currency: "COP",
    merchant: "TIENDA NUEVA SAS",
    tx_date: "2026-08-12",
    description_raw: BODY,
    account_name: bancolombiaDef.accountName,
    source: bancolombiaDef.syncSource,
    card_last4: "1234",
  };

  it("accepts a pattern that reproduces its own extraction", () => {
    const vetted = vetTemplate(email(), bancolombiaDef, extraction(), {
      outcome: "expense",
      expected,
    });
    expect(vetted?.template.text_pattern).toBe(GOOD_PATTERN);
    expect(vetted?.produced?.amount_native).toBe(47000);
  });

  it("stores nothing when the model wrote no pattern", () => {
    expect(
      vetTemplate(email(), bancolombiaDef, extraction({ text_regex: null }), {
        outcome: "expense",
        expected,
      }),
    ).toBeNull();
  });

  it("rejects a pattern without a named amount group", () => {
    expect(
      vetTemplate(email(), bancolombiaDef, extraction({ text_regex: "Compraste \\$[\\d.,]+" }), {
        outcome: "expense",
        expected,
      }),
    ).toBeNull();
  });

  /** A pattern that cannot parse its own email would cost an AI call forever. */
  it("rejects a pattern that does not match the email it came from", () => {
    expect(
      vetTemplate(
        email(),
        bancolombiaDef,
        extraction({ text_regex: "Pagaste \\$(?<amount>[\\d.,]+) a" }),
        { outcome: "expense", expected },
      ),
    ).toBeNull();
  });

  it("rejects a pattern that reads a different amount than the verified one", () => {
    expect(
      vetTemplate(
        email(),
        bancolombiaDef,
        // Captures the "1234" of the card instead of the amount.
        extraction({ text_regex: "T\\.Deb \\*(?<amount>\\d{4})" }),
        { outcome: "expense", expected },
      ),
    ).toBeNull();
  });

  /**
   * A pattern that drops the date would file every future email of this format
   * under the day it arrived instead of the day of the purchase.
   */
  it("rejects a pattern that loses the date", () => {
    expect(
      vetTemplate(
        email({ internalDate: "1786719600000" }), // arrived two days later
        bancolombiaDef,
        extraction({ text_regex: "Compraste \\$(?<amount>[\\d.,]+)" }),
        { outcome: "expense", expected },
      ),
    ).toBeNull();
  });

  it("does not store a template when the currency is undetermined", () => {
    expect(
      vetTemplate(email(), bancolombiaDef, extraction({ currency: null }), {
        outcome: "expense",
        expected,
      }),
    ).toBeNull();
  });

  it("accepts an ignore pattern that matches its own email, and produces nothing", () => {
    const vetted = vetTemplate(
      email(),
      bancolombiaDef,
      extraction({ text_regex: "Compraste \\$[\\d.,]+ en" }),
      { outcome: "ignore" },
    );
    expect(vetted?.template.outcome).toBe("ignore");
    expect(vetted?.produced).toBeNull();
  });

  it("rejects an ignore pattern that does not match its own email", () => {
    expect(
      vetTemplate(email(), bancolombiaDef, extraction({ text_regex: "Pagaste \\$[\\d.,]+ a" }), {
        outcome: "ignore",
      }),
    ).toBeNull();
  });
});
