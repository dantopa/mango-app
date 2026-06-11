/**
 * End-to-end validation with real-world data.
 *
 * Simulates the full month scenario by calling `resolveDuplicate` in chronological
 * order as events arrive, progressively building up the transaction pool.
 *
 * This validates that the dedup engine produces correct net results:
 *   - PERGAMINO ×1 (sync wins, push discarded)
 *   - COYO TAC ×1 in COP (Google Wallet COP wins, BBVA USD discarded)
 *   - Two genuine identical purchases are NOT collapsed
 *
 * Validates: Requirements 4.1, 5.4, 6.4
 */

import { describe, it, expect } from "vitest";
import {
  resolveDuplicate,
  type DedupCandidate,
  type DedupOpts,
} from "../dedup-core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dummySupabase = {} as any;

// ---------------------------------------------------------------------------
// Helper types & utilities
// ---------------------------------------------------------------------------

interface SimulatedTx {
  id: string;
  merchant: string | null;
  amount_native: number;
  native_currency: string;
  amount_usd: number | null;
  card_last4: string | null;
  tx_date: string;
  external_ts: string | null;
  description_raw: string | null;
}

let nextId = 1;
function generateId(prefix: string): string {
  return `${prefix}-${nextId++}`;
}

/** Simulate "inserting" a candidate into the transaction pool */
function candidateToTx(candidate: DedupCandidate, id: string): SimulatedTx {
  return {
    id,
    merchant: candidate.merchant,
    amount_native: candidate.amount_native,
    native_currency: candidate.native_currency,
    amount_usd: candidate.amount_usd,
    card_last4: candidate.card_last4,
    tx_date: candidate.tx_date,
    external_ts: candidate.external_ts,
    description_raw: null,
  };
}

function resolve(
  candidate: DedupCandidate,
  existingTxs: SimulatedTx[],
  opts?: Partial<DedupOpts>
) {
  return resolveDuplicate(candidate, "user-pato", dummySupabase, {
    _prefetchedTxs: existingTxs,
    ...opts,
  });
}

// ===========================================================================
// Full month simulation — chronological event replay
// ===========================================================================

describe("Real-data validation: full month chronological replay", () => {
  it("produces exactly 2 net transactions for 2 distinct purchases (PERGAMINO + COYO TAC)", async () => {
    // Progressive transaction pool — starts empty, grows as events insert
    const pool: SimulatedTx[] = [];
    // Track claimed transaction IDs (push multiplicity)
    const claimedTxIds: string[] = [];

    // -----------------------------------------------------------------------
    // Event 1: Sync Bancolombia runs first (03:42)
    // Inserts PERGAMINO COP 7500 into transactions — this is a fresh insert (pool empty)
    // -----------------------------------------------------------------------
    const syncPergamino: DedupCandidate = {
      amount_native: 7500,
      native_currency: "COP",
      amount_usd: 2.08,
      merchant: "COMPRA EN PERGAMINO VIVA ENVIG",
      card_last4: "5685",
      tx_date: "2025-06-09",
      external_ts: null, // sync doesn't have real timestamp
    };

    const decision1 = await resolve(syncPergamino, pool);
    expect(decision1.action).toBe("insert");

    // Sync inserts it → add to pool
    const txPergamino = candidateToTx(syncPergamino, generateId("tx-sync"));
    txPergamino.description_raw =
      "Compraste $7.500,00 en PERGAMINO VIVA ENVIG con tu T.Deb *5685, el 09/06/2025 a las 03:42.";
    pool.push(txPergamino);

    // -----------------------------------------------------------------------
    // Event 2: Push Google Wallet arrives (23:23:30)
    // "BOLD SA*COYO TAC" COP 63400 card *1886 — first of its kind → insert
    // -----------------------------------------------------------------------
    const pushCoyoCOP: DedupCandidate = {
      amount_native: 63400,
      native_currency: "COP",
      amount_usd: 17.63,
      merchant: "BOLD SA*COYO TAC",
      card_last4: "1886",
      tx_date: "2025-06-09",
      external_ts: "2025-06-09T23:23:30Z",
    };

    const decision2 = await resolve(pushCoyoCOP, pool);
    expect(decision2.action).toBe("insert");

    // Push inserts it → add to pool
    const txCoyo = candidateToTx(pushCoyoCOP, generateId("tx-push"));
    txCoyo.description_raw = "BOLD SA*COYO TAC - COP63,400.00 con Debito Mastercard ••1886";
    pool.push(txCoyo);

    // -----------------------------------------------------------------------
    // Event 3: Push BBVA arrives (23:23:33)
    // "BOLD SA*COYO TAC" USD 17.70 card *1886 → should discard (cross-currency match)
    // -----------------------------------------------------------------------
    const pushCoyoUSD: DedupCandidate = {
      amount_native: 17.70,
      native_currency: "USD",
      amount_usd: 17.70,
      merchant: "BOLD SA*COYO TAC",
      card_last4: "1886",
      tx_date: "2025-06-09",
      external_ts: "2025-06-09T23:23:33Z",
    };

    const decision3 = await resolve(pushCoyoUSD, pool);
    expect(decision3.action).toBe("discard");
    if (decision3.action === "discard") {
      expect(decision3.reason).toBe("cross_currency_card_match");
      expect(decision3.matchedTxId).toBe(txCoyo.id);
      claimedTxIds.push(decision3.matchedTxId);
    }

    // Discarded → pool does NOT grow
    expect(pool.length).toBe(2);

    // -----------------------------------------------------------------------
    // Event 4: Push Google Wallet arrives (23:23:33)
    // "PERGAMINO VIVA ENVIGAD" COP 7500 → should discard (sync already has it)
    // -----------------------------------------------------------------------
    const pushPergamino: DedupCandidate = {
      amount_native: 7500,
      native_currency: "COP",
      amount_usd: 2.08,
      merchant: "PERGAMINO VIVA ENVIGAD",
      card_last4: "5685",
      tx_date: "2025-06-09",
      external_ts: "2025-06-09T23:23:33Z",
    };

    const decision4 = await resolve(pushPergamino, pool);
    expect(decision4.action).toBe("discard");
    if (decision4.action === "discard") {
      expect(decision4.matchedTxId).toBe(txPergamino.id);
    }

    // Discarded → pool stays at 2
    expect(pool.length).toBe(2);

    // -----------------------------------------------------------------------
    // Final assertions: net result for the month
    // -----------------------------------------------------------------------
    expect(pool.length).toBe(2);

    // PERGAMINO: exactly 1 transaction
    const pergaminoTxs = pool.filter(
      (tx) => tx.merchant?.includes("PERGAMINO")
    );
    expect(pergaminoTxs.length).toBe(1);
    expect(pergaminoTxs[0].native_currency).toBe("COP");
    expect(pergaminoTxs[0].amount_native).toBe(7500);

    // COYO TAC: exactly 1 transaction in COP
    const coyoTxs = pool.filter((tx) => tx.merchant?.includes("COYO TAC"));
    expect(coyoTxs.length).toBe(1);
    expect(coyoTxs[0].native_currency).toBe("COP");
    expect(coyoTxs[0].amount_native).toBe(63400);
  });
});

// ===========================================================================
// Multiplicity: two genuine identical purchases (same merchant, same day)
// ===========================================================================

describe("Real-data validation: two genuine PERGAMINO purchases same day", () => {
  it("morning + evening purchases with push+sync each → net = 2 transactions", async () => {
    const pool: SimulatedTx[] = [];
    const claimedTxIds: string[] = [];

    // -----------------------------------------------------------------------
    // Morning purchase: sync Bancolombia inserts first
    // -----------------------------------------------------------------------
    const syncMorning: DedupCandidate = {
      amount_native: 7500,
      native_currency: "COP",
      amount_usd: 2.08,
      merchant: "COMPRA EN PERGAMINO VIVA ENVIG",
      card_last4: "5685",
      tx_date: "2025-06-09",
      external_ts: null,
    };

    const d1 = await resolve(syncMorning, pool);
    expect(d1.action).toBe("insert");
    const txMorning = candidateToTx(syncMorning, generateId("tx-morning"));
    txMorning.description_raw =
      "Compraste $7.500,00 en PERGAMINO VIVA ENVIG con tu T.Deb *5685, el 09/06/2025 a las 08:30.";
    pool.push(txMorning);

    // -----------------------------------------------------------------------
    // Morning push notification arrives → should discard against morning sync
    // -----------------------------------------------------------------------
    const pushMorning: DedupCandidate = {
      amount_native: 7500,
      native_currency: "COP",
      amount_usd: 2.08,
      merchant: "PERGAMINO VIVA ENVIGAD",
      card_last4: "5685",
      tx_date: "2025-06-09",
      external_ts: "2025-06-09T08:30:05Z",
    };

    const d2 = await resolve(pushMorning, pool, { excludeClaimedTxIds: claimedTxIds });
    expect(d2.action).toBe("discard");
    if (d2.action === "discard") {
      expect(d2.matchedTxId).toBe(txMorning.id);
      claimedTxIds.push(d2.matchedTxId);
    }

    // Pool stays at 1
    expect(pool.length).toBe(1);

    // -----------------------------------------------------------------------
    // Evening purchase: sync Bancolombia inserts second
    // This is a GENUINE second purchase — it should NOT deduplicate against the morning one
    // because the sync engine processes in batch with consumptionMap
    // -----------------------------------------------------------------------
    // Simulate sync batch: both morning and evening arrive together. 
    // The sync evaluateCandidate uses consumptionMap to not collapse them.
    // Here we simulate the result: evening sync also gets inserted.
    const syncEvening: DedupCandidate = {
      amount_native: 7500,
      native_currency: "COP",
      amount_usd: 2.08,
      merchant: "COMPRA EN PERGAMINO VIVA ENVIG",
      card_last4: "5685",
      tx_date: "2025-06-09",
      external_ts: null,
    };

    // Sync processes in batch: morning already consumed via consumptionMap
    const consumptionMap = new Map<string, boolean>();
    consumptionMap.set(txMorning.id, true); // morning already consumed in this batch

    const d3 = await resolve(syncEvening, pool, { consumptionMap });
    expect(d3.action).toBe("insert");
    const txEvening = candidateToTx(syncEvening, generateId("tx-evening"));
    txEvening.description_raw =
      "Compraste $7.500,00 en PERGAMINO VIVA ENVIG con tu T.Deb *5685, el 09/06/2025 a las 18:45.";
    pool.push(txEvening);

    // -----------------------------------------------------------------------
    // Evening push notification arrives → should discard against evening sync
    // -----------------------------------------------------------------------
    const pushEvening: DedupCandidate = {
      amount_native: 7500,
      native_currency: "COP",
      amount_usd: 2.08,
      merchant: "PERGAMINO VIVA ENVIGAD",
      card_last4: "5685",
      tx_date: "2025-06-09",
      external_ts: "2025-06-09T18:45:05Z",
    };

    // Morning tx is already claimed → excluded. Should match evening tx.
    const d4 = await resolve(pushEvening, pool, { excludeClaimedTxIds: claimedTxIds });
    expect(d4.action).toBe("discard");
    if (d4.action === "discard") {
      expect(d4.matchedTxId).toBe(txEvening.id);
      claimedTxIds.push(d4.matchedTxId);
    }

    // -----------------------------------------------------------------------
    // Final assertions: two genuine purchases = 2 transactions
    // -----------------------------------------------------------------------
    expect(pool.length).toBe(2);

    const pergaminoTxs = pool.filter(
      (tx) => tx.merchant?.includes("PERGAMINO")
    );
    expect(pergaminoTxs.length).toBe(2);

    // Both are COP 7500
    expect(pergaminoTxs[0].amount_native).toBe(7500);
    expect(pergaminoTxs[0].native_currency).toBe("COP");
    expect(pergaminoTxs[1].amount_native).toBe(7500);
    expect(pergaminoTxs[1].native_currency).toBe("COP");

    // They are two different transactions (different IDs)
    expect(pergaminoTxs[0].id).not.toBe(pergaminoTxs[1].id);
  });
});
