import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ParseResult, ParsedTransaction, PushPayload } from "./types";

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

// --- Supabase fake -------------------------------------------------------------
// Builder methods all return the same object, so any chain resolves to the rows
// seeded for that table. Inserts and updates are recorded for assertions.

type QueryResult = { data: unknown; error: unknown };

let rows: Record<string, unknown[]> = {};
let inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
let updates: Array<{ table: string; patch: Record<string, unknown> }> = [];
let insertErrors: Record<string, { code?: string; message: string }> = {};
let updateError: { message: string } | null = null;
let txInsertResult: QueryResult = { data: { id: "tx-001" }, error: null };

function makeQuery(table: string) {
  const first = () => Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null });
  const query = {
    select: () => query,
    eq: () => query,
    neq: () => query,
    gte: () => query,
    lte: () => query,
    in: () => query,
    not: () => query,
    order: () => query,
    limit: () => query,
    single: first,
    maybeSingle: first,
    then: (resolve: (value: QueryResult) => void) => resolve({ data: rows[table] ?? [], error: null }),
    insert: (row: Record<string, unknown>) => {
      inserts.push({ table, row });
      const result: QueryResult = { data: null, error: insertErrors[table] ?? null };
      return {
        select: () => ({ single: () => Promise.resolve(table === "transactions" ? txInsertResult : result) }),
        then: (resolve: (value: QueryResult) => void) => resolve(result),
      };
    },
    update: (patch: Record<string, unknown>) => {
      updates.push({ table, patch });
      return { eq: () => Promise.resolve({ data: null, error: updateError }) };
    },
    delete: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
  };
  return query;
}

const mockSupabase = { from: (table: string) => makeQuery(table) };

vi.mock("./supabase-admin", () => ({
  getSupabaseAdmin: () => mockSupabase,
}));

vi.mock("../sync/dedup-core", () => ({
  resolveDuplicate: vi.fn(() => ({ action: "insert" })),
}));

vi.mock("./parsers/llm-fallback", () => ({
  shouldTryLlmFallback: vi.fn(() => false),
  tryTemplateParser: vi.fn(() => ({ kind: "unknown" })),
  llmFallbackParser: vi.fn(() => ({ kind: "unknown" })),
}));

// Side-effect import mock (parsers registration)
vi.mock("./parsers", () => ({}));

import { executePipeline } from "./pipeline";
import { isDuplicate } from "./dedup";
import { getParser } from "./parser-registry";
import { resolveRate } from "./fx";
import { shouldTryLlmFallback, tryTemplateParser, llmFallbackParser } from "./parsers/llm-fallback";
import { classifyTransaction } from "./classifier";
import { resolveDuplicate } from "../sync/dedup-core";
import { epochToLocalDate, TZ_OFFSETS } from "./dates";

const OWNER_USER_ID = "e99371b1-6163-4216-b624-c79d8ee01520";

const basePayload: PushPayload = {
  packageName: "com.grability.rappi",
  title: "RappiCard",
  text: "Tu compra en EXITO por $ 33.300 fue exitosa",
  timestamp: Date.now(),
};

/** Today in Bogotá — the pipeline rejects transactions dated outside its window. */
const today = epochToLocalDate(Date.now(), TZ_OFFSETS.BOGOTA);

const parsedTx: ParsedTransaction = {
  amount_native: 33300,
  native_currency: "COP",
  merchant: "EXITO",
  tx_date: today,
  description_raw: "Tu compra en EXITO por $ 33.300 fue exitosa",
  account_name: "Rappi",
};

const accounts = [
  { id: "acc-001", name: "Rappi", native_currency: "COP", card_digits: ["3679"] },
  { id: "acc-002", name: "Nexo Card", native_currency: "USD", card_digits: ["4186"] },
];

function transactionOf(tx: ParsedTransaction): ParseResult {
  return { kind: "transaction", tx };
}

/** The row the pipeline tried to write into `transactions`, if any. */
function insertedTransaction(): Record<string, unknown> | undefined {
  return inserts.find((i) => i.table === "transactions")?.row;
}

/** The row the pipeline wrote into `push_ingest_log` to claim the notification. */
function claimedIngest(): Record<string, unknown> | undefined {
  return inserts.find((i) => i.table === "push_ingest_log")?.row;
}

describe("executePipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows = { accounts, transactions: [], push_ingest_log: [], user_settings: [] };
    inserts = [];
    updates = [];
    insertErrors = {};
    updateError = null;
    txInsertResult = { data: { id: "tx-001" }, error: null };

    vi.mocked(getParser).mockReturnValue(() => transactionOf(parsedTx));
    vi.mocked(isDuplicate).mockResolvedValue(false);
    vi.mocked(resolveRate).mockResolvedValue({ ok: true, rate: 0.00024 });
    vi.mocked(resolveDuplicate).mockResolvedValue({ action: "insert" });
    vi.mocked(classifyTransaction).mockResolvedValue({ type: "expense" });
    vi.mocked(tryTemplateParser).mockResolvedValue({ kind: "unknown" });
    vi.mocked(llmFallbackParser).mockResolvedValue({ kind: "unknown" });
    vi.mocked(shouldTryLlmFallback).mockReturnValue(false);
  });

  it("returns 'logged' for log_only mode", async () => {
    const result = await executePipeline(basePayload, "log_only");
    expect(result.status).toBe("logged");
  });

  it("returns 'duplicate' when dedup key already exists", async () => {
    vi.mocked(isDuplicate).mockResolvedValue(true);
    const result = await executePipeline(basePayload, "full_pipeline");
    expect(result.status).toBe("duplicate");
    if (result.status === "duplicate") expect(result.dedup_key).toBe("dedup-key-123");
  });

  it("treats a dedup_key insert conflict as the duplicate signal", async () => {
    // Two concurrent deliveries of the same notification: the read-then-write
    // check passes for both, and only the primary-key insert separates them.
    insertErrors = { push_ingest_log: { code: "23505", message: "duplicate key value" } };

    const result = await executePipeline(basePayload, "full_pipeline");

    expect(result.status).toBe("duplicate");
    expect(insertedTransaction()).toBeUndefined();
  });

  describe("parsing ladder", () => {
    it("returns 'no_parser' when nothing recognizes the notification", async () => {
      vi.mocked(getParser).mockReturnValue(undefined);

      const result = await executePipeline(basePayload, "full_pipeline");

      expect(result.status).toBe("no_parser");
      expect(llmFallbackParser).not.toHaveBeenCalled();
    });

    it("falls back to the template parser when the deterministic parser does not recognize the text", async () => {
      vi.mocked(getParser).mockReturnValue(() => ({ kind: "unknown" }));
      vi.mocked(tryTemplateParser).mockResolvedValue(transactionOf(parsedTx));

      const result = await executePipeline(basePayload, "full_pipeline");

      expect(result.status).toBe("registered");
      expect(tryTemplateParser).toHaveBeenCalledWith(basePayload, OWNER_USER_ID);
    });

    it("escalates to the AI with the real account list when nothing else matches", async () => {
      vi.mocked(getParser).mockReturnValue(() => ({ kind: "unknown" }));
      vi.mocked(shouldTryLlmFallback).mockReturnValue(true);
      vi.mocked(llmFallbackParser).mockResolvedValue(transactionOf(parsedTx));

      const result = await executePipeline(basePayload, "full_pipeline");

      expect(result.status).toBe("registered");
      expect(llmFallbackParser).toHaveBeenCalledWith(basePayload, OWNER_USER_ID, accounts);
    });

    it("never asks the AI about a notification a parser deliberately ignored", async () => {
      // 49 of ~55 BBVA notifications are "Compra rechazada". Escalating those is
      // how the AI came to invent expenses that never happened.
      vi.mocked(getParser).mockReturnValue(() => ({ kind: "ignore", reason: "declined purchase" }));
      vi.mocked(shouldTryLlmFallback).mockReturnValue(true);

      const result = await executePipeline(basePayload, "full_pipeline");

      expect(result).toEqual({ status: "ignored", reason: "declined purchase" });
      expect(tryTemplateParser).not.toHaveBeenCalled();
      expect(llmFallbackParser).not.toHaveBeenCalled();
      expect(insertedTransaction()).toBeUndefined();
      // Recorded, so a retry does not re-parse it and the volume stays measurable.
      expect(claimedIngest()).toMatchObject({ status: "ignored", error_message: "declined purchase" });
    });
  });

  describe("account resolution", () => {
    it("resolves the account by card digits when the name does not match", async () => {
      // This exact string is why 172 ingests failed: the account is "Nexo Card".
      vi.mocked(getParser).mockReturnValue(() =>
        transactionOf({
          ...parsedTx,
          native_currency: "USD",
          amount_native: 14.25,
          account_name: "Mastercard Nexo Card ••4186",
          card_last4: "4186",
        }),
      );

      const result = await executePipeline(basePayload, "full_pipeline");

      expect(result.status).toBe("registered");
      expect(insertedTransaction()).toMatchObject({ account_id: "acc-002" });
    });

    it("returns 'registration_failed' when the account cannot be resolved", async () => {
      vi.mocked(getParser).mockReturnValue(() =>
        transactionOf({ ...parsedTx, account_name: "NonExistent Bank", card_last4: null }),
      );

      const result = await executePipeline(basePayload, "full_pipeline");

      expect(result.status).toBe("registration_failed");
      if (result.status === "registration_failed") expect(result.error).toContain("Account not found");
      expect(insertedTransaction()).toBeUndefined();
    });

    it("takes the currency from the account when the notification only shows '$'", async () => {
      vi.mocked(getParser).mockReturnValue(() =>
        transactionOf({ ...parsedTx, native_currency: null, card_last4: "3679" }),
      );

      const result = await executePipeline(basePayload, "full_pipeline");

      expect(result.status).toBe("registered");
      expect(insertedTransaction()).toMatchObject({ native_currency: "COP" });
    });
  });

  describe("validation gate", () => {
    it("refuses an amount of 0 (a declined purchase, not an expense)", async () => {
      vi.mocked(getParser).mockReturnValue(() => transactionOf({ ...parsedTx, amount_native: 0 }));

      const result = await executePipeline(basePayload, "full_pipeline");

      expect(result.status).toBe("registration_failed");
      if (result.status === "registration_failed") expect(result.error).toContain("amount_native is 0");
      expect(insertedTransaction()).toBeUndefined();
    });

    it("refuses a transaction dated outside the ingest window", async () => {
      vi.mocked(getParser).mockReturnValue(() => transactionOf({ ...parsedTx, tx_date: "2024-01-15" }));

      const result = await executePipeline(basePayload, "full_pipeline");

      expect(result.status).toBe("registration_failed");
      expect(insertedTransaction()).toBeUndefined();
    });

    it("accepts an old transaction when reprocessing widens the window", async () => {
      const old = epochToLocalDate(Date.now() - 90 * 86_400_000, TZ_OFFSETS.BOGOTA);
      vi.mocked(getParser).mockReturnValue(() => transactionOf({ ...parsedTx, tx_date: old }));

      const result = await executePipeline(basePayload, "full_pipeline", { maxPastDays: 365 });

      expect(result.status).toBe("registered");
    });
  });

  it("returns 'fx_pending' when FX rate resolution fails", async () => {
    vi.mocked(resolveRate).mockResolvedValue({ ok: false, reason: "error" });
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
    if (result.status === "registered") expect(result.transaction_id).toBe("tx-001");
  });

  it("logs the error when the ingest log status update is rejected", async () => {
    // Regression guard: rejected status writes used to be discarded, which is how
    // a stale CHECK constraint kept 55 rows stuck on "processing" for two months.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    updateError = { message: 'violates check constraint "chk_ingest_status"' };

    const result = await executePipeline(basePayload, "full_pipeline");

    expect(result.status).toBe("registered");
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("update to status=registered failed"),
      'violates check constraint "chk_ingest_status"',
    );
    consoleError.mockRestore();
  });

  it("handles transfer classification (skips insertion)", async () => {
    vi.mocked(classifyTransaction).mockResolvedValue({ type: "transfer", is_payment: true });

    const result = await executePipeline(basePayload, "full_pipeline");

    expect(result.status).toBe("registered");
    if (result.status === "registered") expect(result.transaction_id).toBe("transfer-skipped");
    expect(insertedTransaction()).toBeUndefined();
  });

  it("returns 'registration_failed' when the transaction insert fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    txInsertResult = { data: null, error: { message: "null value in column" } };

    const result = await executePipeline(basePayload, "full_pipeline");

    expect(result.status).toBe("registration_failed");
    consoleError.mockRestore();
  });
});
