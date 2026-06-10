import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CandidateTransaction } from "../types";
import { evaluateCandidate, type ConsumptionMap } from "../dedup-sync";

// Mock the supabase admin client
vi.mock("../../push-ingest/supabase-admin", () => ({
  getSupabaseAdmin: vi.fn(),
}));

import { getSupabaseAdmin } from "../../push-ingest/supabase-admin";

/**
 * Creates a mock Supabase client with chainable query builder.
 * Allows configuring what `transactions` and `push_ingest_log` return.
 */
function createMockSupabase(opts: {
  transactions?: Array<{ id: string; merchant: string | null; amount_native: number; tx_date: string; description_raw: string }>;
  pushLogs?: Array<{ dedup_key: string; amount_native: number }>;
}) {
  const txData = opts.transactions ?? [];
  const pushData = opts.pushLogs ?? [];

  const mockChain = {
    from: vi.fn(),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
  };

  // Track calls to .from() and resolve differently based on table
  mockChain.from.mockImplementation((table: string) => {
    if (table === "transactions") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              gte: vi.fn().mockReturnValue({
                lte: vi.fn().mockResolvedValue({ data: txData, error: null }),
              }),
            }),
          }),
        }),
      };
    }
    if (table === "push_ingest_log") {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              gte: vi.fn().mockReturnValue({
                lte: vi.fn().mockResolvedValue({ data: pushData, error: null }),
              }),
            }),
          }),
        }),
      };
    }
    return mockChain;
  });

  return mockChain;
}

describe("Multiplicity — Req 7.9", () => {
  const userId = "user-1";
  const monthStart = "2026-05-01";
  const monthEnd = "2026-05-31";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("batch with 2 identical candidates + 1 existing → 1 discard + 1 insert", async () => {
    // 1 existing transaction in DB matching the candidates
    const existingTx = {
      id: "tx-existing-1",
      merchant: "PQUE ECOLOGICO",
      amount_native: 9500,
      tx_date: "2026-05-31",
      description_raw: "Compraste $9.500 en PQUE ECOLOGICO con tu T.Deb *5685",
    };

    const mockSupabase = createMockSupabase({
      transactions: [existingTx],
      pushLogs: [],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as any);

    // 2 identical candidates (same amount, date, merchant)
    const candidate: CandidateTransaction = {
      amount_native: 9500,
      native_currency: "COP",
      merchant: "PQUE ECOLOGICO",
      tx_date: "2026-05-31",
      description_raw: "Compraste $9.500 en PQUE ECOLOGICO con tu T.Deb *5685",
      account_name: "Bancolombia Débito",
      source: "sync_gmail_bancolombia",
    };

    // Shared consumption map for the batch
    const consumptionMap: ConsumptionMap = new Map();

    // First candidate: should discard (matches the 1 existing transaction)
    const decision1 = await evaluateCandidate(
      candidate,
      userId,
      monthStart,
      monthEnd,
      consumptionMap
    );

    expect(decision1.action).toBe("discard");
    expect(consumptionMap.get("tx-existing-1")).toBe(1);

    // Second candidate (identical): existing is now consumed → should insert
    const decision2 = await evaluateCandidate(
      candidate,
      userId,
      monthStart,
      monthEnd,
      consumptionMap
    );

    expect(decision2.action).toBe("insert");
  });

  it("3 identical candidates + 2 existing → 2 discards + 1 insert", async () => {
    const existingTxs = [
      {
        id: "tx-existing-1",
        merchant: "PQUE ECOLOGICO",
        amount_native: 9500,
        tx_date: "2026-05-31",
        description_raw: "Compra $9500 PQUE ECOLOGICO",
      },
      {
        id: "tx-existing-2",
        merchant: "PQUE ECOLOGICO",
        amount_native: 9500,
        tx_date: "2026-05-31",
        description_raw: "Compra $9500 PQUE ECOLOGICO",
      },
    ];

    const mockSupabase = createMockSupabase({
      transactions: existingTxs,
      pushLogs: [],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as any);

    const candidate: CandidateTransaction = {
      amount_native: 9500,
      native_currency: "COP",
      merchant: "PQUE ECOLOGICO",
      tx_date: "2026-05-31",
      description_raw: "Compra $9500 PQUE ECOLOGICO",
      account_name: "Bancolombia Débito",
      source: "sync_gmail_bancolombia",
    };

    const consumptionMap: ConsumptionMap = new Map();

    // First candidate → discard (matches existing-1)
    const d1 = await evaluateCandidate(candidate, userId, monthStart, monthEnd, consumptionMap);
    expect(d1.action).toBe("discard");

    // Second candidate → discard (matches existing-2)
    const d2 = await evaluateCandidate(candidate, userId, monthStart, monthEnd, consumptionMap);
    expect(d2.action).toBe("discard");

    // Third candidate → insert (both existing consumed)
    const d3 = await evaluateCandidate(candidate, userId, monthStart, monthEnd, consumptionMap);
    expect(d3.action).toBe("insert");
  });

  it("without consumptionMap, all identical candidates discard against the same existing", async () => {
    const existingTx = {
      id: "tx-existing-1",
      merchant: "PQUE ECOLOGICO",
      amount_native: 9500,
      tx_date: "2026-05-31",
      description_raw: "Compra $9500 PQUE ECOLOGICO",
    };

    const mockSupabase = createMockSupabase({
      transactions: [existingTx],
      pushLogs: [],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as any);

    const candidate: CandidateTransaction = {
      amount_native: 9500,
      native_currency: "COP",
      merchant: "PQUE ECOLOGICO",
      tx_date: "2026-05-31",
      description_raw: "Compra $9500 PQUE ECOLOGICO",
      account_name: "Bancolombia Débito",
      source: "sync_gmail_bancolombia",
    };

    // Without consumptionMap: both candidates would discard (old behavior — no multiplicity)
    const d1 = await evaluateCandidate(candidate, userId, monthStart, monthEnd);
    const d2 = await evaluateCandidate(candidate, userId, monthStart, monthEnd);

    expect(d1.action).toBe("discard");
    expect(d2.action).toBe("discard");
  });

  it("card_last4 match also tracks consumption", async () => {
    const existingTx = {
      id: "tx-card-1",
      merchant: "DIFFERENT MERCHANT",
      amount_native: 7500,
      tx_date: "2026-06-09",
      description_raw: "Compra en PERGAMINO con T.Deb *5685",
    };

    const mockSupabase = createMockSupabase({
      transactions: [existingTx],
      pushLogs: [],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as any);

    const candidate: CandidateTransaction = {
      amount_native: 7500,
      native_currency: "COP",
      merchant: "PERGAMINO VIVA ENVIG",
      tx_date: "2026-06-09",
      description_raw: "Compraste $7.500 en PERGAMINO VIVA ENVIG con tu T.Deb *5685",
      account_name: "Bancolombia Débito",
      source: "sync_gmail_bancolombia",
    };

    const consumptionMap: ConsumptionMap = new Map();

    // First: discard by card_last4 match (level 1)
    const d1 = await evaluateCandidate(candidate, userId, monthStart, monthEnd, consumptionMap);
    expect(d1.action).toBe("discard");
    expect(d1).toHaveProperty("reason", "duplicate_card_match");
    expect(consumptionMap.get("tx-card-1")).toBe(1);

    // Second: existing consumed → insert
    const d2 = await evaluateCandidate(candidate, userId, monthStart, monthEnd, consumptionMap);
    expect(d2.action).toBe("insert");
  });
});
