import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { applyTemplate, tryTemplateParser, llmFallbackParser, type ParserTemplate } from "./llm-fallback";
import { isWhitelistedPackage } from "../package-whitelist";
import type { AccountCandidate } from "../account-resolver";
import type { PushPayload } from "../types";

vi.mock("../supabase-admin", () => ({
  getSupabaseAdmin: () => mockSupabase,
}));

// --- Minimal Supabase fake -----------------------------------------------------
// Every builder method returns the same awaitable object, so any chain of
// select/eq/order/limit resolves to the seeded rows for that table.

let tables: Record<string, unknown[]> = {};
let inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
let updated: Array<{ table: string; patch: Record<string, unknown> }> = [];
let insertError: { code?: string; message: string } | null = null;

function makeQuery(table: string) {
  const query = {
    select: () => query,
    eq: () => query,
    neq: () => query,
    order: () => query,
    limit: () => query,
    maybeSingle: () => Promise.resolve({ data: (tables[table] ?? [])[0] ?? null, error: null }),
    insert: (row: Record<string, unknown>) => {
      inserted.push({ table, row });
      return Promise.resolve({ data: null, error: insertError });
    },
    update: (patch: Record<string, unknown>) => {
      updated.push({ table, patch });
      return { eq: () => Promise.resolve({ data: null, error: null }) };
    },
    then: (resolve: (value: { data: unknown[]; error: null }) => void) =>
      resolve({ data: tables[table] ?? [], error: null }),
  };
  return query;
}

const mockSupabase = { from: (table: string) => makeQuery(table) };

function reset(seed: Record<string, unknown[]> = {}) {
  tables = seed;
  inserted = [];
  updated = [];
  insertError = null;
}

function template(overrides: Partial<ParserTemplate> = {}): ParserTemplate {
  return {
    id: "t1",
    text_pattern: "compra en (?<merchant>.+?) por \\$ (?<amount>[\\d.,]+) fue exitosa",
    title_pattern: null,
    amount_group: null,
    merchant_group: null,
    currency: "COP",
    account_name: "Rappi",
    outcome: "expense",
    hit_count: 0,
    ...overrides,
  };
}

const rappiPayload: PushPayload = {
  packageName: "com.grability.rappi",
  title: "RappiCard",
  text: "Tu compra en EXITO por $ 33.300 fue exitosa",
  timestamp: Date.now(),
};

describe("isWhitelistedPackage (shared PACKAGE_WHITELIST)", () => {
  it("returns true for known financial packages", () => {
    expect(isWhitelistedPackage("com.grability.rappi")).toBe(true);
    expect(isWhitelistedPackage("com.todo1.mobile")).toBe(true);
    expect(isWhitelistedPackage("com.nexowallet")).toBe(true);
    expect(isWhitelistedPackage("com.bbva.nxt_argentina")).toBe(true);
    expect(isWhitelistedPackage("com.nequi.MobileApp")).toBe(true);
    expect(isWhitelistedPackage("com.google.android.apps.walletnfcrel")).toBe(true);
  });

  it("returns false for unknown packages", () => {
    expect(isWhitelistedPackage("com.spotify.music")).toBe(false);
    expect(isWhitelistedPackage("com.whatsapp")).toBe(false);
    expect(isWhitelistedPackage("com.instagram.android")).toBe(false);
  });
});

// `applyTemplate` is the one place a stored pattern is executed — at read time
// and at save-time self-verification — so it carries the deterministic guarantees.
describe("applyTemplate", () => {
  it("extracts amount and merchant from named groups", () => {
    const result = applyTemplate(template(), rappiPayload);
    expect(result).toEqual({
      kind: "transaction",
      tx: expect.objectContaining({
        amount_native: 33300,
        native_currency: "COP",
        merchant: "EXITO",
        account_name: "Rappi",
      }),
    });
  });

  it("still supports positional groups for hand-written templates", () => {
    const result = applyTemplate(
      template({
        text_pattern: "compra en (.+?) por \\$ ([\\d.,]+) fue exitosa",
        amount_group: 2,
        merchant_group: 1,
      }),
      rappiPayload,
    );
    if (result.kind !== "transaction") throw new Error(`expected a transaction, got "${result.kind}"`);
    expect(result.tx.amount_native).toBe(33300);
    expect(result.tx.merchant).toBe("EXITO");
  });

  it("uses the template currency to disambiguate a single separator", () => {
    // "16,91" is sixteen dollars ninety-one; the same digits are not a valid COP
    // amount, because pesos group in threes and have no cents.
    const payload = { ...rappiPayload, text: "Compra por USD16,91" };
    const pattern = "por USD(?<amount>[\\d.,]+)";

    const asUsd = applyTemplate(template({ currency: "USD", text_pattern: pattern }), payload);
    if (asUsd.kind !== "transaction") throw new Error("expected a transaction");
    expect(asUsd.tx.amount_native).toBe(16.91);

    const asCop = applyTemplate(template({ currency: "COP", text_pattern: pattern }), payload);
    expect(asCop.kind).toBe("no_match");
  });

  it("stores a refund template as a negative amount", () => {
    const result = applyTemplate(template({ outcome: "refund" }), rappiPayload);
    if (result.kind !== "transaction") throw new Error("expected a transaction");
    expect(result.tx.amount_native).toBe(-33300);
  });

  it("returns ignore for an outcome=ignore template without needing an amount", () => {
    const result = applyTemplate(
      template({ outcome: "ignore", text_pattern: "compra en" }),
      rappiPayload,
    );
    expect(result.kind).toBe("ignore");
  });

  it("does not match when the title pattern fails", () => {
    const result = applyTemplate(template({ title_pattern: "^Bancolombia$" }), rappiPayload);
    expect(result.kind).toBe("no_match");
  });

  it("does not match when the text pattern fails", () => {
    const result = applyTemplate(template({ text_pattern: "completely different (?<amount>\\d+)" }), rappiPayload);
    expect(result.kind).toBe("no_match");
  });

  it("refuses an invalid regex instead of throwing", () => {
    expect(applyTemplate(template({ text_pattern: "([unclosed" }), rappiPayload).kind).toBe("no_match");
  });

  it("refuses a pattern with nested quantifiers", () => {
    expect(applyTemplate(template({ text_pattern: "(.+)+(?<amount>\\d+)" }), rappiPayload).kind).toBe("no_match");
  });

  it("picks up the card digits from the text", () => {
    const result = applyTemplate(
      template({ text_pattern: "(?<amount>[\\d.,]+) con Debito Mastercard" }),
      { ...rappiPayload, text: "COP7,500.00 con Debito Mastercard ••5685" },
    );
    if (result.kind !== "transaction") throw new Error("expected a transaction");
    expect(result.tx.card_last4).toBe("5685");
  });
});

describe("tryTemplateParser", () => {
  beforeEach(() => reset({ push_parser_templates: [] }));

  it("reports unknown when no templates exist", async () => {
    const result = await tryTemplateParser(rappiPayload, "u1");
    expect(result.kind).toBe("unknown");
  });

  it("reports unknown when no template matches", async () => {
    reset({ push_parser_templates: [template({ text_pattern: "nope (?<amount>\\d+)" })] });
    const result = await tryTemplateParser(rappiPayload, "u1");
    expect(result.kind).toBe("unknown");
  });

  it("parses with a matching template and advances hit_count", async () => {
    reset({ push_parser_templates: [template({ hit_count: 5 })] });
    const result = await tryTemplateParser(rappiPayload, "u1");

    if (result.kind !== "transaction") throw new Error(`expected a transaction, got "${result.kind}"`);
    expect(result.tx.amount_native).toBe(33300);
    expect(result.tx.merchant).toBe("EXITO");
    // Regression: hit_count used to be missing from the select, so this always
    // wrote 1 and no template ever looked used.
    expect(updated).toHaveLength(1);
    expect(updated[0].patch.hit_count).toBe(6);
  });

  it("honours an ignore template", async () => {
    reset({ push_parser_templates: [template({ outcome: "ignore", text_pattern: "compra en" })] });
    const result = await tryTemplateParser(rappiPayload, "u1");
    expect(result.kind).toBe("ignore");
  });
});

describe("llmFallbackParser", () => {
  const payload: PushPayload = {
    packageName: "com.nequi.MobileApp",
    title: "Nequi",
    text: "Pagaste $25.000 en Rappi",
    timestamp: Date.now(),
  };

  const accounts: AccountCandidate[] = [
    { id: "a1", name: "Nequi", native_currency: "COP", card_digits: [] },
  ];

  /** Response the model would give for `payload`, with per-test overrides. */
  function response(overrides: Record<string, unknown> = {}) {
    return {
      understood: true,
      is_transaction: true,
      is_refund: false,
      reason: "purchase",
      amount_text: "$25.000",
      currency: "COP",
      merchant: "Rappi",
      account_name: "Nequi",
      text_regex: "Pagaste (?<amount>\\$[\\d.,]+) en (?<merchant>.+)",
      ...overrides,
    };
  }

  function mockOpenAi(body: unknown) {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(body) } }] }),
    } as Response);
  }

  beforeEach(() => {
    reset({ push_parser_templates: [] });
    process.env.OPENAI_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENAI_API_KEY;
  });

  it("reports unknown when OPENAI_API_KEY is not set", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await llmFallbackParser(payload, "u1", accounts);
    expect(result.kind).toBe("unknown");
  });

  it("computes the amount itself and stores a self-verified template", async () => {
    mockOpenAi(response());
    const result = await llmFallbackParser(payload, "u1", accounts);

    if (result.kind !== "transaction") throw new Error(`expected a transaction, got "${result.kind}"`);
    // 25.000 COP is twenty-five thousand pesos — the model never supplies the number.
    expect(result.tx.amount_native).toBe(25000);
    expect(result.tx.native_currency).toBe("COP");
    expect(result.tx.merchant).toBe("Rappi");
    expect(result.tx.account_name).toBe("Nequi");

    expect(inserted).toHaveLength(1);
    expect(inserted[0].row).toMatchObject({
      package_name: "com.nequi.MobileApp",
      outcome: "expense",
      currency: "COP",
      source_text: payload.text,
    });
  });

  it("rejects an amount the notification does not contain", async () => {
    mockOpenAi(response({ amount_text: "$999.999" }));
    const result = await llmFallbackParser(payload, "u1", accounts);
    expect(result.kind).toBe("unknown");
    expect(inserted).toHaveLength(0);
  });

  it("discards an account name that does not exist", async () => {
    mockOpenAi(response({ account_name: "Cuenta Inventada" }));
    const result = await llmFallbackParser(payload, "u1", accounts);

    if (result.kind !== "transaction") throw new Error("expected a transaction");
    expect(result.tx.account_name).toBe("");
  });

  it("does not guess when the model says it did not understand", async () => {
    mockOpenAi(response({ understood: false }));
    const result = await llmFallbackParser(payload, "u1", accounts);
    expect(result.kind).toBe("unknown");
    expect(inserted).toHaveLength(0);
  });

  it("stores an ignore template for a non-transactional notification", async () => {
    mockOpenAi(
      response({
        is_transaction: false,
        reason: "declined purchase",
        amount_text: null,
        text_regex: "Pagaste",
      }),
    );
    const result = await llmFallbackParser(payload, "u1", accounts);

    expect(result).toEqual({ kind: "ignore", reason: "declined purchase" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].row).toMatchObject({ outcome: "ignore" });
  });

  it("registers a refund as a negative amount", async () => {
    mockOpenAi(response({ is_refund: true }));
    const result = await llmFallbackParser(payload, "u1", accounts);

    if (result.kind !== "transaction") throw new Error("expected a transaction");
    expect(result.tx.amount_native).toBe(-25000);
    expect(inserted[0].row).toMatchObject({ outcome: "refund" });
  });

  it("keeps the transaction but stores no template when the pattern fails to reproduce it", async () => {
    mockOpenAi(response({ text_regex: "Recibiste (?<amount>[\\d.,]+)" }));
    const result = await llmFallbackParser(payload, "u1", accounts);

    expect(result.kind).toBe("transaction");
    expect(inserted).toHaveLength(0);
  });

  it("stores no template when the pattern has no named amount group", async () => {
    mockOpenAi(response({ text_regex: "Pagaste \\$([\\d.,]+) en (.+)" }));
    const result = await llmFallbackParser(payload, "u1", accounts);

    expect(result.kind).toBe("transaction");
    expect(inserted).toHaveLength(0);
  });

  it("rejects a response that does not match the schema", async () => {
    mockOpenAi({ is_expense: true, amount: 25000 });
    const result = await llmFallbackParser(payload, "u1", accounts);
    expect(result.kind).toBe("unknown");
  });

  it("rejects an unknown currency", async () => {
    mockOpenAi(response({ currency: "XYZ" }));
    const result = await llmFallbackParser(payload, "u1", accounts);
    expect(result.kind).toBe("unknown");
  });

  it("reports unknown when the OpenAI API fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 500 } as Response);
    const result = await llmFallbackParser(payload, "u1", accounts);
    expect(result.kind).toBe("unknown");
  });

  it("reports unknown when the request throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));
    const result = await llmFallbackParser(payload, "u1", accounts);
    expect(result.kind).toBe("unknown");
  });
});
