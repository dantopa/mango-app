import { describe, it, expect } from "vitest";

import { groupDuplicateCandidates, toGroup, type AuditTx, type Verdict } from "../duplicate-audit";

function tx(overrides: Partial<AuditTx> & { id: string }): AuditTx {
  return {
    tx_date: "2026-08-10",
    amount_native: 91,
    native_currency: "USD",
    merchant: "PAYPAL *PEACOCKTVLL",
    description_raw: "Compra PAYPAL *PEACOCKTVLL",
    source: "push_ingest",
    account_id: "acc-1",
    card_last4: "1234",
    ...overrides,
  };
}

describe("groupDuplicateCandidates", () => {
  it("groups the same charge seen by different sources a day apart", () => {
    const groups = groupDuplicateCandidates([
      tx({ id: "a" }),
      tx({ id: "b", tx_date: "2026-08-11", source: "sync_gmail_rappicard" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].map((t) => t.id).sort()).toEqual(["a", "b"]);
  });

  /** Three sources recording one purchase have to end up in one group, not two pairs. */
  it("closes transitively", () => {
    const groups = groupDuplicateCandidates([
      tx({ id: "a" }),
      tx({ id: "b", tx_date: "2026-08-11" }),
      tx({ id: "c", tx_date: "2026-08-13" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it("leaves lone transactions out entirely", () => {
    expect(groupDuplicateCandidates([tx({ id: "a" })])).toEqual([]);
    expect(groupDuplicateCandidates([])).toEqual([]);
  });

  it("does not pair across currencies, even at the same number", () => {
    const groups = groupDuplicateCandidates([
      tx({ id: "a" }),
      tx({ id: "b", native_currency: "COP" }),
    ]);
    expect(groups).toEqual([]);
  });

  it("does not pair beyond the date window", () => {
    const groups = groupDuplicateCandidates([
      tx({ id: "a" }),
      tx({ id: "b", tx_date: "2026-08-14" }),
    ]);
    expect(groups).toEqual([]);
  });

  it("does not pair amounts that differ by more than the rounding tolerance", () => {
    const groups = groupDuplicateCandidates([
      tx({ id: "a", amount_native: 91 }),
      tx({ id: "b", amount_native: 95 }),
    ]);
    expect(groups).toEqual([]);
  });

  /**
   * The whole reason the merchant is checked at all: Nexo card purchases carry the
   * crypto amount in the merchant string, so the same USD figure shows up over and
   * over on unrelated buys.
   */
  it("does not pair different merchants that happen to cost the same", () => {
    const groups = groupDuplicateCandidates([
      tx({ id: "a", merchant: "cripto: 0.06438905 NEXO" }),
      tx({ id: "b", merchant: "cripto: 0.06508252 NEXO", tx_date: "2026-08-11" }),
    ]);
    expect(groups).toEqual([]);
  });

  it("pairs a truncated merchant with its full form", () => {
    const groups = groupDuplicateCandidates([
      tx({ id: "a", merchant: "COMPRA INTL Google Bumble Dati" }),
      tx({ id: "b", merchant: "COMPRA INTL Google Bumble Dating" }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it("keeps unrelated clusters apart", () => {
    const groups = groupDuplicateCandidates([
      tx({ id: "a" }),
      tx({ id: "b" }),
      tx({ id: "c", amount_native: 12.5, merchant: "RAPPI" }),
      tx({ id: "d", amount_native: 12.5, merchant: "RAPPI" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.length)).toEqual([2, 2]);
  });
});

describe("toGroup", () => {
  function verdict(overrides: Partial<Verdict> = {}): Verdict {
    return {
      same: true,
      keep_id: "a",
      drop_ids: ["b"],
      confidence: "high",
      reason: "misma compra",
      ...overrides,
    };
  }

  const crossSource = [tx({ id: "a" }), tx({ id: "b", source: "sync_gmail_rappicard" })];

  it("keeps a well-formed verdict", () => {
    expect(toGroup(verdict(), crossSource)).toMatchObject({
      keep_id: "a",
      drop_ids: ["b"],
      confidence: "high",
    });
  });

  it("drops a verdict that says they are different", () => {
    expect(toGroup(verdict({ same: false }), crossSource)).toBeNull();
  });

  /** A hallucinated id must not make some unrelated transaction the survivor. */
  it("drops a verdict whose keep_id is not in the group", () => {
    expect(toGroup(verdict({ keep_id: "zzz" }), crossSource)).toBeNull();
  });

  it("ignores drop_ids outside the group, and drops the verdict if none are left", () => {
    expect(toGroup(verdict({ drop_ids: ["zzz"] }), crossSource)).toBeNull();
    expect(toGroup(verdict({ drop_ids: ["zzz", "b"] }), crossSource)?.drop_ids).toEqual(["b"]);
  });

  it("never proposes deleting the survivor", () => {
    expect(toGroup(verdict({ drop_ids: ["a"] }), crossSource)).toBeNull();
  });

  /**
   * Two identical rows from one source cannot be told apart from two identical
   * real purchases, so the model is not allowed to pre-check them for deletion.
   */
  it("downgrades to low confidence when the whole group is one source", () => {
    const oneSource = [tx({ id: "a" }), tx({ id: "b" })];
    expect(toGroup(verdict(), oneSource)?.confidence).toBe("low");
  });
});
