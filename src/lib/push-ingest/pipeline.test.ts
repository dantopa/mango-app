import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PushPayload, ParsedTransaction } from "./types";

// Mock all dependencies before importing pipeline
vi.mock("./dedup", () => ({
  computeDedupKey: vi.fn(() => "dedup-key-123"),
  isDuplicate: vi.fn(() => false),
}));

vi.mock("./parser-registry", () => ({
  getParser: vi.fn(),
}));

vi.mock("./fx", () => ({
  resolveRate: vi.fn(() => ({ ok: true, rate: 0.00024 })),
  calculateUsd: vi.fn((amount: number, rate: number) => amount * rate),
}));

vi.mock("./categorizer", () => ({
  categorize: vi.fn(() => ({ matched: true, category_id: "cat-123" })),
}));

vi.mock("./ai-categorizer", () => ({
  categorizeWithAi: vi.fn(() => ({ matched: false })),
}));

vi.mock("./classifier", () => ({
  classifyTransaction: vi.fn(() => ({ type: "expense" })),
}));

vi.mock("./semaphore", () => ({
  computeSemaphore: vi.fn(() => ({ state: "verde", pct: 0.4, spent: 400, ceiling: 1000, expected_pct: 0.5, day: 15, days_in_month: 30 })),
}));

vi.mock("./alert", () => ({
  checkAndAlert: vi.fn(),
}));

vi.mock("./web-push", () => ({
  sendPushNotification: vi.fn(),
}));

const mockInsert = vi.fn().mockResolvedValue({ data: null, error: null });
const mockUpdateEq = vi.fn().mockResolvedValue({ data: null, error: null });
const mockUpdate = vi.fn(() => ({ eq: mockUpdateEq }));
const mockSelectSingle = vi.fn().mockResolvedValue({ data: { id: "tx-001" }, error: null });

/** Creates a deeply chainable mock that resolves to { data: [], error: null } at any terminal point */
function createChainableMock(resolvedValue = { data: [] as unknown[], error: null }): ReturnType<typeof vi.fn> {
  const chainable: Record<string, unknown> = {};
  const handler = vi.fn((): typeof chainable => chainable);
  chainable.eq = handler;
  chainable.neq = handler;
  chainable.gte = handler;
  chainable.lte = handler;
  chainable.in = handler;
  chainable.not = handler;
  chainable.single = vi.fn().mockResolvedValue(resolvedValue);
  // Make it thenable so awaiting the chain resolves
  chainable.then = (resolve: (v: typeof resolvedValue) => void, reject?: (e: unknown) => void) =>
    Promise.resolve(resolvedValue).then(resolve, reject);
  return handler;
}

const mockSelect = vi.fn(() => {
  const chain = createChainableMock({ data: [], error: null });
  return {
    single: mockSelectSingle,
    eq: chain,
    neq: chain,
    gte: chain,
    lte: chain,
    in: chain,
    not: chain,
    then: (resolve: (v: { data: unknown[]; error: null }) => void, reject?: (e: unknown) => void) =>
      Promise.resolve({ data: [] as unknown[], error: null }).then(resolve, reject),
  };
});
const mockInsertSelect = vi.fn(() => ({ select: () => ({ single: mockSelectSingle }) }));

const mockSupabase = {
  from: vi.fn((table: string) => {
    if (table === "accounts") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({
            data: [{ id: "acc-001", name: "Rappi" }, { id: "acc-002", name: "Nexo Card" }],
            error: null,
          }),
        }),
      };
    }
    if (table === "transactions") {
      return {
        insert: mockInsertSelect,
        select: mockSelect,
        delete: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) })),
      };
    }
    if (table === "user_settings") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { budget_ceiling_usd: 1000 }, error: null }),
          }),
        }),
      };
    }
    // push_ingest_log, push_raw_log — default
    return {
      insert: mockInsert,
      update: mockUpdate,
      select: vi.fn(() => {
        const chain = createChainableMock({ data: [], error: null });
        return {
          not: chain,
          eq: chain,
          neq: chain,
          gte: chain,
          lte: chain,
          in: chain,
          then: (resolve: (v: { data: unknown[]; error: null }) => void, reject?: (e: unknown) => void) =>
            Promise.resolve({ data: [] as unknown[], error: null }).then(resolve, reject),
        };
      }),
    };
  }),
};

vi.mock("./supabase-admin", () => ({
  getSupabaseAdmin: () => mockSupabase,
}));

vi.mock("../sync/dedup-core", () => ({
  resolveDuplicate: vi.fn(() => ({ action: "insert", reason: "no match" })),
}));

vi.mock("./parsers/llm-fallback", () => ({
  isFinancialPackage: vi.fn(() => false),
  tryTemplateParser: vi.fn(() => null),
  llmFallbackParser: vi.fn(() => null),
}));

// Side-effect import mock (parsers registration)
vi.mock("./parsers", () => ({}));

import { executePipeline } from "./pipeline";
import { isDuplicate } from "./dedup";
import { getParser } from "./parser-registry";
import { resolveRate } from "./fx";
import { isFinancialPackage, tryTemplateParser, llmFallbackParser } from "./parsers/llm-fallback";
import { classifyTransaction } from "./classifier";
import { resolveDuplicate } from "../sync/dedup-core";

const basePayload: PushPayload = {
  packageName: "com.grability.rappi",
  title: "RappiCard",
  text: "Tu compra en EXITO por $ 33.300 fue exitosa",
  timestamp: Date.now(),
};

const parsedTx: ParsedTransaction = {
  amount_native: 33300,
  native_currency: "COP",
  merchant: "EXITO",
  tx_date: "2026-06-11",
  description_raw: "Tu compra en EXITO por $ 33.300 fue exitosa",
  account_name: "Rappi",
};

describe("executePipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: parser returns a parsed transaction
    vi.mocked(getParser).mockReturnValue(() => parsedTx);
    vi.mocked(isDuplicate).mockResolvedValue(false);
    vi.mocked(resolveRate).mockResolvedValue({ ok: true, rate: 0.00024 });
    vi.mocked(resolveDuplicate).mockResolvedValue({ action: "insert", reason: "no match" });
    vi.mocked(classifyTransaction).mockResolvedValue({ type: "expense" });
  });

  it("returns 'logged' for log_only mode", async () => {
    const result = await executePipeline(basePayload, "log_only");
    expect(result.status).toBe("logged");
  });

  it("returns 'duplicate' when dedup key already exists", async () => {
    vi.mocked(isDuplicate).mockResolvedValue(true);
    const result = await executePipeline(basePayload, "full_pipeline");
    expect(result.status).toBe("duplicate");
    if (result.status === "duplicate") {
      expect(result.dedup_key).toBe("dedup-key-123");
    }
  });

  it("returns 'no_parser' when no parser matches and not financial", async () => {
    vi.mocked(getParser).mockReturnValue(undefined);
    vi.mocked(tryTemplateParser).mockResolvedValue(null);
    vi.mocked(isFinancialPackage).mockReturnValue(false);

    const result = await executePipeline(basePayload, "full_pipeline");
    expect(result.status).toBe("no_parser");
  });

  it("falls back to template parser when deterministic parser returns null", async () => {
    vi.mocked(getParser).mockReturnValue(() => null);
    vi.mocked(tryTemplateParser).mockResolvedValue(parsedTx);

    const result = await executePipeline(basePayload, "full_pipeline");
    expect(result.status).toBe("registered");
    expect(tryTemplateParser).toHaveBeenCalledWith(basePayload);
  });

  it("falls back to LLM when deterministic + template both fail for financial package", async () => {
    vi.mocked(getParser).mockReturnValue(() => null);
    vi.mocked(tryTemplateParser).mockResolvedValue(null);
    vi.mocked(isFinancialPackage).mockReturnValue(true);
    vi.mocked(llmFallbackParser).mockResolvedValue(parsedTx);

    const result = await executePipeline(basePayload, "full_pipeline");
    expect(result.status).toBe("registered");
    expect(llmFallbackParser).toHaveBeenCalledWith(basePayload);
  });

  it("returns 'fx_pending' when FX rate resolution fails", async () => {
    vi.mocked(resolveRate).mockResolvedValue({ ok: false, rate: 0 });

    const result = await executePipeline(basePayload, "full_pipeline");
    expect(result.status).toBe("fx_pending");
  });

  it("returns 'deduped_cross_source' when resolveDuplicate says discard", async () => {
    vi.mocked(resolveDuplicate).mockResolvedValue({
      action: "discard",
      reason: "exact match",
      matchedTxId: "existing-tx-001",
    });

    const result = await executePipeline(basePayload, "full_pipeline");
    expect(result.status).toBe("deduped_cross_source");
  });

  it("returns 'registered' with transaction_id on successful full pipeline", async () => {
    const result = await executePipeline(basePayload, "full_pipeline");
    expect(result.status).toBe("registered");
    if (result.status === "registered") {
      expect(result.transaction_id).toBe("tx-001");
    }
  });

  it("handles transfer classification (skips insertion)", async () => {
    vi.mocked(classifyTransaction).mockResolvedValue({ type: "transfer" });

    const result = await executePipeline(basePayload, "full_pipeline");
    expect(result.status).toBe("registered");
    if (result.status === "registered") {
      expect(result.transaction_id).toBe("transfer-skipped");
    }
  });

  it("returns 'registration_failed' when account not found", async () => {
    // Parser returns a parsed tx with unknown account
    const unknownAccountTx: ParsedTransaction = {
      ...parsedTx,
      account_name: "NonExistent Bank",
    };
    vi.mocked(getParser).mockReturnValue(() => unknownAccountTx);

    // Mock accounts to return empty list for the unknown name
    mockSupabase.from = vi.fn((table: string) => {
      if (table === "accounts") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [{ id: "acc-001", name: "Rappi" }], // No "NonExistent Bank"
              error: null,
            }),
          }),
        };
      }
      if (table === "transactions") {
        return {
          insert: mockInsert,
          select: mockSelect,
          delete: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) })),
        };
      }
      return {
        insert: mockInsert,
        update: mockUpdate,
        select: vi.fn(() => {
          const chain = createChainableMock({ data: [], error: null });
          return {
            not: chain,
            eq: chain,
            neq: chain,
            gte: chain,
            lte: chain,
            in: chain,
            then: (resolve: (v: { data: unknown[]; error: null }) => void, reject?: (e: unknown) => void) =>
              Promise.resolve({ data: [] as unknown[], error: null }).then(resolve, reject),
          };
        }),
      };
    });

    const result = await executePipeline(basePayload, "full_pipeline");
    expect(result.status).toBe("registration_failed");
    if (result.status === "registration_failed") {
      expect(result.error).toContain("Account not found");
    }
  });
});
