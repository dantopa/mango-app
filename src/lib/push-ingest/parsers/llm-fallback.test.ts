import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isFinancialPackage, tryTemplateParser, llmFallbackParser } from "./llm-fallback";
import type { PushPayload } from "../types";

// Mock the supabase admin
vi.mock("../supabase-admin", () => ({
  getSupabaseAdmin: () => mockSupabase,
}));

// Mock supabase client
const mockFrom = vi.fn();
const mockSupabase = { from: mockFrom };

function mockChain(data: unknown[] | null = null, error: unknown = null) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data, error }),
    // Terminal: when nothing else is chained, resolve
  };
  // Make each chainable method also resolve if awaited
  chain.select.mockReturnValue(chain);
  chain.insert.mockResolvedValue({ data, error });
  chain.update.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  // Final resolution for select chains
  Object.defineProperty(chain, "then", {
    value: (resolve: (val: unknown) => void) => resolve({ data, error }),
    configurable: true,
  });
  return chain;
}

describe("isFinancialPackage (uses shared PACKAGE_WHITELIST)", () => {
  it("returns true for known financial packages", () => {
    expect(isFinancialPackage("com.grability.rappi")).toBe(true);
    expect(isFinancialPackage("com.todo1.mobile")).toBe(true);
    expect(isFinancialPackage("com.nexowallet")).toBe(true);
    expect(isFinancialPackage("com.bbva.nxt_argentina")).toBe(true);
    expect(isFinancialPackage("com.nequi.MobileApp")).toBe(true);
    expect(isFinancialPackage("com.google.android.apps.walletnfcrel")).toBe(true);
  });

  it("returns false for unknown packages", () => {
    expect(isFinancialPackage("com.spotify.music")).toBe(false);
    expect(isFinancialPackage("com.whatsapp")).toBe(false);
    expect(isFinancialPackage("com.instagram.android")).toBe(false);
  });
});

describe("tryTemplateParser", () => {
  const payload: PushPayload = {
    packageName: "com.grability.rappi",
    title: "RappiCard",
    text: "Tu compra en EXITO por $ 33.300 fue exitosa",
    timestamp: Date.now(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no templates exist in DB", async () => {
    mockFrom.mockReturnValue(mockChain([]));
    const result = await tryTemplateParser(payload);
    expect(result).toBeNull();
  });

  it("returns null when templates don't match the text", async () => {
    const templates = [
      {
        id: "t1",
        text_pattern: "completely different pattern (\\d+)",
        title_pattern: null,
        amount_group: 1,
        merchant_group: null,
        currency: "COP",
        account_name: "Rappi",
        is_expense: true,
      },
    ];
    mockFrom.mockReturnValue(mockChain(templates));
    const result = await tryTemplateParser(payload);
    expect(result).toBeNull();
  });

  it("parses when a template matches the text", async () => {
    const templates = [
      {
        id: "t1",
        text_pattern: "compra en (.+?) por \\$ ([\\d.,]+) fue exitosa",
        title_pattern: null,
        amount_group: 2,
        merchant_group: 1,
        currency: "COP",
        account_name: "Rappi",
        is_expense: true,
        hit_count: 5,
      },
    ];
    // First call: select templates
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      then: undefined as unknown,
    };
    let eqCount = 0;
    selectChain.eq = vi.fn(() => {
      eqCount++;
      if (eqCount >= 2) {
        // After user_id and package_name, resolve
        return { then: (r: (v: unknown) => void) => r({ data: templates, error: null }) };
      }
      return selectChain;
    });
    selectChain.select = vi.fn(() => selectChain);

    // Second call: update hit count
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ data: null, error: null }),
    };

    let callCount = 0;
    mockFrom.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return selectChain;
      return updateChain;
    });

    const result = await tryTemplateParser(payload);
    expect(result).not.toBeNull();
    expect(result!.amount_native).toBe(33300);
    expect(result!.merchant).toBe("EXITO");
    expect(result!.native_currency).toBe("COP");
    expect(result!.account_name).toBe("Rappi");
  });

  it("returns null for matching template where is_expense=false", async () => {
    const templates = [
      {
        id: "t1",
        text_pattern: "compra en (.+?) por \\$ ([\\d.,]+) fue exitosa",
        title_pattern: null,
        amount_group: 2,
        merchant_group: 1,
        currency: "COP",
        account_name: "Rappi",
        is_expense: false, // Not an expense — delivery notification template
        hit_count: 3,
      },
    ];
    mockFrom.mockReturnValue(mockChain(templates));
    const result = await tryTemplateParser(payload);
    expect(result).toBeNull();
  });

  it("skips template when title_pattern doesn't match", async () => {
    const templates = [
      {
        id: "t1",
        text_pattern: "compra en (.+?) por \\$ ([\\d.,]+) fue exitosa",
        title_pattern: "^Bancolombia$", // Won't match "RappiCard"
        amount_group: 2,
        merchant_group: 1,
        currency: "COP",
        account_name: "Bancolombia",
        is_expense: true,
      },
    ];
    mockFrom.mockReturnValue(mockChain(templates));
    const result = await tryTemplateParser(payload);
    expect(result).toBeNull();
  });
});

describe("llmFallbackParser", () => {
  const payload: PushPayload = {
    packageName: "com.nequi.MobileApp",
    title: "Nequi",
    text: "Pagaste $25.000 en Rappi",
    timestamp: Date.now(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when OPENAI_API_KEY is not set", async () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const result = await llmFallbackParser(payload);
    expect(result).toBeNull();

    if (original) process.env.OPENAI_API_KEY = original;
  });

  it("returns parsed transaction on successful LLM response", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const llmResponse = {
      is_expense: true,
      amount: 25000,
      currency: "COP",
      merchant: "Rappi",
      account_name: "Nequi",
      text_regex: "Pagaste \\$(\\d[\\d.,]*) en (.+)",
      amount_group: 1,
      merchant_group: 2,
    };

    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(llmResponse) } }],
      }),
    } as Response);

    // Mock supabase for template save (existing check + insert)
    const chain = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    mockFrom.mockReturnValue(chain);

    const result = await llmFallbackParser(payload);
    expect(result).not.toBeNull();
    expect(result!.amount_native).toBe(25000);
    expect(result!.native_currency).toBe("COP");
    expect(result!.merchant).toBe("Rappi");
    expect(result!.account_name).toBe("Nequi");

    mockFetch.mockRestore();
    delete process.env.OPENAI_API_KEY;
  });

  it("returns null when LLM says is_expense=false", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const llmResponse = {
      is_expense: false,
      amount: null,
      currency: "COP",
      merchant: null,
      account_name: "Nequi",
      text_regex: "Tu.*fue (entregado|cancelado)",
      amount_group: 0,
      merchant_group: null,
    };

    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(llmResponse) } }],
      }),
    } as Response);

    const chain = {
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockResolvedValue({ data: null, error: null }),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    mockFrom.mockReturnValue(chain);

    const result = await llmFallbackParser(payload);
    expect(result).toBeNull();

    mockFetch.mockRestore();
    delete process.env.OPENAI_API_KEY;
  });

  it("returns null when OpenAI API returns error", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    const result = await llmFallbackParser(payload);
    expect(result).toBeNull();

    mockFetch.mockRestore();
    delete process.env.OPENAI_API_KEY;
  });

  it("returns null when fetch throws network error", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const mockFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Network error"),
    );

    const result = await llmFallbackParser(payload);
    expect(result).toBeNull();

    mockFetch.mockRestore();
    delete process.env.OPENAI_API_KEY;
  });
});
