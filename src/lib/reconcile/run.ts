/**
 * Runs reconciliation against the database: loads a window of transactions,
 * decides with the pure `reconcile()`, writes the status changes and logs
 * every decision (which rule matched, against which row).
 *
 * Called from three places, all converging on the same result because the
 * decision is deterministic:
 *  - the push pipeline, right after inserting a transaction (`reconcileAround`);
 *  - the reconcile job, over the last 7 days (`reconcileRange`);
 *  - the backfill script, over whole months, dry-run first.
 */

import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { reconcile } from "./reconcile";
import type { OwnerIdentity } from "./owner";
import type { ReconcileRow, StatusChange, ReviewFlag, TxStatus } from "./types";

type Client = SupabaseClient<Database>;

export type ReconcileTrigger = "ingest" | "job" | "backfill";

/**
 * How far outside the apply range rows are read as context. A release can
 * cancel a hold up to 3 days before it, and a duplicate may sit a day away.
 */
export const CONTEXT_DAYS_BEFORE = 4;
export const CONTEXT_DAYS_AFTER = 2;

const PAGE_SIZE = 1000;

const ROW_COLUMNS =
  "id, account_id, tx_date, merchant, description_raw, amount_native, native_currency, amount_usd, is_payment, source, external_ts, created_at, needs_review, status, duplicate_of, paired_with, status_reason, status_manual";

export type ReconcileReport = {
  runId: string;
  trigger: ReconcileTrigger;
  from: string;
  to: string;
  dryRun: boolean;
  changes: Array<StatusChange & { row: ReconcileRow }>;
  reviewFlags: ReviewFlag[];
  /** Change in counted spend (USD) per month if the changes are applied. */
  spendDeltaUsd: Record<string, number>;
  /** Change in counted income (USD, positive = more income) per month. */
  incomeDeltaUsd: Record<string, number>;
  errors: string[];
};

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function loadOwnerIdentity(supabase: Client, userId: string): Promise<OwnerIdentity> {
  const { data, error } = await supabase
    .from("user_settings")
    .select("owner_names, owner_keys")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) console.error("[reconcile] owner identity query failed:", error.message);
  return { names: data?.owner_names ?? [], keys: data?.owner_keys ?? [] };
}

export async function loadReconcileRows(supabase: Client, userId: string, from: string, to: string): Promise<ReconcileRow[]> {
  const rows: ReconcileRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("transactions")
      .select(ROW_COLUMNS)
      .eq("user_id", userId)
      .gte("tx_date", from)
      .lte("tx_date", to)
      .order("tx_date")
      .order("id")
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`transactions query failed: ${error.message}`);
    for (const r of data ?? []) {
      rows.push({
        ...r,
        amount_native: Number(r.amount_native),
        amount_usd: Number(r.amount_usd),
        status: r.status as TxStatus,
        origin: r.source,
      });
    }
    if (!data || data.length < PAGE_SIZE) break;
  }

  // For push ingests the notifier matters (Google Wallet echoes vs the issuer's
  // own notification), and only the ingest log knows it.
  const pushIds = rows.filter((r) => r.source === "push_ingest").map((r) => r.id);
  for (let i = 0; i < pushIds.length; i += 200) {
    const { data, error } = await supabase
      .from("push_ingest_log")
      .select("transaction_id, package_name")
      .eq("status", "registered")
      .in("transaction_id", pushIds.slice(i, i + 200));
    if (error) throw new Error(`push_ingest_log query failed: ${error.message}`);
    const origin = new Map((data ?? []).map((l) => [l.transaction_id, l.package_name]));
    for (const row of rows) if (origin.has(row.id)) row.origin = origin.get(row.id)!;
  }

  return rows;
}

function countsAsSpend(row: ReconcileRow): boolean {
  return !row.is_payment && row.amount_usd > 0;
}

function countsAsIncome(row: ReconcileRow): boolean {
  return !row.is_payment && row.amount_usd < 0;
}

function deltas(changes: Array<StatusChange & { row: ReconcileRow }>) {
  const spend: Record<string, number> = {};
  const income: Record<string, number> = {};
  for (const { row, from, to } of changes) {
    const sign = (from.status === "active" ? -1 : 0) + (to.status === "active" ? 1 : 0);
    if (sign === 0) continue;
    const month = row.tx_date.slice(0, 7);
    if (countsAsSpend(row)) spend[month] = (spend[month] ?? 0) + sign * row.amount_usd;
    if (countsAsIncome(row)) income[month] = (income[month] ?? 0) + sign * -row.amount_usd;
  }
  return { spend, income };
}

/**
 * Pure part of a run: decides over already-loaded rows. Shared by the live run
 * and the offline backfill (rows exported to JSON).
 */
export function planReconcile(
  rows: ReconcileRow[],
  identity: OwnerIdentity,
  range: { from: string; to: string },
  meta: { trigger: ReconcileTrigger; dryRun: boolean; runId?: string },
): ReconcileReport {
  const result = reconcile(rows, { identity, applyFrom: range.from, applyTo: range.to });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const changes = result.changes.map((c) => ({ ...c, row: byId.get(c.id)! }));
  const { spend, income } = deltas(changes);
  return {
    runId: meta.runId ?? randomUUID(),
    trigger: meta.trigger,
    from: range.from,
    to: range.to,
    dryRun: meta.dryRun,
    changes,
    reviewFlags: result.reviewFlags,
    spendDeltaUsd: spend,
    incomeDeltaUsd: income,
    errors: [],
  };
}

export function logDecisions(report: ReconcileReport): void {
  const prefix = `[reconcile][${report.trigger}]${report.dryRun ? "[dry-run]" : ""}`;
  for (const c of report.changes) {
    console.log(
      `${prefix} rule=${c.rule} tx=${c.id} ref=${c.ref_id ?? "-"} ${c.from.status}→${c.to.status} | ${c.detail}`,
    );
  }
  for (const f of report.reviewFlags) console.log(`${prefix} review tx=${f.id} | ${f.detail}`);
}

export async function applyReport(supabase: Client, userId: string, report: ReconcileReport): Promise<void> {
  for (const c of report.changes) {
    const { error } = await supabase
      .from("transactions")
      .update(c.to)
      .eq("id", c.id)
      // A person may have decided this row since it was read.
      .eq("status_manual", false);
    if (error) report.errors.push(`update ${c.id}: ${error.message}`);
  }

  for (const f of report.reviewFlags) {
    const { error } = await supabase.from("transactions").update({ needs_review: true }).eq("id", f.id);
    if (error) report.errors.push(`review flag ${f.id}: ${error.message}`);
  }

  if (report.changes.length > 0) {
    const { error } = await supabase.from("transaction_reconcile_log").insert(
      report.changes.map((c) => ({
        user_id: userId,
        run_id: report.runId,
        trigger: report.trigger,
        transaction_id: c.id,
        rule: c.rule,
        ref_transaction_id: c.ref_id,
        from_status: c.from.status,
        to_status: c.to.status,
        detail: c.detail,
      })),
    );
    if (error) report.errors.push(`reconcile log insert: ${error.message}`);
  }

  for (const e of report.errors) console.error(`[reconcile][${report.trigger}] ${e}`);
}

/** Reconciles every transaction dated in [from, to]. */
export async function reconcileRange(
  supabase: Client,
  userId: string,
  options: { from: string; to: string; trigger: ReconcileTrigger; dryRun?: boolean },
): Promise<ReconcileReport> {
  const dryRun = options.dryRun ?? false;
  const [rows, identity] = await Promise.all([
    loadReconcileRows(supabase, userId, shiftDate(options.from, -CONTEXT_DAYS_BEFORE), shiftDate(options.to, CONTEXT_DAYS_AFTER)),
    loadOwnerIdentity(supabase, userId),
  ]);

  const report = planReconcile(rows, identity, options, { trigger: options.trigger, dryRun });
  logDecisions(report);
  if (!dryRun) await applyReport(supabase, userId, report);
  return report;
}

/**
 * Reconciles the neighbourhood of a transaction that was just inserted: the
 * days a duplicate or the hold it releases can sit in.
 */
export async function reconcileAround(
  supabase: Client,
  userId: string,
  txDate: string,
): Promise<ReconcileReport> {
  return reconcileRange(supabase, userId, {
    from: shiftDate(txDate, -3),
    to: shiftDate(txDate, 1),
    trigger: "ingest",
  });
}

/**
 * Reconciles a whole "YYYY-MM" month after a batch load (a bank sync, an email
 * sync). Best effort: a failure is logged, never thrown — the load itself
 * already succeeded, and the daily job will reconcile again.
 */
export async function reconcileMonthAfterLoad(
  supabase: Client,
  userId: string,
  month: string,
  source: string,
): Promise<void> {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  try {
    const report = await reconcileRange(supabase, userId, {
      from: `${month}-01`,
      to: `${month}-${String(lastDay).padStart(2, "0")}`,
      trigger: "job",
    });
    if (report.changes.length > 0) {
      console.log(`[${source}] reconciled ${month}: ${report.changes.length} status changes`);
    }
  } catch (err) {
    console.error(`[${source}] reconcile failed for ${month}:`, err instanceof Error ? err.message : err);
  }
}
