/**
 * Regression tests for the 3 real-world dedup bugs.
 *
 * These test resolveDuplicate() directly with realistic data matching
 * the actual cases that produced duplicates in production.
 *
 * Bug 1: PERGAMINO (sync→push) — same currency, different sources
 * Bug 2: COYO TAC (COP→USD) — cross-currency, push Google Wallet first
 * Bug 2 inverse: COYO TAC (USD→COP) — cross-currency, BBVA first → upgrade
 *
 * Validates: Requirements 3.1, 4.1, 5.2
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
// Helper: existing transaction shape
// ---------------------------------------------------------------------------

interface ExistingTx {
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

function resolve(
  candidate: DedupCandidate,
  existingTxs: ExistingTx[],
  opts?: Partial<DedupOpts>
) {
  return resolveDuplicate(candidate, "user-pato", dummySupabase, {
    _prefetchedTxs: existingTxs,
    ...opts,
  });
}

// ===========================================================================
// Bug 1: PERGAMINO — sync inserts first, push arrives later (same COP amount)
// ===========================================================================
// Req 3.1 (cross-source), Req 4.1 (push ve transactions de sync)

describe("Bug 1: PERGAMINO — sync→push dedup (same currency)", () => {
  // The existing transaction came from sync_bancolombia
  const existingFromSync: ExistingTx = {
    id: "tx-pergamino-sync-001",
    merchant: "COMPRA EN PERGAMINO VIVA ENVIG",
    amount_native: 7500,
    native_currency: "COP",
    amount_usd: 2.08, // FX at time of sync
    card_last4: "5685",
    tx_date: "2025-06-09",
    external_ts: null, // sync doesn't have external_ts
    description_raw:
      "Compraste $7.500,00 en PERGAMINO VIVA ENVIG con tu T.Deb *5685, el 09/06/2025 a las 03:42.",
  };

  it("push Google Wallet for same purchase → discard (level 2: merchant_match)", async () => {
    // Push candidate from Google Wallet notification
    const pushCandidate: DedupCandidate = {
      amount_native: 7500,
      native_currency: "COP",
      amount_usd: 2.08,
      merchant: "PERGAMINO VIVA ENVIGAD",
      card_last4: "5685",
      tx_date: "2025-06-09",
      external_ts: "2025-06-09T23:23:33Z", // real-time push notification
    };

    const decision = await resolve(pushCandidate, [existingFromSync]);

    // Should NOT insert a second copy. Level 1 (card match + same currency + same amount)
    // fires because card_last4 = "5685" on both sides.
    expect(decision.action).toBe("discard");
    if (decision.action === "discard") {
      expect(decision.reason).toBe("card_match");
      expect(decision.matchedTxId).toBe("tx-pergamino-sync-001");
    }
  });

  it("push without card_last4 still matches via merchant (level 2)", async () => {
    // Simulate a case where the push doesn't have card_last4
    const pushCandidateNoCard: DedupCandidate = {
      amount_native: 7500,
      native_currency: "COP",
      amount_usd: 2.08,
      merchant: "PERGAMINO VIVA ENVIGAD",
      card_last4: null,
      tx_date: "2025-06-09",
      external_ts: "2025-06-09T23:23:33Z",
    };

    // Existing also without card_last4 in the column (would fall to description_raw extraction)
    const existingNoCardCol: ExistingTx = {
      ...existingFromSync,
      card_last4: null, // column not populated yet
    };

    const decision = await resolve(pushCandidateNoCard, [existingNoCardCol]);

    // Level 2: same amount (7500 COP) + merchant match (PERGAMINO VIVA ENVIGAD ≈ PERGAMINO VIVA ENVIG)
    expect(decision.action).toBe("discard");
    if (decision.action === "discard") {
      expect(decision.reason).toBe("merchant_match");
      expect(decision.matchedTxId).toBe("tx-pergamino-sync-001");
    }
  });

  it("net result: 1 transaction for one PERGAMINO purchase", async () => {
    const pushCandidate: DedupCandidate = {
      amount_native: 7500,
      native_currency: "COP",
      amount_usd: 2.08,
      merchant: "PERGAMINO VIVA ENVIGAD",
      card_last4: "5685",
      tx_date: "2025-06-09",
      external_ts: "2025-06-09T23:23:33Z",
    };

    const decision = await resolve(pushCandidate, [existingFromSync]);

    // Discard = no new insert. Net = 1 existing transaction.
    expect(decision.action).not.toBe("insert");
    expect(decision.action).not.toBe("insert_review");
  });
});

// ===========================================================================
// Bug 2: COYO TAC — COP (Google Wallet) first, USD (BBVA) second
// ===========================================================================
// Req 3.1 (cross-currency), Req 5.2 (COP stays, USD discarded)

describe("Bug 2: COYO TAC — COP→USD cross-currency dedup", () => {
  // First push was Google Wallet COP 63400 — already in transactions
  const existingCOP: ExistingTx = {
    id: "tx-coyo-cop-001",
    merchant: "BOLD SA*COYO TAC",
    amount_native: 63400,
    native_currency: "COP",
    amount_usd: 17.63, // FX-converted
    card_last4: "1886",
    tx_date: "2025-06-09",
    external_ts: "2025-06-09T23:23:30Z",
    description_raw: "BOLD SA*COYO TAC - COP63,400.00 con Debito Mastercard ••1886",
  };

  it("second push BBVA USD → discard (level 1c: cross_currency_card_match)", async () => {
    // BBVA push arrives 3 seconds later with the same purchase in USD
    const bbvaPush: DedupCandidate = {
      amount_native: 17.70,
      native_currency: "USD",
      amount_usd: 17.70,
      merchant: "BOLD SA*COYO TAC",
      card_last4: "1886",
      tx_date: "2025-06-09",
      external_ts: "2025-06-09T23:23:33Z", // 3s after existing
    };

    const decision = await resolve(bbvaPush, [existingCOP]);

    // Level 1c: card_last4 match + merchant match + external_ts within 90s + USD ±5%
    // COP (existing) has higher quality (local POS currency) → candidate USD is worse → discard
    expect(decision.action).toBe("discard");
    if (decision.action === "discard") {
      expect(decision.reason).toBe("cross_currency_card_match");
      expect(decision.matchedTxId).toBe("tx-coyo-cop-001");
    }
  });

  it("net result: 1 transaction in COP (local POS currency wins)", async () => {
    const bbvaPush: DedupCandidate = {
      amount_native: 17.70,
      native_currency: "USD",
      amount_usd: 17.70,
      merchant: "BOLD SA*COYO TAC",
      card_last4: "1886",
      tx_date: "2025-06-09",
      external_ts: "2025-06-09T23:23:33Z",
    };

    const decision = await resolve(bbvaPush, [existingCOP]);

    // Not an upgrade — existing COP is already the better version
    expect(decision.action).toBe("discard");
    // The existing transaction stays as COP 63400 (the ground truth POS amount)
  });
});

// ===========================================================================
// Bug 2 Inverse: COYO TAC — USD (BBVA) first, COP (Google Wallet) second → upgrade
// ===========================================================================
// Req 3.1 (cross-currency), Req 5.2 (upgrade to COP)

describe("Bug 2 Inverse: COYO TAC — USD→COP cross-currency upgrade", () => {
  // BBVA USD arrived first — it's the existing transaction
  const existingUSD: ExistingTx = {
    id: "tx-coyo-usd-001",
    merchant: "BOLD SA*COYO TAC",
    amount_native: 17.70,
    native_currency: "USD",
    amount_usd: 17.70,
    card_last4: "1886",
    tx_date: "2025-06-09",
    external_ts: "2025-06-09T23:23:30Z",
    description_raw: "BOLD SA*COYO TAC - USD17.70 con Mastercard ••1886",
  };

  it("second push Google Wallet COP → upgrade (COP has higher quality)", async () => {
    // Google Wallet COP push arrives 3 seconds later
    const googleWalletPush: DedupCandidate = {
      amount_native: 63400,
      native_currency: "COP",
      amount_usd: 17.63, // FX-converted (close to 17.70)
      merchant: "BOLD SA*COYO TAC",
      card_last4: "1886",
      tx_date: "2025-06-09",
      external_ts: "2025-06-09T23:23:33Z", // 3s after existing
    };

    const decision = await resolve(googleWalletPush, [existingUSD]);

    // Level 1c: cross-currency card match
    // COP candidate has local POS currency → higher quality → upgrade
    expect(decision.action).toBe("upgrade");
    if (decision.action === "upgrade") {
      expect(decision.reason).toBe("cross_currency_card_match");
      expect(decision.matchedTxId).toBe("tx-coyo-usd-001");
    }
  });

  it("net result: 1 transaction, final version in COP (ground truth POS amount)", async () => {
    const googleWalletPush: DedupCandidate = {
      amount_native: 63400,
      native_currency: "COP",
      amount_usd: 17.63,
      merchant: "BOLD SA*COYO TAC",
      card_last4: "1886",
      tx_date: "2025-06-09",
      external_ts: "2025-06-09T23:23:33Z",
    };

    const decision = await resolve(googleWalletPush, [existingUSD]);

    // Upgrade = UPDATE in-place of the existing record (id stays stable)
    // The transaction will be updated to COP 63400 (the real POS amount)
    expect(decision.action).toBe("upgrade");
    if (decision.action === "upgrade") {
      expect(decision.matchedTxId).toBe("tx-coyo-usd-001");
    }
  });
});

// ===========================================================================
// Multiplicity guard: two genuine PERGAMINO purchases same day
// ===========================================================================
// Req 6.1, 6.4

describe("Multiplicity: two genuine COP 7500 purchases same day", () => {
  // Two real PERGAMINO purchases on the same day, each with its own notification
  const existingPurchase1: ExistingTx = {
    id: "tx-pergamino-morning",
    merchant: "PERGAMINO VIVA ENVIGAD",
    amount_native: 7500,
    native_currency: "COP",
    amount_usd: 2.08,
    card_last4: "5685",
    tx_date: "2025-06-09",
    external_ts: "2025-06-09T10:15:00Z", // morning purchase
    description_raw: "PERGAMINO VIVA ENVIGAD - COP7,500.00 con Debito ••5685",
  };

  const existingPurchase2: ExistingTx = {
    id: "tx-pergamino-evening",
    merchant: "PERGAMINO VIVA ENVIGAD",
    amount_native: 7500,
    native_currency: "COP",
    amount_usd: 2.08,
    card_last4: "5685",
    tx_date: "2025-06-09",
    external_ts: "2025-06-09T19:30:00Z", // evening purchase (3h15m later)
    description_raw: "PERGAMINO VIVA ENVIGAD - COP7,500.00 con Debito ••5685",
  };

  it("push for 2nd purchase inserts when 1st purchase already claimed", async () => {
    // The first push already claimed purchase-1
    // Now a second push for a DIFFERENT purchase arrives
    const secondPurchasePush: DedupCandidate = {
      amount_native: 7500,
      native_currency: "COP",
      amount_usd: 2.08,
      merchant: "PERGAMINO VIVA ENVIGAD",
      card_last4: "5685",
      tx_date: "2025-06-09",
      external_ts: "2025-06-09T19:30:05Z", // evening, close to purchase 2
    };

    // Only purchase 1 exists in DB. Purchase-1 already claimed by another notification.
    const decision = await resolve(
      secondPurchasePush,
      [existingPurchase1],
      { excludeClaimedTxIds: ["tx-pergamino-morning"] }
    );

    // All matching transactions are claimed → insert (new genuine purchase)
    expect(decision.action).toBe("insert");
  });

  it("two notifications, two existing → each claims its own (net = 2 transactions)", async () => {
    const bothExisting = [existingPurchase1, existingPurchase2];

    // First notification (morning purchase) → discards against purchase 1
    const morningPush: DedupCandidate = {
      amount_native: 7500,
      native_currency: "COP",
      amount_usd: 2.08,
      merchant: "PERGAMINO VIVA ENVIGAD",
      card_last4: "5685",
      tx_date: "2025-06-09",
      external_ts: "2025-06-09T10:15:05Z",
    };

    const d1 = await resolve(morningPush, bothExisting);
    expect(d1.action).toBe("discard");

    // Second notification (evening purchase) — first purchase is already claimed
    const eveningPush: DedupCandidate = {
      amount_native: 7500,
      native_currency: "COP",
      amount_usd: 2.08,
      merchant: "PERGAMINO VIVA ENVIGAD",
      card_last4: "5685",
      tx_date: "2025-06-09",
      external_ts: "2025-06-09T19:30:05Z",
    };

    const matchedId = d1.action === "discard" ? d1.matchedTxId : "";
    const d2 = await resolve(eveningPush, bothExisting, {
      excludeClaimedTxIds: [matchedId],
    });

    // Second purchase matches the second existing (the first is excluded)
    expect(d2.action).toBe("discard");
    if (d2.action === "discard") {
      expect(d2.matchedTxId).not.toBe(matchedId); // different transaction claimed
    }
  });
});
