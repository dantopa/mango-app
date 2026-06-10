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
 * Same pattern as multiplicity.test.ts.
 */
function createMockSupabase(opts: {
  transactions?: Array<{
    id: string;
    merchant: string | null;
    amount_native: number;
    tx_date: string;
    description_raw: string;
  }>;
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

describe("Dedup Regression — Req 7.6–7.12", () => {
  const userId = "user-1";
  const monthStart = "2026-06-01";
  const monthEnd = "2026-06-30";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────
  // (a) Wallet push 20:30 Bogotá + email Bancolombia del mismo gasto → 0 inserciones
  // ─────────────────────────────────────────────────────────────
  describe("(a) Cross-source dedup: wallet push + email Bancolombia", () => {
    it("same expense from wallet push and email Bancolombia → discard (duplicate_card_match)", async () => {
      // Existing transaction from wallet push (registered at 20:30 Bogotá = 01:30 UTC next day)
      // After fix 8.5, tx_date is correct Bogotá date
      const existingFromWalletPush = {
        id: "tx-wallet-push-1",
        merchant: "PERGAMINO VIVA ENVIGAD",
        amount_native: 7500,
        tx_date: "2026-06-09",
        description_raw:
          "PERGAMINO VIVA ENVIGAD - COP7,500.00 con Debito Mastercard ••5685",
      };

      const mockSupabase = createMockSupabase({
        transactions: [existingFromWalletPush],
        pushLogs: [],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as any);

      // Candidate from email Bancolombia (truncated merchant differently)
      const candidate: CandidateTransaction = {
        amount_native: 7500,
        native_currency: "COP",
        merchant: "PERGAMINO VIVA ENVIG",
        tx_date: "2026-06-09",
        description_raw:
          "Compraste $7.500,00 en PERGAMINO VIVA ENVIG con tu T.Deb *5685, el 09/06/2026 a las 15:29.",
        account_name: "Bancolombia",
        source: "sync_gmail_bancolombia",
        card_last4: "5685",
      };

      const consumptionMap: ConsumptionMap = new Map();
      const decision = await evaluateCandidate(
        candidate,
        userId,
        monthStart,
        monthEnd,
        consumptionMap
      );

      expect(decision.action).toBe("discard");
      expect(decision).toHaveProperty("reason", "duplicate_card_match");
    });
  });

  // ─────────────────────────────────────────────────────────────
  // (b) Same amount+date, divergent merchants, common card_last4 → discard level 1
  // ─────────────────────────────────────────────────────────────
  describe("(b) last4 wins over merchant no_match", () => {
    it("different merchants but same card_last4 + amount + date → discard level 1", async () => {
      // Existing transaction: "BOLD SA COYO TAC" (from wallet push)
      const existingTx = {
        id: "tx-bold-1",
        merchant: "BOLD SA COYO TAC",
        amount_native: 63400,
        tx_date: "2026-06-10",
        description_raw:
          "BOLD SA*COYO TAC - COP63,400.00 con Debito Mastercard ••5685",
      };

      const mockSupabase = createMockSupabase({
        transactions: [existingTx],
        pushLogs: [],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as any);

      // Candidate: "BOLD SA*COYO TACUARA" — different enough that compareMerchants → no_match
      // but same card_last4
      const candidate: CandidateTransaction = {
        amount_native: 63400,
        native_currency: "COP",
        merchant: "BOLD SA*COYO TACUARA",
        tx_date: "2026-06-10",
        description_raw:
          "Compraste $63.400,00 en BOLD SA*COYO TACUARA con tu T.Deb *5685, el 10/06/2026.",
        account_name: "Bancolombia",
        source: "sync_gmail_bancolombia",
        card_last4: "5685",
      };

      const consumptionMap: ConsumptionMap = new Map();
      const decision = await evaluateCandidate(
        candidate,
        userId,
        monthStart,
        monthEnd,
        consumptionMap
      );

      expect(decision.action).toBe("discard");
      expect(decision).toHaveProperty("reason", "duplicate_card_match");
    });
  });

  // ─────────────────────────────────────────────────────────────
  // (c) Property 8 — Date window: ±1 day discard, ±2 day insert
  // ─────────────────────────────────────────────────────────────
  describe("(c) Property 8: Date window ±1 day", () => {
    it("existing D, candidate D+1 + same amount + merchant match → discard", async () => {
      const existingTx = {
        id: "tx-date-window-1",
        merchant: "EXITO ENVIGADO",
        amount_native: 45000,
        tx_date: "2026-06-15",
        description_raw: "Compra EXITO ENVIGADO $45000",
      };

      const mockSupabase = createMockSupabase({
        transactions: [existingTx],
        pushLogs: [],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as any);

      // Candidate is D+1 (2026-06-16) — within ±1 day window
      const candidate: CandidateTransaction = {
        amount_native: 45000,
        native_currency: "COP",
        merchant: "EXITO ENVIGADO",
        tx_date: "2026-06-16",
        description_raw: "Compraste $45.000,00 en EXITO ENVIGADO el 16/06/2026.",
        account_name: "Bancolombia",
        source: "sync_gmail_bancolombia",
      };

      const decision = await evaluateCandidate(
        candidate,
        userId,
        monthStart,
        monthEnd
      );

      expect(decision.action).toBe("discard");
      expect(decision).toHaveProperty("reason", "duplicate_merchant_match");
    });

    it("existing D, candidate D+2 + same amount + merchant match → insert (out of window)", async () => {
      // The existing is at 2026-06-15. The candidate is at D+2 = 2026-06-17.
      // The ±1 window around candidate D+2 covers [D+1, D+3], so existing at D is OUT of range.
      // The DB query uses ±1 day around the CANDIDATE's date, so for candidate 2026-06-17:
      //   dateFrom = 2026-06-16, dateTo = 2026-06-18
      // Existing at 2026-06-15 won't be returned by the query → insert.
      const mockSupabase = createMockSupabase({
        transactions: [], // DB returns nothing since existing at D is outside candidate's ±1 window
        pushLogs: [],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as any);

      const candidate: CandidateTransaction = {
        amount_native: 45000,
        native_currency: "COP",
        merchant: "EXITO ENVIGADO",
        tx_date: "2026-06-17",
        description_raw: "Compraste $45.000,00 en EXITO ENVIGADO el 17/06/2026.",
        account_name: "Bancolombia",
        source: "sync_gmail_bancolombia",
      };

      const decision = await evaluateCandidate(
        candidate,
        userId,
        monthStart,
        monthEnd
      );

      expect(decision.action).toBe("insert");
    });
  });

  // ─────────────────────────────────────────────────────────────
  // (d) Property 9 — Multiplicidad conservadora: 2 existing + 2 candidates → 0 inserts
  // ─────────────────────────────────────────────────────────────
  describe("(d) Property 9: Multiplicidad conservadora — 2 existing + 2 candidates", () => {
    it("2 existing + 2 identical candidates → 2 discards + 0 inserts (net inserts = max(0, N-M) = 0)", async () => {
      const existingTxs = [
        {
          id: "tx-multi-1",
          merchant: "PQUE ECOLOGICO",
          amount_native: 9500,
          tx_date: "2026-06-08",
          description_raw: "Compra $9500 PQUE ECOLOGICO",
        },
        {
          id: "tx-multi-2",
          merchant: "PQUE ECOLOGICO",
          amount_native: 9500,
          tx_date: "2026-06-08",
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
        tx_date: "2026-06-08",
        description_raw: "Compraste $9.500,00 en PQUE ECOLOGICO el 08/06/2026.",
        account_name: "Bancolombia",
        source: "sync_gmail_bancolombia",
      };

      const consumptionMap: ConsumptionMap = new Map();

      // First candidate → discard (matches existing-1)
      const d1 = await evaluateCandidate(
        candidate,
        userId,
        monthStart,
        monthEnd,
        consumptionMap
      );
      expect(d1.action).toBe("discard");

      // Second candidate → discard (matches existing-2)
      const d2 = await evaluateCandidate(
        candidate,
        userId,
        monthStart,
        monthEnd,
        consumptionMap
      );
      expect(d2.action).toBe("discard");

      // Net inserts = max(0, 2 - 2) = 0
      // Both consumed
      expect(consumptionMap.get("tx-multi-1")).toBe(1);
      expect(consumptionMap.get("tx-multi-2")).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // (e) Property 10 — last4 wins: card match overrides merchant no_match
  // ─────────────────────────────────────────────────────────────
  describe("(e) Property 10: last4 wins over merchant no_match", () => {
    it("card_last4 match with completely unrelated merchants → discard by level 1", async () => {
      // Existing: a transaction with last4 "5685" embedded in description_raw
      const existingTx = {
        id: "tx-last4-1",
        merchant: "UBER EATS",
        amount_native: 25000,
        tx_date: "2026-06-12",
        description_raw: "UBER EATS - COP25,000.00 con Debito Mastercard ••5685",
      };

      const mockSupabase = createMockSupabase({
        transactions: [existingTx],
        pushLogs: [],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as any);

      // Candidate: completely unrelated merchant, but same card_last4
      const candidate: CandidateTransaction = {
        amount_native: 25000,
        native_currency: "COP",
        merchant: "RESTAURANTE EL CIELO",
        tx_date: "2026-06-12",
        description_raw:
          "Compraste $25.000,00 en RESTAURANTE EL CIELO con tu T.Deb *5685, el 12/06/2026.",
        account_name: "Bancolombia",
        source: "sync_gmail_bancolombia",
        card_last4: "5685",
      };

      const consumptionMap: ConsumptionMap = new Map();
      const decision = await evaluateCandidate(
        candidate,
        userId,
        monthStart,
        monthEnd,
        consumptionMap
      );

      // card_last4 match wins → discard, regardless of merchant comparison
      expect(decision.action).toBe("discard");
      expect(decision).toHaveProperty("reason", "duplicate_card_match");
    });

    it("without card_last4, same amount+date but unrelated merchants → insert_review (not discard)", async () => {
      // Existing without card info
      const existingTx = {
        id: "tx-no-card-1",
        merchant: "UBER EATS",
        amount_native: 25000,
        tx_date: "2026-06-12",
        description_raw: "Compra UBER EATS $25000",
      };

      const mockSupabase = createMockSupabase({
        transactions: [existingTx],
        pushLogs: [],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as any);

      // Candidate: unrelated merchant, no card_last4
      const candidate: CandidateTransaction = {
        amount_native: 25000,
        native_currency: "COP",
        merchant: "RESTAURANTE EL CIELO",
        tx_date: "2026-06-12",
        description_raw:
          "Compraste $25.000,00 en RESTAURANTE EL CIELO el 12/06/2026.",
        account_name: "Bancolombia",
        source: "sync_gmail_bancolombia",
      };

      const decision = await evaluateCandidate(
        candidate,
        userId,
        monthStart,
        monthEnd
      );

      // Without card_last4: different merchants → insert_review (level 4), not discard
      expect(decision.action).toBe("insert_review");
      expect(decision).toHaveProperty(
        "reason",
        "same_amount_date_different_merchant"
      );
    });
  });
});
