import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ParseResult, ParsedTransaction, PushPayload } from "./types";

// ---------------------------------------------------------------------------
// Mocks — all pipeline dependencies
// ---------------------------------------------------------------------------

vi.mock("./dedup", () => ({
  computeDedupKey: vi.fn(() => "dedup-key-wallet-test"),
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
  computeSemaphore: vi.fn(() => ({
    state: "verde",
    pct: 0.4,
    spent: 400,
    ceiling: 1000,
    expected_pct: 0.5,
    day: 15,
    days_in_month: 30,
  })),
}));

vi.mock("./alert", () => ({
  checkAndAlert: vi.fn(),
}));

vi.mock("./web-push", () => ({
  sendPushNotification: vi.fn(),
}));

vi.mock("../sync/dedup-core", () => ({
  resolveDuplicate: vi.fn(() => ({ action: "insert" })),
}));

vi.mock("./parsers/llm-fallback", () => ({
  shouldTryLlmFallback: vi.fn(() => false),
  tryTemplateParser: vi.fn(() => ({ kind: "unknown" })),
  llmFallbackParser: vi.fn(() => ({ kind: "unknown" })),
}));

vi.mock("./parsers", () => ({}));

// ---------------------------------------------------------------------------
// Supabase fake — every builder method returns the same object, so any chain
// resolves to the rows seeded for that table. Deletes and updates are recorded.
// ---------------------------------------------------------------------------

type QueryResult = { data: unknown; error: unknown };

let rows: Record<string, unknown[]> = {};
let deleted: Array<{ table: string; column: string; value: unknown }> = [];
let updates: Array<{ table: string; patch: Record<string, unknown> }> = [];

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
    insert: () => ({
      select: () => ({ single: () => Promise.resolve({ data: { id: "tx-new-001" }, error: null }) }),
      then: (resolve: (value: QueryResult) => void) => resolve({ data: null, error: null }),
    }),
    update: (patch: Record<string, unknown>) => {
      updates.push({ table, patch });
      return { eq: () => Promise.resolve({ data: null, error: null }) };
    },
    delete: () => ({
      eq: (column: string, value: unknown) => {
        deleted.push({ table, column, value });
        return Promise.resolve({ data: null, error: null });
      },
    }),
  };
  return query;
}

const mockSupabase = { from: (table: string) => makeQuery(table) };

vi.mock("./supabase-admin", () => ({
  getSupabaseAdmin: () => mockSupabase,
}));

// ---------------------------------------------------------------------------
// Import modules after mocks
// ---------------------------------------------------------------------------

import { executePipeline } from "./pipeline";
import { getParser } from "./parser-registry";
import { isDuplicate } from "./dedup";
import { resolveRate } from "./fx";
import { classifyTransaction } from "./classifier";
import { resolveDuplicate } from "../sync/dedup-core";
import { epochToLocalDate, TZ_OFFSETS } from "./dates";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GOOGLE_WALLET_PACKAGE = "com.google.android.apps.walletnfcrel";
const RAPPI_PACKAGE = "com.grability.rappi";
const BANCOLOMBIA_PACKAGE = "com.bancolombia.app";

const now = Date.now();
const today = epochToLocalDate(now, TZ_OFFSETS.BOGOTA);

const accounts = [
  { id: "acc-rappi", name: "Rappi", native_currency: "COP", card_digits: ["3679"] },
  { id: "acc-wallet", name: "Google Wallet", native_currency: "COP", card_digits: [] },
  { id: "acc-bancolombia", name: "Bancolombia", native_currency: "COP", card_digits: ["5685"] },
];

function payloadOf(packageName: string, title: string, text: string): PushPayload {
  return { packageName, title, text, timestamp: now };
}

/** Makes the deterministic parser return this transaction for the notification. */
function parserReturns(tx: Partial<ParsedTransaction> & { amount: number; accountName: string }): void {
  const parsed: ParsedTransaction = {
    amount_native: tx.amount,
    native_currency: "COP",
    merchant: tx.merchant ?? "Uber",
    tx_date: today,
    description_raw: "notification text",
    account_name: tx.accountName,
  };
  vi.mocked(getParser).mockReturnValue((): ParseResult => ({ kind: "transaction", tx: parsed }));
}

/** A prior transaction the DB would return inside the 3-minute echo window. */
function recentTransaction(id: string, secondsAgo: number) {
  return { id, created_at: new Date(now - secondsAgo * 1000).toISOString() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cross-package echo dedup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows = { accounts, transactions: [], push_ingest_log: [], user_settings: [{ budget_ceiling_usd: 1000 }] };
    deleted = [];
    updates = [];
    vi.mocked(isDuplicate).mockResolvedValue(false);
    vi.mocked(resolveRate).mockResolvedValue({ ok: true, rate: 0.00024 });
    vi.mocked(resolveDuplicate).mockResolvedValue({ action: "insert" });
    vi.mocked(classifyTransaction).mockResolvedValue({ type: "expense" });
  });

  it("discards the Wallet echo when Rappi registered the same amount seconds earlier", async () => {
    const walletPayload = payloadOf(GOOGLE_WALLET_PACKAGE, "UBER *TRIP", "COP7,525.00 con TARJETA NEGRA RAPPICARD CO ••3679");
    parserReturns({ amount: 7525, merchant: "UBER *TRIP", accountName: "Google Wallet" });
    rows.transactions = [recentTransaction("tx-rappi-001", 27)];
    rows.push_ingest_log = [{ transaction_id: "tx-rappi-001", package_name: RAPPI_PACKAGE }];

    const result = await executePipeline(walletPayload, "full_pipeline");

    expect(result.status).toBe("deduped_wallet_echo");
    expect(updates.some((u) => u.table === "push_ingest_log" && u.patch.status === "deduped_wallet_echo")).toBe(true);
    // The echo is dropped, never deleted — the first notification's transaction stands.
    expect(deleted).toHaveLength(0);
  });

  it("discards the Rappi echo when Wallet registered the same amount seconds earlier", async () => {
    const rappiPayload = payloadOf(RAPPI_PACKAGE, "RappiCard", "Tu compra en Uber por $ 7.525 fue exitosa");
    parserReturns({ amount: 7525, accountName: "Rappi" });
    rows.transactions = [recentTransaction("tx-wallet-001", 40)];
    rows.push_ingest_log = [{ transaction_id: "tx-wallet-001", package_name: GOOGLE_WALLET_PACKAGE }];

    const result = await executePipeline(rappiPayload, "full_pipeline");

    expect(result.status).toBe("deduped_wallet_echo");
  });

  it("registers normally when the earlier transaction is outside the 3-minute window", async () => {
    // The gte filter is what excludes it, so the DB returns nothing.
    const walletPayload = payloadOf(GOOGLE_WALLET_PACKAGE, "UBER *TRIP", "COP7,525.00 con TARJETA NEGRA RAPPICARD CO ••3679");
    parserReturns({ amount: 7525, merchant: "UBER *TRIP", accountName: "Google Wallet" });

    const result = await executePipeline(walletPayload, "full_pipeline");

    expect(result.status).toBe("registered");
  });

  it("does not dedup two non-Wallet sources: one side must be Google Wallet", async () => {
    const bancolombiaPayload = payloadOf(BANCOLOMBIA_PACKAGE, "Bancolombia", "Compra por $7.525 en Uber");
    parserReturns({ amount: 7525, accountName: "Bancolombia" });
    rows.transactions = [recentTransaction("tx-rappi-001", 30)];
    rows.push_ingest_log = [{ transaction_id: "tx-rappi-001", package_name: RAPPI_PACKAGE }];

    const result = await executePipeline(bancolombiaPayload, "full_pipeline");

    expect(result.status).toBe("registered");
  });

  it("does not dedup two notifications from the same package", async () => {
    // Same-package repeats are the dedup_key's job; the neq filter excludes them,
    // so the DB returns no cross-source match.
    const walletPayload = payloadOf(GOOGLE_WALLET_PACKAGE, "UBER *TRIP", "COP7,525.00 con TARJETA NEGRA RAPPICARD CO ••3679");
    parserReturns({ amount: 7525, merchant: "UBER *TRIP", accountName: "Google Wallet" });
    rows.transactions = [recentTransaction("tx-wallet-prev", 60)];
    rows.push_ingest_log = [];

    const result = await executePipeline(walletPayload, "full_pipeline");

    expect(result.status).toBe("registered");
  });

  it("registers a Wallet charge whose merchant contains 'PENDING'", async () => {
    // Regression: "UBR* PENDING.UBER.COM" used to be read as a Wallet pre-auth
    // placeholder, which discarded the charge and could delete an unrelated
    // transaction that happened to share amount, currency and date.
    const walletPayload = payloadOf(GOOGLE_WALLET_PACKAGE, "UBR* PENDING.UBER.COM", "COP7,020.00 con TARJETA NEGRA RAPPICARD CO ••3679");
    parserReturns({ amount: 7020, merchant: "UBR* PENDING.UBER.COM", accountName: "Google Wallet" });

    const result = await executePipeline(walletPayload, "full_pipeline");

    expect(result.status).toBe("registered");
    expect(deleted).toHaveLength(0);
  });
});
