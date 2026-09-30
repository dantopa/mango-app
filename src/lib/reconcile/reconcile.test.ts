import { describe, it, expect } from "vitest";
import { reconcile } from "./reconcile";
import type { ReconcileRow, ReconcileResult } from "./types";

/**
 * Every case below is taken from push_raw_log / transactions of Aug–Sep 2026:
 * same merchants, amounts, texts and arrival times (UTC).
 */

const RAPPI_ACCOUNT = "2ca256d0-rappi";
const NEXO_CARD_ACCOUNT = "159c9840-nexo-card";
const BANCOLOMBIA = "a39a2dfd-bancolombia";

const RAPPI = "com.grability.rappi";
const WALLET = "com.google.android.apps.walletnfcrel";
const NEXO = "com.nexowallet";
const SMS = "com.google.android.apps.messaging";

const IDENTITY = { names: ["PATRICIO EDUARDO DANDREA ESCODA"], keys: ["3007570391"] };

let seq = 0;

type RowInput = Partial<ReconcileRow> & { amount_native: number; external_ts: string };

function row(partial: RowInput): ReconcileRow {
  seq += 1;
  const ts = partial.external_ts;
  return {
    id: partial.id ?? `tx-${String(seq).padStart(3, "0")}`,
    account_id: RAPPI_ACCOUNT,
    tx_date: bogotaDate(ts),
    merchant: null,
    description_raw: null,
    native_currency: "COP",
    amount_usd: partial.amount_native / 3200,
    is_payment: partial.amount_native < 0,
    source: "push_ingest",
    origin: RAPPI,
    created_at: ts,
    needs_review: false,
    status: "active",
    duplicate_of: null,
    paired_with: null,
    status_reason: null,
    status_manual: false,
    ...partial,
  };
}

function bogotaDate(iso: string): string {
  return new Date(Date.parse(iso) - 5 * 3600_000).toISOString().slice(0, 10);
}

/** RappiCard's own notification. */
function rappi(merchant: string, amount: number, at: string, extra: Partial<ReconcileRow> = {}) {
  return row({
    merchant,
    amount_native: amount,
    external_ts: at,
    description_raw: `Tu compra en ${merchant} por $ ${amount.toLocaleString("es-CO")} fue exitosa. Consulta los detalles de tu compra en tus transacciones.`,
    ...extra,
  } as RowInput);
}

/** Google Wallet charge as the AI fallback stored it: no merchant, "X: amount COP con …". */
function walletCharge(title: string, amount: number, at: string, extra: Partial<ReconcileRow> = {}) {
  return row({
    origin: WALLET,
    amount_native: amount,
    external_ts: at,
    description_raw: `${title}: ${amount.toLocaleString("es-CO")} COP con Tarjeta Visa ••3679`,
    ...extra,
  } as RowInput);
}

/** Google Wallet release of a hold, as its parser stores it. */
function walletRelease(amount: number, at: string, extra: Partial<ReconcileRow> = {}) {
  return row({
    origin: WALLET,
    merchant: "UBR* PENDING.UBER.COM",
    amount_native: -amount,
    is_payment: true,
    external_ts: at,
    description_raw: `UBR* PENDING.UBER.COM - Se ha reembolsado en la tarjeta Tarjeta Visa ••3679 el siguiente importe: -${amount.toLocaleString("es-CO")} COP`,
    ...extra,
  } as RowInput);
}

/** Nexo Card's own notification. */
function nexo(merchant: string, amount: number, currency: string, at: string, cashback = "0.08") {
  return row({
    account_id: NEXO_CARD_ACCOUNT,
    origin: NEXO,
    merchant,
    amount_native: amount,
    native_currency: currency,
    external_ts: at,
    description_raw: `Pago de ${amount.toFixed(2)} ${currency} (€1.00) en ${merchant}. Cashback en cripto: ${cashback} NEXO.`,
  });
}

function run(rows: ReconcileRow[]): ReconcileResult {
  return reconcile(rows, { identity: IDENTITY });
}

/** Final status of every row after applying the changes. */
function statuses(rows: ReconcileRow[], result: ReconcileResult): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) out[r.id] = r.status;
  for (const c of result.changes) out[c.id] = c.to.status;
  return out;
}

function activeIds(rows: ReconcileRow[], result = run(rows)): string[] {
  const s = statuses(rows, result);
  return rows.filter((r) => s[r.id] === "active").map((r) => r.id);
}

function applied(rows: ReconcileRow[], result: ReconcileResult): ReconcileRow[] {
  const byId = new Map(result.changes.map((c) => [c.id, c.to]));
  return rows.map((r) => (byId.has(r.id) ? { ...r, ...byId.get(r.id)! } : r));
}

describe("reconcile — Bug 1: RappiCard purchases notified twice", () => {
  it("keeps one row for 'Tu compra en X' + the Visa notification of the same purchase", () => {
    const tuCompra = rappi("OCTAVA MARAVILLA MIRADOR", 216333, "2026-09-06T03:44:57Z");
    const visa = walletCharge("OCTAVA MARAVILLA MIRADOR", 216333, "2026-09-06T03:54:23Z");
    const result = run([visa, tuCompra]);

    expect(activeIds([visa, tuCompra], result)).toEqual([tuCompra.id]);
    const change = result.changes.find((c) => c.id === visa.id)!;
    expect(change.to).toMatchObject({ status: "duplicate", duplicate_of: tuCompra.id, status_reason: "duplicate_notification" });
    expect(change.rule).toBe("duplicate_notification");
  });

  it("prefers the row with a normalized merchant even when the Visa one arrived first", () => {
    const visa = walletCharge("IKEA ENVIGADO", 77100, "2026-09-08T22:00:37Z");
    const tuCompra = rappi("IKEA ENVIGADO", 77100, "2026-09-08T22:01:41Z");
    expect(activeIds([visa, tuCompra])).toEqual([tuCompra.id]);
  });

  it("collapses the Visa notification re-posted 3 times plus the RappiCard one (TJV ×4)", () => {
    const rows = [
      rappi("TJV VIVA ENVIGADO", 7500, "2026-09-20T01:17:39Z"),
      walletCharge("TJV VIVA ENVIGADO", 7500, "2026-09-20T01:17:45Z"),
      walletCharge("TJV VIVA ENVIGADO", 7500, "2026-09-20T01:47:06Z"),
      walletCharge("TJV VIVA ENVIGADO", 7500, "2026-09-20T01:47:12Z"),
      walletCharge("TJV VIVA ENVIGADO", 7500, "2026-09-20T01:49:09Z"),
    ];
    const result = run(rows);
    expect(activeIds(rows, result)).toEqual([rows[0].id]);
    for (const dup of rows.slice(1)) {
      expect(result.changes.find((c) => c.id === dup.id)?.to.duplicate_of).toBe(rows[0].id);
    }
  });

  it("collapses a Visa-only purchase re-posted without any RappiCard notification (IKEA 77.100 ×2)", () => {
    const rows = [
      walletCharge("IKEA ENVIGADO", 77100, "2026-09-08T22:18:11Z"),
      walletCharge("IKEA ENVIGADO", 77100, "2026-09-08T22:19:22Z"),
    ];
    expect(activeIds(rows)).toEqual([rows[0].id]);
  });

  it("does not mix two different purchases at the same merchant a minute apart", () => {
    // IKEA 77.100 and IKEA 6.220, both notified twice, on 08-sep.
    const rows = [
      rappi("IKEA ENVIGADO", 77100, "2026-09-08T22:01:41Z"),
      walletCharge("IKEA ENVIGADO", 77100, "2026-09-08T22:18:11Z"),
      rappi("IKEA ENVIGADO", 6220, "2026-09-08T22:18:07Z"),
      walletCharge("IKEA ENVIGADO", 6220, "2026-09-08T22:19:19Z"),
    ];
    expect(activeIds(rows)).toEqual([rows[0].id, rows[2].id]);
  });
});

describe("reconcile — Bug 2: ride-hailing holds and their release", () => {
  it("voids a RappiCard Uber charge and its Wallet release as a pair", () => {
    const hold = rappi("Uber", 11202, "2026-08-23T22:58:43Z");
    const realTrip = rappi("Uber", 12511, "2026-08-23T23:26:09Z");
    const release = walletRelease(11202, "2026-08-23T23:26:32Z");
    const rows = [hold, realTrip, release];
    const result = run(rows);

    expect(activeIds(rows, result)).toEqual([realTrip.id]);
    expect(result.changes.find((c) => c.id === hold.id)?.to).toMatchObject({ status: "voided", paired_with: release.id });
    expect(result.changes.find((c) => c.id === release.id)?.to).toMatchObject({ status: "voided", paired_with: hold.id });
  });

  it("voids a Nexo 'Pago de … en UBR* PENDING.UBER.COM' and its release", () => {
    const hold = nexo("UBR* PENDING.UBER.COM", 11475, "COP", "2026-08-21T23:00:50Z");
    const release = walletRelease(11475, "2026-08-21T23:02:23Z", {
      account_id: NEXO_CARD_ACCOUNT,
      description_raw: "UBR* PENDING.UBER.COM - Se ha reembolsado en la tarjeta Nexo Mastercard ••4186 el siguiente importe: -11.475 COP",
    });
    const rows = [hold, release];
    expect(activeIds(rows)).toEqual([]);
    expect(run(rows).changes.every((c) => c.rule === "preauth_released")).toBe(true);
  });

  it("pairs one hold with one release: 5 re-posted releases of 14.318 against 1 charge", () => {
    const hold = rappi("Uber", 14318, "2026-09-20T01:46:59Z");
    const releases = [
      "2026-09-20T01:49:03Z",
      "2026-09-20T01:56:59Z",
      "2026-09-20T01:58:22Z",
      "2026-09-20T02:24:15Z",
      "2026-09-20T02:25:29Z",
    ].map((at) => walletRelease(14318, at));
    // The trip actually charged that night, with no release after it.
    const realTrip = walletCharge("UBR* PENDING.UBER.COM", 16306, "2026-09-20T04:15:06Z");
    const rows = [hold, ...releases, realTrip];
    const result = run(rows);

    const s = statuses(rows, result);
    expect(s[hold.id]).toBe("voided");
    expect(s[realTrip.id]).toBe("active");
    expect(releases.filter((r) => s[r.id] === "voided")).toHaveLength(1);
    expect(releases.filter((r) => s[r.id] === "duplicate")).toHaveLength(4);
  });

  it("never lets orphan releases void a real charge that comes after them", () => {
    // Four releases with no hold before them, then a real trip of the same amount.
    const releases = ["01:49:03", "01:56:59", "01:58:22", "02:24:15"].map((t) =>
      walletRelease(14318, `2026-09-20T${t}Z`),
    );
    const realCharge = rappi("Uber", 14318, "2026-09-20T03:10:00Z");
    const rows = [...releases, realCharge];
    const s = statuses(rows, run(rows));

    expect(s[realCharge.id]).toBe("active");
    expect(releases.some((r) => s[r.id] === "voided")).toBe(false);
  });

  it("keeps the real charge when two holds were released before it (Nexo ••5667, 35.934 on 28-sep)", () => {
    const at = (t: string) => `2026-09-28T${t}Z`;
    const onNexoCard = { account_id: NEXO_CARD_ACCOUNT, merchant: "UBR* PENDING.UBER.COM" };
    const rows = [
      walletCharge("UBR* PENDING.UBER.COM", 35934, at("22:05:36"), onNexoCard),
      walletRelease(35934, at("22:06:05"), { account_id: NEXO_CARD_ACCOUNT }),
      walletCharge("UBR* PENDING.UBER.COM", 35934, at("22:06:11"), onNexoCard),
      walletRelease(35934, at("22:06:13"), { account_id: NEXO_CARD_ACCOUNT }),
      nexo("UBR* PENDING.UBER.COM", 35934, "COP", at("22:07:27")),
      walletCharge("UBR* PENDING.UBER.COM", 35934, at("22:07:31"), onNexoCard),
    ];
    const result = run(rows);
    const s = statuses(rows, result);
    const activeCharges = rows.filter((r) => !r.is_payment && s[r.id] === "active");

    expect(activeCharges.map((r) => r.id)).toEqual([rows[4].id]);
  });

  it("does not pair a release with a charge on another card", () => {
    const hold = nexo("UBR* PENDING.UBER.COM", 14318, "COP", "2026-09-20T01:40:00Z");
    const release = walletRelease(14318, "2026-09-20T01:49:03Z"); // RappiCard
    expect(activeIds([hold, release])).toEqual([hold.id, release.id]);
  });

  it("does not pair a release with a hold older than 3 days", () => {
    const hold = rappi("Uber", 9000, "2026-09-10T15:00:00Z");
    const release = walletRelease(9000, "2026-09-14T15:00:00Z");
    expect(activeIds([hold, release])).toEqual([hold.id, release.id]);
  });

  it("recognizes Didi's descriptors as one provider", () => {
    const hold = rappi("DLO Didi", 14000, "2026-08-21T23:29:35Z");
    const release = walletRelease(14000, "2026-08-21T23:40:00Z", {
      merchant: "DIDI RIDES DL",
      description_raw: "DIDI RIDES DL - Se ha reembolsado en la tarjeta Tarjeta Visa ••3679 el siguiente importe: -14.000 COP",
    });
    expect(activeIds([hold, release])).toEqual([]);
  });
});

describe("reconcile — Bug 3: transfers between the owner's accounts", () => {
  const transferToSelf = () =>
    row({
      account_id: BANCOLOMBIA,
      origin: SMS,
      amount_native: 1_000_000,
      external_ts: "2026-09-12T22:44:26Z",
      merchant: "la llave 3007570391 desde tu cuenta *9898 a PATRICIO EDUARDO DANDREA ESCODA el 12/09/26 a las 17:44",
      description_raw:
        "Bancolombia: PATRICIO, transferiste $1,000,000.00 a la llave 3007570391 desde tu cuenta *9898 a PATRICIO EDUARDO DANDREA ESCODA el 12/09/26 a las 17:44. ¿Dudas? Llamanos al 018000931987",
    });

  it("marks a transfer to the owner's own key as internal", () => {
    const tx = transferToSelf();
    const change = run([tx]).changes[0];
    expect(change.to.status).toBe("internal_transfer");
    expect(change.detail).toContain("llave 3007570391");
  });

  it("recognizes the owner by full name when no key is configured", () => {
    const tx = transferToSelf();
    const result = reconcile([tx], { identity: { names: IDENTITY.names, keys: [] } });
    expect(result.changes[0].to.status).toBe("internal_transfer");
    expect(result.changes[0].detail).toContain("titular");
  });

  it("marks money received from the owner as internal (not income)", () => {
    const incoming = row({
      account_id: BANCOLOMBIA,
      origin: SMS,
      amount_native: -85_000,
      is_payment: false,
      external_ts: "2026-08-19T22:31:59Z",
      merchant: "PATRICIO EDUARDO DANDREA ESCODA",
      description_raw:
        "Bancolombia: PATRICIO, recibiste una transferencia de PATRICIO EDUARDO DANDREA ESCODA por $85,000 en tu cuenta **9898, el 19/08/2026 a las 17:31",
    });
    expect(run([incoming]).changes[0].to.status).toBe("internal_transfer");
  });

  it("leaves transfers to other people as they are", () => {
    const toFriend = row({
      account_id: BANCOLOMBIA,
      origin: SMS,
      amount_native: 45_000,
      external_ts: "2026-09-09T21:43:17Z",
      description_raw:
        "Bancolombia: PATRICIO, transferiste $45,000.00 a la llave 1409296 desde tu cuenta *9898 a ISABEL BETANCOURT SICART el 09/09/26 a las 16:42.",
    });
    expect(run([toFriend]).changes).toEqual([]);
  });

  it("ignores the owner's name outside a transfer (RappiCard email greeting)", () => {
    const purchase = row({
      source: "sync_gmail_rappicard",
      origin: "sync_gmail_rappicard",
      merchant: "DiDi CO Food",
      amount_native: 22900,
      external_ts: "2026-08-01T20:00:00Z",
      description_raw: "¡Hola, PATRICIO EDUARDO DANDREA ESCODA!\n\nRealizaste una compra con tu RappiCard en DiDi CO Food",
    });
    expect(run([purchase]).changes).toEqual([]);
  });

  it("does not treat a lone first name as the owner", () => {
    const tx = row({
      account_id: BANCOLOMBIA,
      origin: SMS,
      amount_native: 20_000,
      external_ts: "2026-09-01T20:00:00Z",
      description_raw: "Bancolombia: recibiste una transferencia de PATRICIO por $20,000 en tu cuenta",
    });
    expect(run([tx]).changes).toEqual([]);
  });
});

describe("reconcile — purchases that must NOT be deduplicated", () => {
  it("keeps two equal purchases on the same day at different merchants", () => {
    const rows = [
      rappi("PERGAMINO VIVA ENVIGADO", 11500, "2026-09-17T15:00:00Z"),
      rappi("JUAN VALDEZ CAFE", 11500, "2026-09-17T15:20:00Z"),
    ];
    expect(activeIds(rows)).toEqual(rows.map((r) => r.id));
  });

  it("keeps the same purchase at the same place on consecutive days", () => {
    const rows = [
      rappi("PERGAMINO VIVA ENVIGADO", 11500, "2026-09-17T22:58:37Z"),
      rappi("PERGAMINO VIVA ENVIGADO", 11500, "2026-09-18T22:40:00Z"),
    ];
    expect(activeIds(rows)).toEqual(rows.map((r) => r.id));
  });

  it("keeps two charges the issuer notified with different texts (Nexo DEEPSEERWEA ×2)", () => {
    const first = nexo("DEEPSEERWEA", 2.12, "USD", "2026-08-30T03:03:03Z", "0.03610228");
    const echo = row({
      account_id: NEXO_CARD_ACCOUNT,
      origin: WALLET,
      merchant: "DEEPSEERWEA",
      amount_native: 2.12,
      native_currency: "USD",
      external_ts: "2026-08-30T03:03:06Z",
      description_raw: "DEEPSEERWEA - 2,12 US$ con Nexo Mastercard ••4186",
    });
    const second = nexo("DEEPSEERWEA", 2.12, "USD", "2026-08-30T04:12:15Z", "0.03616718");
    const rows = [first, echo, second];
    const result = run(rows);

    expect(activeIds(rows, result)).toEqual([first.id, second.id]);
    expect(result.changes.find((c) => c.id === echo.id)?.to.duplicate_of).toBe(first.id);
  });

  it("does not match rows whose merchant cannot be recovered", () => {
    const rows = [
      row({ amount_native: 5000, external_ts: "2026-09-01T10:00:00Z", description_raw: "movimiento" }),
      row({ amount_native: 5000, external_ts: "2026-09-01T10:01:00Z", description_raw: "movimiento" }),
    ];
    expect(activeIds(rows)).toEqual(rows.map((r) => r.id));
  });

  it("flags for review when the issuer itself repeats far apart, instead of silently trusting it", () => {
    const rows = [
      rappi("TJV VIVA ENVIGADO", 7500, "2026-09-20T01:17:39Z"),
      rappi("TJV VIVA ENVIGADO", 7500, "2026-09-20T02:30:00Z"),
    ];
    const result = run(rows);
    expect(activeIds(rows, result)).toEqual([rows[0].id]);
    expect(result.reviewFlags.map((f) => f.id)).toEqual([rows[0].id]);
  });
});

describe("reconcile — idempotency, ordering and audit", () => {
  const scenario = () => [
    rappi("OCTAVA MARAVILLA MIRADOR", 216333, "2026-09-06T03:44:57Z"),
    walletCharge("OCTAVA MARAVILLA MIRADOR", 216333, "2026-09-06T03:54:23Z"),
    walletCharge("OCTAVA MARAVILLA MIRADOR", 216333, "2026-09-06T04:22:02Z"),
    rappi("Uber", 14318, "2026-09-20T01:46:59Z"),
    walletRelease(14318, "2026-09-20T01:49:03Z"),
    walletRelease(14318, "2026-09-20T01:56:59Z"),
  ];

  it("produces no changes when run again over its own output", () => {
    const rows = scenario();
    const first = run(rows);
    expect(first.changes.length).toBeGreaterThan(0);
    expect(run(applied(rows, first)).changes).toEqual([]);
  });

  it("reaches the same decisions whatever order the notifications arrive in", () => {
    const rows = scenario();
    const expected = statuses(rows, run(rows));
    for (const order of [[...rows].reverse(), [rows[4], rows[2], rows[0], rows[5], rows[1], rows[3]]]) {
      expect(statuses(order, run(order))).toEqual(expected);
    }
  });

  it("is the same whether the rows arrive one by one or all at once", () => {
    const rows = scenario();
    let state: ReconcileRow[] = [];
    for (const r of rows) state = applied([...state, r], run([...state, r]));
    const oneByOne = Object.fromEntries(state.map((r) => [r.id, r.status]));
    expect(oneByOne).toEqual(statuses(rows, run(rows)));
  });

  it("never touches a row a person decided by hand", () => {
    const tuCompra = rappi("IKEA ENVIGADO", 77100, "2026-09-08T22:01:41Z");
    const keptByHand = walletCharge("IKEA ENVIGADO", 77100, "2026-09-08T22:00:37Z", { status_manual: true });
    const result = run([tuCompra, keptByHand]);
    // The manual row is kept, so it becomes the canonical one.
    expect(result.changes.map((c) => c.id)).toEqual([tuCompra.id]);
    expect(result.changes[0].to.duplicate_of).toBe(keptByHand.id);
  });

  it("restores a row whose earlier automatic decision no longer holds", () => {
    const orphan = walletCharge("IKEA ENVIGADO", 77100, "2026-09-08T22:00:37Z", {
      status: "duplicate",
      duplicate_of: "deleted-row",
      status_reason: "duplicate_notification",
    });
    const change = run([orphan]).changes[0];
    expect(change.rule).toBe("restored");
    expect(change.to).toEqual({ status: "active", duplicate_of: null, paired_with: null, status_reason: null });
  });

  it("only changes rows inside the apply range, using the rest as context", () => {
    const tuCompra = rappi("TJV VIVA ENVIGADO", 7500, "2026-09-20T01:17:39Z"); // 2026-09-19 in Bogotá
    const visa = walletCharge("TJV VIVA ENVIGADO", 7500, "2026-09-20T05:30:00Z"); // 2026-09-20
    const result = reconcile([tuCompra, visa], { identity: IDENTITY, applyFrom: "2026-09-20", applyTo: "2026-09-20" });
    expect(result.changes.map((c) => c.id)).toEqual([]); // 4h13m apart: not the same purchase

    const closeVisa = walletCharge("TJV VIVA ENVIGADO", 7500, "2026-09-20T05:10:00Z");
    const tuCompraLate = rappi("TJV VIVA ENVIGADO", 7500, "2026-09-20T04:59:00Z"); // 2026-09-19 23:59 Bogotá
    const inRange = reconcile([tuCompraLate, closeVisa], { identity: IDENTITY, applyFrom: "2026-09-20", applyTo: "2026-09-20" });
    expect(inRange.changes.map((c) => c.id)).toEqual([closeVisa.id]);
    expect(inRange.changes[0].to.duplicate_of).toBe(tuCompraLate.id);
  });
});
