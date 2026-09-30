/**
 * Transaction reconciliation: decides which rows are real spend.
 *
 * Pure and deterministic — the same rows always produce the same decisions,
 * whatever order the notifications arrived in and however many times it runs.
 * That is what lets the pipeline call it on every insert and the reconcile job
 * re-run it over the last week without the two ever disagreeing.
 *
 * Every status is recomputed from scratch on each run, so a decision that stops
 * holding (a late notification changes the picture) is undone, not left stale.
 * Rows a person marked by hand (`status_manual`) are never touched.
 *
 * Three rules, applied in this order:
 *  1. internal transfer — money between the owner's own accounts;
 *  2. duplicate notification — the same purchase notified more than once;
 *  3. pre-authorization released — a ride-hailing hold and its refund.
 * Deduplication runs before pairing because releases are re-posted too: five
 * identical "Se ha reembolsado … -14.318 COP" notifications are one release.
 */

import { effectiveMerchant, merchantsEquivalent, providerOf } from "./merchant";
import { matchInternalTransfer, type OwnerIdentity } from "./owner";
import type {
  ReconcileResult,
  ReconcileRow,
  ReviewFlag,
  RowState,
  StatusChange,
  ReconcileRule,
} from "./types";

const GOOGLE_WALLET = "com.google.android.apps.walletnfcrel";

/**
 * Two notifications of one purchase observed up to 40 minutes apart (Google
 * Wallet re-posts "TJV VIVA ENVIGADO 7.500 COP" at 01:17, 01:47, 01:47 and
 * 01:49). Beyond a couple of hours, a same-amount purchase at the same place is
 * more likely a second visit — the next day's coffee must never be absorbed.
 */
export const DUPLICATE_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Two notifications from the same issuer this far apart are unusual for a
 * re-post (RappiCard re-posts within a minute). They are still collapsed, per
 * the rule, but the survivor is flagged so a person can confirm.
 */
export const SUSPICIOUS_REPEAT_MS = 10 * 60 * 1000;

/** A release refunds a hold placed at most this many days before. */
export const PREAUTH_LOOKBACK_DAYS = 3;

/**
 * Uber's final charge ("UBER *TRIP") lands within about half an hour of its
 * hold ("UBR* PENDING.UBER.COM") — 20 to 56 minutes across Aug–Sep 2026 — and
 * differs from it by what the trip ended up costing.
 */
export const SUPERSEDE_WINDOW_MS = 60 * 60 * 1000;
export const SUPERSEDE_AMOUNT_RATIO = 1.3;

/** How a provider names a hold and a final charge. */
const RE_HOLD_DESCRIPTOR = /PENDING/i;
const RE_CAPTURE_DESCRIPTOR = /\*\s*TRIP\b/i;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ReconcileOptions = {
  identity: OwnerIdentity;
  /**
   * Only rows dated inside this range are changed. Rows outside it are context:
   * a charge from the day before the window can still absorb a duplicate inside.
   */
  applyFrom?: string;
  applyTo?: string;
};

type Desired = RowState & { rule: ReconcileRule | null; ref_id: string | null; detail: string };

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

function tsOf(row: ReconcileRow): number | null {
  if (!row.external_ts) return null;
  const ms = Date.parse(row.external_ts);
  return Number.isNaN(ms) ? null : ms;
}

/** When the row happened, as best we know, for ordering. */
function sortTime(row: ReconcileRow): number {
  return tsOf(row) ?? Date.parse(row.created_at);
}

function sameAmount(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

function describe(row: ReconcileRow): string {
  const merchant = effectiveMerchant(row.merchant, row.description_raw) ?? "sin comercio";
  return `${row.tx_date} ${merchant} ${row.amount_native} ${row.native_currency} [${row.origin ?? row.source}]`;
}

/**
 * Close enough in time to be one purchase. With both timestamps known, the
 * window is tight; when one side only has a date (email sync, statements), the
 * issuer and the notifier can disagree by a day. Two undated rows from the same
 * source are distinct by that source's own idempotency and never collapse.
 */
function closeInTime(a: ReconcileRow, b: ReconcileRow): boolean {
  const tsA = tsOf(a);
  const tsB = tsOf(b);
  if (tsA !== null && tsB !== null) return Math.abs(tsA - tsB) <= DUPLICATE_WINDOW_MS;
  if (tsA === null && tsB === null && a.source === b.source) return false;
  return Math.abs(dayNumber(a.tx_date) - dayNumber(b.tx_date)) <= 1;
}

function isSamePurchase(a: ReconcileRow, b: ReconcileRow): boolean {
  return (
    a.account_id === b.account_id &&
    a.native_currency === b.native_currency &&
    a.is_payment === b.is_payment &&
    sameAmount(a.amount_native, b.amount_native) &&
    closeInTime(a, b) &&
    merchantsEquivalent(
      effectiveMerchant(a.merchant, a.description_raw),
      effectiveMerchant(b.merchant, b.description_raw),
    )
  );
}

/**
 * Which row of a duplicate group stands for the purchase: one a person decided
 * on (kept, or ruled out — its echoes follow it either way), then the one with
 * a stored merchant, then the issuer's own notification over Google Wallet's
 * echo, then the earliest. `id` makes the choice total, hence deterministic.
 */
function canonicalOrder(a: ReconcileRow, b: ReconcileRow): number {
  const keys = (r: ReconcileRow) => [
    r.status_manual ? (r.status === "active" ? 0 : 1) : 2,
    r.merchant?.trim() ? 0 : 1,
    r.origin === GOOGLE_WALLET ? 1 : 0,
  ];
  const ka = keys(a);
  const kb = keys(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return sortTime(a) - sortTime(b) || a.id.localeCompare(b.id);
}

/**
 * Two notifications from the same issuer that say different things are two
 * purchases, however alike: Nexo sent "Pago de 2.12 USD en DEEPSEERWEA" twice,
 * 69 minutes apart, with a different cashback each time — two real charges. A
 * re-post, by contrast, repeats the text verbatim. Google Wallet is exempt: its
 * text for two separate purchases is identical, so it cannot tell them apart.
 */
function distinctPurchases(a: ReconcileRow, b: ReconcileRow): boolean {
  return (
    a.origin !== null &&
    a.origin === b.origin &&
    a.origin !== GOOGLE_WALLET &&
    (a.description_raw ?? "").trim() !== (b.description_raw ?? "").trim()
  );
}

/** How far apart two rows are, for merging the closest pairs first. */
function distance(a: ReconcileRow, b: ReconcileRow): number {
  const tsA = tsOf(a);
  const tsB = tsOf(b);
  if (tsA !== null && tsB !== null) return Math.abs(tsA - tsB);
  return Math.abs(dayNumber(a.tx_date) - dayNumber(b.tx_date)) * DAY_MS + DAY_MS / 2;
}

/**
 * Groups rows into purchases, merging the closest same-purchase pairs first and
 * never putting two distinct purchases in one group. A plain transitive closure
 * would chain two real charges through the Wallet echo sitting between them.
 */
function groupDuplicates(rows: ReconcileRow[]): ReconcileRow[][] {
  const edges: Array<{ i: number; j: number; d: number }> = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (isSamePurchase(rows[i], rows[j])) edges.push({ i, j, d: distance(rows[i], rows[j]) });
    }
  }
  edges.sort(
    (x, y) =>
      x.d - y.d ||
      rows[x.i].id.localeCompare(rows[y.i].id) ||
      rows[x.j].id.localeCompare(rows[y.j].id),
  );

  const groupOf = rows.map((_, i) => i);
  const members = new Map<number, number[]>(rows.map((_, i) => [i, [i]]));

  for (const { i, j } of edges) {
    const gi = groupOf[i];
    const gj = groupOf[j];
    if (gi === gj) continue;
    const a = members.get(gi)!;
    const b = members.get(gj)!;
    if (a.some((x) => b.some((y) => distinctPurchases(rows[x], rows[y])))) continue;
    for (const k of b) groupOf[k] = gi;
    members.set(gi, [...a, ...b]);
    members.delete(gj);
  }

  return [...members.values()].map((idx) => idx.map((k) => rows[k]));
}

/**
 * Flags a collapsed group when the same issuer notified twice, far apart: that
 * looks less like a re-post and more like two real purchases.
 */
function repeatedIssuerFlag(group: ReconcileRow[], canonical: ReconcileRow): ReviewFlag | null {
  const byOrigin = new Map<string, number[]>();
  for (const row of group) {
    const ts = tsOf(row);
    if (!row.origin || row.origin === GOOGLE_WALLET || ts === null) continue;
    byOrigin.set(row.origin, [...(byOrigin.get(row.origin) ?? []), ts]);
  }
  for (const [origin, times] of byOrigin) {
    if (times.length < 2) continue;
    if (Math.max(...times) - Math.min(...times) > SUSPICIOUS_REPEAT_MS) {
      return {
        id: canonical.id,
        detail: `${origin} notificó ${times.length} veces ${describe(canonical)} con más de 10 min de diferencia: puede ser más de una compra`,
      };
    }
  }
  return null;
}

export function reconcile(rows: readonly ReconcileRow[], options: ReconcileOptions): ReconcileResult {
  const desired = new Map<string, Desired>();
  const reviewFlags: ReviewFlag[] = [];

  // Rows a person decided keep their state; everything else starts as active.
  for (const row of rows) {
    desired.set(
      row.id,
      row.status_manual
        ? { ...pickState(row), rule: null, ref_id: null, detail: "manual" }
        : { status: "active", duplicate_of: null, paired_with: null, status_reason: null, rule: null, ref_id: null, detail: "" },
    );
  }
  const stateOf = (row: ReconcileRow) => desired.get(row.id)!;

  // 1. Internal transfers.
  for (const row of rows) {
    if (row.status_manual) continue;
    const match = matchInternalTransfer(row, options.identity);
    if (!match) continue;
    desired.set(row.id, {
      status: "internal_transfer",
      duplicate_of: null,
      paired_with: null,
      status_reason: "internal_transfer",
      rule: "internal_transfer",
      ref_id: null,
      detail: `transferencia propia (${match.via === "key" ? "llave" : "titular"} ${match.value}): ${describe(row)}`,
    });
  }

  // 2. Duplicate notifications. A row a person decided on takes part and always
  // leads its group: if they kept it, the echoes are its duplicates; if they
  // ruled it out (a phantom hold), the echoes are duplicates of a non-purchase
  // and must not step up to replace it.
  const dedupePool = rows.filter((r) => r.status_manual || stateOf(r).status === "active");
  for (const group of groupDuplicates(dedupePool)) {
    if (group.length < 2) continue;
    const [canonical, ...others] = [...group].sort(canonicalOrder);
    for (const row of others) {
      if (row.status_manual) continue;
      desired.set(row.id, {
        status: "duplicate",
        duplicate_of: canonical.id,
        paired_with: null,
        status_reason: "duplicate_notification",
        rule: "duplicate_notification",
        ref_id: canonical.id,
        detail: `misma compra que ${canonical.id} (${describe(canonical)}): ${describe(row)}`,
      });
    }
    const flag = repeatedIssuerFlag(group, canonical);
    if (flag && !canonical.needs_review) reviewFlags.push(flag);
  }

  // 3. Pre-authorizations released. One release cancels exactly one hold: the
  // latest unpaired charge before it. A release with no hold stays as is — it
  // must never reach for a later, real charge of the same amount.
  const pairable = rows.filter((r) => !r.status_manual && stateOf(r).status === "active");
  const releases = pairable
    .filter((r) => r.is_payment && r.amount_native < 0)
    .filter((r) => providerOf(effectiveMerchant(r.merchant, r.description_raw)) !== null)
    .sort((a, b) => sortTime(a) - sortTime(b) || a.id.localeCompare(b.id));
  const holds = pairable.filter((r) => !r.is_payment && r.amount_native > 0);
  const paired = new Set<string>();

  for (const release of releases) {
    const provider = providerOf(effectiveMerchant(release.merchant, release.description_raw));
    const releaseDay = dayNumber(release.tx_date);
    const releaseTs = tsOf(release);

    const hold = holds
      .filter((h) => !paired.has(h.id))
      .filter(
        (h) =>
          h.account_id === release.account_id &&
          h.native_currency === release.native_currency &&
          sameAmount(h.amount_native, -release.amount_native) &&
          providerOf(effectiveMerchant(h.merchant, h.description_raw)) === provider,
      )
      .filter((h) => {
        const day = dayNumber(h.tx_date);
        if (day > releaseDay || day < releaseDay - PREAUTH_LOOKBACK_DAYS) return false;
        const holdTs = tsOf(h);
        return holdTs === null || releaseTs === null || holdTs <= releaseTs;
      })
      .sort((a, b) => sortTime(b) - sortTime(a) || a.id.localeCompare(b.id))[0];

    if (!hold) continue;
    paired.add(hold.id);
    desired.set(hold.id, {
      status: "voided",
      duplicate_of: null,
      paired_with: release.id,
      status_reason: "preauth_released",
      rule: "preauth_released",
      ref_id: release.id,
      detail: `retención liberada por ${release.id} (${describe(release)}): ${describe(hold)}`,
    });
    desired.set(release.id, {
      status: "voided",
      duplicate_of: null,
      paired_with: hold.id,
      status_reason: "preauth_released",
      rule: "preauth_released",
      ref_id: hold.id,
      detail: `libera la retención ${hold.id} (${describe(hold)}): ${describe(release)}`,
    });
  }

  // 3b. Holds superseded by the final charge. Nine in ten Uber holds get a
  // release notification; the rest never do, and the hold would stay counted
  // next to the real charge ("UBR* PENDING 18.428" + "UBER *TRIP 18.538" on
  // 5-sep). A hold is recognised by its descriptor on any notification of the
  // purchase, since RappiCard names both just "Uber". A hold with no later
  // capture is left alone: often "PENDING" is the only charge Uber ever sends.
  const members = new Map<string, ReconcileRow[]>();
  for (const row of rows) {
    const state = stateOf(row);
    const lead = state.status === "duplicate" && state.duplicate_of ? state.duplicate_of : row.id;
    members.set(lead, [...(members.get(lead) ?? []), row]);
  }
  const describedAs = (row: ReconcileRow, pattern: RegExp) =>
    (members.get(row.id) ?? [row]).some((m) => pattern.test(effectiveMerchant(m.merchant, m.description_raw) ?? ""));

  const openCharges = rows
    .filter((r) => !r.status_manual && stateOf(r).status === "active" && !r.is_payment && r.amount_native > 0)
    .filter((r) => providerOf(effectiveMerchant(r.merchant, r.description_raw)) !== null && tsOf(r) !== null);
  const openHolds = openCharges
    .filter((r) => describedAs(r, RE_HOLD_DESCRIPTOR) && !describedAs(r, RE_CAPTURE_DESCRIPTOR))
    .sort((a, b) => sortTime(a) - sortTime(b) || a.id.localeCompare(b.id));
  const captures = openCharges.filter((r) => describedAs(r, RE_CAPTURE_DESCRIPTOR));
  const usedCaptures = new Set<string>();

  for (const hold of openHolds) {
    const holdTs = tsOf(hold)!;
    const provider = providerOf(effectiveMerchant(hold.merchant, hold.description_raw));
    const capture = captures
      .filter((c) => !usedCaptures.has(c.id))
      .filter((c) => {
        const ts = tsOf(c)!;
        const ratio = c.amount_native / hold.amount_native;
        return (
          c.account_id === hold.account_id &&
          c.native_currency === hold.native_currency &&
          providerOf(effectiveMerchant(c.merchant, c.description_raw)) === provider &&
          ts > holdTs &&
          ts - holdTs <= SUPERSEDE_WINDOW_MS &&
          ratio <= SUPERSEDE_AMOUNT_RATIO &&
          ratio >= 1 / SUPERSEDE_AMOUNT_RATIO
        );
      })
      .sort((a, b) => sortTime(a) - sortTime(b) || a.id.localeCompare(b.id))[0];

    if (!capture) continue;
    usedCaptures.add(capture.id);
    desired.set(hold.id, {
      status: "voided",
      duplicate_of: null,
      paired_with: capture.id,
      status_reason: "preauth_superseded",
      rule: "preauth_superseded",
      ref_id: capture.id,
      detail: `retención reemplazada por el cobro final ${capture.id} (${describe(capture)}): ${describe(hold)}`,
    });
  }

  // 4. Diff against what is stored, inside the apply range only.
  const changes: StatusChange[] = [];
  for (const row of rows) {
    if (row.status_manual) continue;
    if (options.applyFrom && row.tx_date < options.applyFrom) continue;
    if (options.applyTo && row.tx_date > options.applyTo) continue;

    const current = pickState(row);
    const next = stateOf(row);
    if (sameState(current, next)) continue;

    changes.push({
      id: row.id,
      from: current,
      to: pickState(next),
      rule: next.rule ?? "restored",
      ref_id: next.ref_id,
      detail: next.rule ? next.detail : `vuelve a activo (antes ${current.status_reason ?? current.status}): ${describe(row)}`,
    });
  }

  const inRange = (id: string) => {
    const row = rows.find((r) => r.id === id)!;
    return (!options.applyFrom || row.tx_date >= options.applyFrom) && (!options.applyTo || row.tx_date <= options.applyTo);
  };

  return { changes, reviewFlags: reviewFlags.filter((f) => inRange(f.id)) };
}

function pickState(s: RowState): RowState {
  return {
    status: s.status,
    duplicate_of: s.duplicate_of,
    paired_with: s.paired_with,
    status_reason: s.status_reason,
  };
}

function sameState(a: RowState, b: RowState): boolean {
  return (
    a.status === b.status &&
    a.duplicate_of === b.duplicate_of &&
    a.paired_with === b.paired_with &&
    a.status_reason === b.status_reason
  );
}
