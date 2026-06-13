import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PushPayload, ParsedTransaction } from "./types";

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
  resolveDuplicate: vi.fn(() => ({ action: "insert", reason: "no match" })),
}));

vi.mock("./parsers/llm-fallback", () => ({
  isFinancialPackage: vi.fn(() => false),
  shouldTryLlmFallback: vi.fn(() => false),
  tryTemplateParser: vi.fn(() => null),
  llmFallbackParser: vi.fn(() => null),
}));

vi.mock("./parsers", () => ({}));

// ---------------------------------------------------------------------------
// Supabase mock — configurable per test
// ---------------------------------------------------------------------------

const GOOGLE_WALLET_PACKAGE = "com.google.android.apps.walletnfcrel";
const RAPPI_PACKAGE = "com.grability.rappi";
const BANCOLOMBIA_PACKAGE = "com.bancolombia.app";

// Configurable return values for per-test control
let mockTransactionsSelectResult: { data: unknown[]; error: null } = { data: [], error: null };
let mockIngestLogSelectResult: { data: unknown[]; error: null } = { data: [], error: null };

const mockDeleteEq = vi.fn().mockResolvedValue({ data: null, error: null });
const mockDelete = vi.fn(() => ({ eq: mockDeleteEq }));
const mockUpdateEq = vi.fn().mockResolvedValue({ data: null, error: null });
const mockUpdate = vi.fn(() => ({ eq: mockUpdateEq }));
const mockInsert = vi.fn().mockResolvedValue({ data: null, error: null });
const mockInsertSelectSingle = vi.fn().mockResolvedValue({ data: { id: "tx-new-001" }, error: null });
const mockInsertSelect = vi.fn(() => ({ select: () => ({ single: mockInsertSelectSingle }) }));

/** Creates a chainable mock that resolves to a given value at any terminal point */
function createChainableMock(resolvedValue: { data: unknown[]; error: null }): ReturnType<typeof vi.fn> {
  const chainable: Record<string, unknown> = {};
  const handler = vi.fn((): typeof chainable => chainable);
  chainable.eq = handler;
  chainable.neq = handler;
  chainable.gte = handler;
  chainable.lte = handler;
  chainable.in = handler;
  chainable.not = handler;
  chainable.single = vi.fn().mockResolvedValue(resolvedValue);
  chainable.then = (resolve: (v: typeof resolvedValue) => void, reject?: (e: unknown) => void) =>
    Promise.resolve(resolvedValue).then(resolve, reject);
  return handler;
}

const mockSupabase = {
  from: vi.fn((table: string) => {
    if (table === "accounts") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({
            data: [
              { id: "acc-rappi", name: "Rappi" },
              { id: "acc-wallet", name: "Google Wallet" },
              { id: "acc-bancolombia", name: "Bancolombia" },
            ],
            error: null,
          }),
        }),
      };
    }
    if (table === "transactions") {
      const selectChain = createChainableMock(mockTransactionsSelectResult);
      return {
        insert: mockInsertSelect,
        select: vi.fn(() => ({
          eq: selectChain,
          neq: selectChain,
          gte: selectChain,
          lte: selectChain,
          in: selectChain,
          not: selectChain,
          single: vi.fn().mockResolvedValue({ data: { id: "tx-new-001" }, error: null }),
          then: (resolve: (v: typeof mockTransactionsSelectResult) => void, reject?: (e: unknown) => void) =>
            Promise.resolve(mockTransactionsSelectResult).then(resolve, reject),
        })),
        delete: mockDelete,
      };
    }
    if (table === "push_ingest_log") {
      const selectChain = createChainableMock(mockIngestLogSelectResult);
      return {
        insert: mockInsert,
        update: mockUpdate,
        select: vi.fn(() => ({
          eq: selectChain,
          neq: selectChain,
          gte: selectChain,
          lte: selectChain,
          in: selectChain,
          not: selectChain,
          then: (resolve: (v: typeof mockIngestLogSelectResult) => void, reject?: (e: unknown) => void) =>
            Promise.resolve(mockIngestLogSelectResult).then(resolve, reject),
        })),
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
    // Default (push_raw_log, etc.)
    return {
      insert: mockInsert,
      update: mockUpdate,
      select: vi.fn(() => {
        const chain = createChainableMock({ data: [], error: null });
        return {
          eq: chain,
          neq: chain,
          gte: chain,
          lte: chain,
          in: chain,
          not: chain,
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

// ---------------------------------------------------------------------------
// Import modules after mocks
// ---------------------------------------------------------------------------

import { executePipeline } from "./pipeline";
import { getParser } from "./parser-registry";
import { isDuplicate } from "./dedup";
import { resolveRate } from "./fx";
import { classifyTransaction } from "./classifier";
import { resolveDuplicate } from "../sync/dedup-core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = Date.now();

function makeWalletPendingPayload(amount: number, merchant = "UBR* PENDING.UBER.COM"): PushPayload {
  return {
    packageName: GOOGLE_WALLET_PACKAGE,
    title: "Google Wallet",
    text: `${merchant} COP${amount}`,
    timestamp: now,
  };
}

function makeRappiPayload(amount: number, merchant = "Uber"): PushPayload {
  return {
    packageName: RAPPI_PACKAGE,
    title: "RappiCard",
    text: `Compra exitosa ${merchant} $${amount.toLocaleString("es-CO")}`,
    timestamp: now,
  };
}

function makeWalletPayload(amount: number, merchant = "UBER *TRIP"): PushPayload {
  return {
    packageName: GOOGLE_WALLET_PACKAGE,
    title: "Google Wallet",
    text: `${merchant} COP${amount}`,
    timestamp: now,
  };
}

function makeBancolombiaPayload(amount: number, merchant = "Uber"): PushPayload {
  return {
    packageName: BANCOLOMBIA_PACKAGE,
    title: "Bancolombia",
    text: `Compra por $${amount.toLocaleString("es-CO")} en ${merchant}`,
    timestamp: now,
  };
}

function parsedFromPayload(payload: PushPayload, opts: { merchant: string; amount: number; accountName: string }): ParsedTransaction {
  return {
    amount_native: opts.amount,
    native_currency: "COP",
    merchant: opts.merchant,
    tx_date: "2025-01-15",
    description_raw: payload.text,
    account_name: opts.accountName,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Wallet dedup — PENDING cleanup (Fix 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransactionsSelectResult = { data: [], error: null };
    mockIngestLogSelectResult = { data: [], error: null };
    vi.mocked(isDuplicate).mockResolvedValue(false);
    vi.mocked(resolveRate).mockResolvedValue({ ok: true, rate: 0.00024 });
    vi.mocked(resolveDuplicate).mockResolvedValue({ action: "insert", reason: "no match" });
    vi.mocked(classifyTransaction).mockResolvedValue({ type: "expense" });
  });

  it("Uber ride: Rappi notifies first, then Wallet PENDING → deletes Rappi tx and returns pending_cleanup", async () => {
    // Rappi already registered tx "tx-rappi-uber" for $7020
    // Now Google Wallet sends PENDING notification with same amount
    const walletPayload = makeWalletPendingPayload(7020);
    const pendingParsed = parsedFromPayload(walletPayload, {
      merchant: "UBR* PENDING.UBER.COM",
      amount: 7020,
      accountName: "Google Wallet",
    });

    vi.mocked(getParser).mockReturnValue(() => pendingParsed);

    // Transactions query returns the existing Rappi tx (within 120 min window)
    mockTransactionsSelectResult = {
      data: [{ id: "tx-rappi-uber" }],
      error: null,
    };

    const result = await executePipeline(walletPayload, "full_pipeline");

    expect(result.status).toBe("pending_cleanup");
    // Should have called delete on the matching transaction
    expect(mockDelete).toHaveBeenCalled();
    expect(mockDeleteEq).toHaveBeenCalledWith("id", "tx-rappi-uber");
    // Should have updated push_ingest_log with status pending_cleanup
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("PENDING arrives but no matching transaction exists → returns pending_cleanup (discards without deleting)", async () => {
    const walletPayload = makeWalletPendingPayload(5000);
    const pendingParsed = parsedFromPayload(walletPayload, {
      merchant: "UBR* PENDING.UBER.COM",
      amount: 5000,
      accountName: "Google Wallet",
    });

    vi.mocked(getParser).mockReturnValue(() => pendingParsed);

    // No matching transactions
    mockTransactionsSelectResult = { data: [], error: null };

    const result = await executePipeline(walletPayload, "full_pipeline");

    expect(result.status).toBe("pending_cleanup");
    // Should NOT have called delete (nothing to delete)
    expect(mockDeleteEq).not.toHaveBeenCalled();
  });

  it("PENDING matches by amount but transaction is older than 120 min → returns pending_cleanup without deleting", async () => {
    // The gte filter in the pipeline restricts to 120 min window.
    // Since our chainable mock returns whatever mockTransactionsSelectResult is set to,
    // we simulate "outside window" by returning empty (the DB would filter it out).
    const walletPayload = makeWalletPendingPayload(7020);
    const pendingParsed = parsedFromPayload(walletPayload, {
      merchant: "UBR* PENDING.UBER.COM",
      amount: 7020,
      accountName: "Google Wallet",
    });

    vi.mocked(getParser).mockReturnValue(() => pendingParsed);

    // Simulates: gte filter excludes old tx → empty result
    mockTransactionsSelectResult = { data: [], error: null };

    const result = await executePipeline(walletPayload, "full_pipeline");

    expect(result.status).toBe("pending_cleanup");
    expect(mockDeleteEq).not.toHaveBeenCalled();
  });

  it("PENDING with different amount than existing → returns pending_cleanup (amount mismatch filtered by DB)", async () => {
    // Existing tx has $7020, PENDING comes for $8000. The eq filter on amount_native
    // means the DB returns nothing for $8000.
    const walletPayload = makeWalletPendingPayload(8000);
    const pendingParsed = parsedFromPayload(walletPayload, {
      merchant: "UBR* PENDING.UBER.COM",
      amount: 8000,
      accountName: "Google Wallet",
    });

    vi.mocked(getParser).mockReturnValue(() => pendingParsed);

    // No match (different amount filtered by eq)
    mockTransactionsSelectResult = { data: [], error: null };

    const result = await executePipeline(walletPayload, "full_pipeline");

    expect(result.status).toBe("pending_cleanup");
    expect(mockDeleteEq).not.toHaveBeenCalled();
  });
});

describe("Wallet dedup — 3-minute echo dedup (Fix 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransactionsSelectResult = { data: [], error: null };
    mockIngestLogSelectResult = { data: [], error: null };
    vi.mocked(isDuplicate).mockResolvedValue(false);
    vi.mocked(resolveRate).mockResolvedValue({ ok: true, rate: 0.00024 });
    vi.mocked(resolveDuplicate).mockResolvedValue({ action: "insert", reason: "no match" });
    vi.mocked(classifyTransaction).mockResolvedValue({ type: "expense" });
  });

  it("Rappi notifies first, then Wallet sends same amount within 3 min → returns deduped_wallet_echo", async () => {
    // Wallet sends "UBER *TRIP COP7525" 27 seconds after Rappi registered $7525
    const walletPayload = makeWalletPayload(7525);
    const walletParsed = parsedFromPayload(walletPayload, {
      merchant: "UBER *TRIP",
      amount: 7525,
      accountName: "Google Wallet",
    });

    vi.mocked(getParser).mockReturnValue(() => walletParsed);

    // Step 4.2: transactions query finds a recent tx with same amount (registered by Rappi)
    mockTransactionsSelectResult = {
      data: [{ id: "tx-rappi-001", created_at: new Date(now - 27_000).toISOString() }],
      error: null,
    };

    // push_ingest_log query: the existing tx was from a DIFFERENT package (Rappi)
    mockIngestLogSelectResult = {
      data: [{ transaction_id: "tx-rappi-001", package_name: RAPPI_PACKAGE }],
      error: null,
    };

    const result = await executePipeline(walletPayload, "full_pipeline");

    expect(result.status).toBe("deduped_wallet_echo");
    // Should have updated push_ingest_log with deduped_wallet_echo
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("Wallet notifies first, then Rappi sends same amount within 3 min → returns deduped_wallet_echo", async () => {
    // Rappi sends notification 40 seconds after Wallet already registered $7525
    const rappiPayload = makeRappiPayload(7525);
    const rappiParsed = parsedFromPayload(rappiPayload, {
      merchant: "Uber",
      amount: 7525,
      accountName: "Rappi",
    });

    vi.mocked(getParser).mockReturnValue(() => rappiParsed);

    // Step 4.2: transactions query finds a recent tx (registered by Wallet 40s ago)
    mockTransactionsSelectResult = {
      data: [{ id: "tx-wallet-001", created_at: new Date(now - 40_000).toISOString() }],
      error: null,
    };

    // push_ingest_log: the existing tx was from Google Wallet (DIFFERENT package than current Rappi)
    mockIngestLogSelectResult = {
      data: [{ transaction_id: "tx-wallet-001", package_name: GOOGLE_WALLET_PACKAGE }],
      error: null,
    };

    const result = await executePipeline(rappiPayload, "full_pipeline");

    expect(result.status).toBe("deduped_wallet_echo");
  });

  it("Same amount but more than 3 minutes apart → should NOT dedup, registers normally", async () => {
    // Wallet sends notification, but existing tx was registered 5 min ago.
    // The gte filter (3 min window) means DB returns nothing.
    const walletPayload = makeWalletPayload(7525);
    const walletParsed = parsedFromPayload(walletPayload, {
      merchant: "UBER *TRIP",
      amount: 7525,
      accountName: "Google Wallet",
    });

    vi.mocked(getParser).mockReturnValue(() => walletParsed);

    // No recent txs within 3 min (DB filters them out)
    mockTransactionsSelectResult = { data: [], error: null };
    mockIngestLogSelectResult = { data: [], error: null };

    const result = await executePipeline(walletPayload, "full_pipeline");

    expect(result.status).toBe("registered");
  });

  it("Same amount within 3 min but NEITHER is Google Wallet → should NOT trigger wallet echo", async () => {
    // Rappi registered, then Bancolombia sends same amount
    // Neither is Google Wallet → should NOT trigger deduped_wallet_echo
    const bancolombiaPayload = makeBancolombiaPayload(7525);
    const bancoParsed = parsedFromPayload(bancolombiaPayload, {
      merchant: "Uber",
      amount: 7525,
      accountName: "Bancolombia",
    });

    vi.mocked(getParser).mockReturnValue(() => bancoParsed);

    // Recent tx exists with same amount (from Rappi)
    mockTransactionsSelectResult = {
      data: [{ id: "tx-rappi-001", created_at: new Date(now - 30_000).toISOString() }],
      error: null,
    };

    // push_ingest_log: existing tx was from Rappi (different package than Bancolombia)
    // BUT neither Rappi nor Bancolombia is Google Wallet
    mockIngestLogSelectResult = {
      data: [{ transaction_id: "tx-rappi-001", package_name: RAPPI_PACKAGE }],
      error: null,
    };

    const result = await executePipeline(bancolombiaPayload, "full_pipeline");

    // Should NOT be deduped_wallet_echo — one side must be Google Wallet
    expect(result.status).toBe("registered");
  });

  it("Same amount within 3 min, same package (both Wallet) → should NOT trigger wallet echo", async () => {
    // Two Wallet notifications for same amount — handled by dedup_key, not wallet echo
    const walletPayload = makeWalletPayload(7525);
    const walletParsed = parsedFromPayload(walletPayload, {
      merchant: "UBER *TRIP",
      amount: 7525,
      accountName: "Google Wallet",
    });

    vi.mocked(getParser).mockReturnValue(() => walletParsed);

    // Recent tx exists with same amount
    mockTransactionsSelectResult = {
      data: [{ id: "tx-wallet-prev", created_at: new Date(now - 60_000).toISOString() }],
      error: null,
    };

    // push_ingest_log: existing tx was ALSO from Google Wallet (same package)
    // The .neq("package_name", payload.packageName) filter means DB returns empty
    mockIngestLogSelectResult = { data: [], error: null };

    const result = await executePipeline(walletPayload, "full_pipeline");

    // Should NOT be deduped — same package is excluded by neq filter
    expect(result.status).toBe("registered");
  });
});
