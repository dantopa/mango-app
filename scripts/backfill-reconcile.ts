/**
 * Backfill: runs transaction reconciliation over a past date range.
 *
 * DRY-RUN BY DEFAULT — prints every row it would mark, the rule and the row it
 * matched against, and the effect on each month's spend. Nothing is written
 * unless --apply is passed.
 *
 * Live (needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY):
 *   npm run reconcile:backfill -- --from 2026-08-01 --to 2026-09-30
 *   npm run reconcile:backfill -- --from 2026-08-01 --to 2026-09-30 --apply
 *
 * Offline, from rows exported to JSON (same columns as loadReconcileRows, plus
 * `package_name` for push ingests). Writes the SQL to apply instead:
 *   npm run reconcile:backfill -- --from 2026-08-01 --to 2026-09-30 \
 *     --input rows.json --owner-name "NOMBRE COMPLETO" --owner-key 3001234567 \
 *     --emit-sql reconcile.sql
 */

import { randomUUID } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/database.types";
import {
  applyReport,
  CONTEXT_DAYS_AFTER,
  CONTEXT_DAYS_BEFORE,
  loadOwnerIdentity,
  loadReconcileRows,
  logDecisions,
  planReconcile,
  shiftDate,
  type ReconcileReport,
} from "../src/lib/reconcile/run";
import { effectiveMerchant } from "../src/lib/reconcile/merchant";
import type { OwnerIdentity } from "../src/lib/reconcile/owner";
import type { ReconcileRow, TxStatus } from "../src/lib/reconcile/types";

const OWNER_USER_ID = "e99371b1-6163-4216-b624-c79d8ee01520";

type Args = {
  from: string;
  to: string;
  apply: boolean;
  input?: string;
  emitSql?: string;
  ownerNames: string[];
  ownerKeys: string[];
};

function parseArgs(argv: string[]): Args {
  const args: Args = { from: "", to: "", apply: false, ownerNames: [], ownerKeys: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--from") args.from = value();
    else if (flag === "--to") args.to = value();
    else if (flag === "--apply") args.apply = true;
    else if (flag === "--input") args.input = value();
    else if (flag === "--emit-sql") args.emitSql = value();
    else if (flag === "--owner-name") args.ownerNames.push(value());
    else if (flag === "--owner-key") args.ownerKeys.push(value());
    else if (flag !== "--") throw new Error(`unknown flag ${flag}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.from) || !/^\d{4}-\d{2}-\d{2}$/.test(args.to)) {
    throw new Error("--from and --to are required (YYYY-MM-DD)");
  }
  if (args.apply && args.input) throw new Error("--apply only works live; offline, use --emit-sql");
  return args;
}

function rowsFromJson(path: string): ReconcileRow[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, unknown>>;
  return raw.map((r) => ({
    id: String(r.id),
    account_id: String(r.account_id),
    tx_date: String(r.tx_date),
    merchant: (r.merchant as string | null) ?? null,
    description_raw: (r.description_raw as string | null) ?? null,
    amount_native: Number(r.amount_native),
    native_currency: String(r.native_currency),
    amount_usd: Number(r.amount_usd),
    is_payment: Boolean(r.is_payment),
    source: String(r.source),
    origin: (r.package_name as string | null) ?? String(r.source),
    external_ts: (r.external_ts as string | null) ?? null,
    created_at: String(r.created_at),
    needs_review: Boolean(r.needs_review),
    status: ((r.status as string | undefined) ?? "active") as TxStatus,
    duplicate_of: (r.duplicate_of as string | null) ?? null,
    paired_with: (r.paired_with as string | null) ?? null,
    status_reason: (r.status_reason as string | null) ?? null,
    status_manual: Boolean(r.status_manual),
  }));
}

const usd = (n: number) => n.toFixed(2).padStart(9);

function monthTotals(rows: ReconcileRow[], from: string, to: string) {
  const totals: Record<string, { spend: number; income: number }> = {};
  for (const r of rows) {
    if (r.tx_date < from || r.tx_date > to || r.status !== "active" || r.is_payment) continue;
    const m = (totals[r.tx_date.slice(0, 7)] ??= { spend: 0, income: 0 });
    if (r.amount_usd > 0) m.spend += r.amount_usd;
    else m.income -= r.amount_usd;
  }
  return totals;
}

function printReport(report: ReconcileReport, rows: ReconcileRow[]): void {
  const byRule = new Map<string, number>();
  for (const c of report.changes) byRule.set(c.rule, (byRule.get(c.rule) ?? 0) + 1);

  console.log(`\n=== Reconcile ${report.from} … ${report.to} ${report.dryRun ? "(DRY-RUN: nada se escribe)" : "(APPLY)"} ===\n`);
  const sorted = [...report.changes].sort(
    (a, b) => a.row.tx_date.localeCompare(b.row.tx_date) || a.rule.localeCompare(b.rule),
  );
  for (const c of sorted) {
    const r = c.row;
    const merchant = (effectiveMerchant(r.merchant, r.description_raw) ?? "—").slice(0, 28).padEnd(28);
    const counted = !r.is_payment && r.amount_usd > 0 ? usd(r.amount_usd) : "        —";
    console.log(
      `${r.tx_date}  ${merchant} ${String(r.amount_native).padStart(10)} ${r.native_currency}  gasto ${counted}  ` +
        `${c.from.status} → ${c.to.status.padEnd(17)} ${c.rule.padEnd(22)} ref=${c.ref_id ?? "-"}  tx=${c.id}`,
    );
  }
  if (report.reviewFlags.length > 0) {
    console.log("\nPara revisar (quedan activas, con needs_review):");
    for (const f of report.reviewFlags) console.log(`  tx=${f.id}  ${f.detail}`);
  }

  console.log("\nPor regla:", Object.fromEntries(byRule));
  const before = monthTotals(rows, report.from, report.to);
  console.log("\nMes       gasto antes   Δ gasto   gasto después   ingreso antes   Δ ingreso");
  for (const month of Object.keys(before).sort()) {
    const b = before[month];
    const ds = report.spendDeltaUsd[month] ?? 0;
    const di = report.incomeDeltaUsd[month] ?? 0;
    console.log(`${month}   ${usd(b.spend)}  ${usd(ds)}   ${usd(b.spend + ds)}       ${usd(b.income)}  ${usd(di)}`);
  }
  console.log();
}

const sqlText = (v: string | null) => (v === null ? "null" : `'${v.replace(/'/g, "''")}'`);

/**
 * The SQL equivalent of --apply. Each update only lands if the row is still in
 * the state the plan was computed from and nobody marked it by hand since.
 */
function toSql(report: ReconcileReport, userId: string): string {
  const lines = ["begin;"];
  for (const c of report.changes) {
    lines.push(
      `update public.transactions set status = ${sqlText(c.to.status)}, duplicate_of = ${sqlText(c.to.duplicate_of)}, ` +
        `paired_with = ${sqlText(c.to.paired_with)}, status_reason = ${sqlText(c.to.status_reason)} ` +
        `where id = ${sqlText(c.id)} and status = ${sqlText(c.from.status)} and status_manual = false;`,
    );
  }
  for (const f of report.reviewFlags) {
    lines.push(`update public.transactions set needs_review = true where id = ${sqlText(f.id)};`);
  }
  if (report.changes.length > 0) {
    lines.push(
      "insert into public.transaction_reconcile_log (user_id, run_id, trigger, transaction_id, rule, ref_transaction_id, from_status, to_status, detail) values",
      report.changes
        .map(
          (c) =>
            `  (${sqlText(userId)}, ${sqlText(report.runId)}, 'backfill', ${sqlText(c.id)}, ${sqlText(c.rule)}, ` +
            `${sqlText(c.ref_id)}, ${sqlText(c.from.status)}, ${sqlText(c.to.status)}, ${sqlText(c.detail)})`,
        )
        .join(",\n") + ";",
    );
  }
  lines.push("commit;");
  return lines.join("\n") + "\n";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const contextFrom = shiftDate(args.from, -CONTEXT_DAYS_BEFORE);
  const contextTo = shiftDate(args.to, CONTEXT_DAYS_AFTER);

  let rows: ReconcileRow[];
  let identity: OwnerIdentity;
  let supabase: ReturnType<typeof createClient<Database>> | null = null;

  if (args.input) {
    rows = rowsFromJson(args.input).filter((r) => r.tx_date >= contextFrom && r.tx_date <= contextTo);
    identity = { names: args.ownerNames, keys: args.ownerKeys };
  } else {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (or use --input)");
    supabase = createClient<Database>(url, key, { auth: { persistSession: false } });
    rows = await loadReconcileRows(supabase, OWNER_USER_ID, contextFrom, contextTo);
    const stored = await loadOwnerIdentity(supabase, OWNER_USER_ID);
    identity = {
      names: [...stored.names, ...args.ownerNames],
      keys: [...stored.keys, ...args.ownerKeys],
    };
  }

  const report = planReconcile(rows, identity, { from: args.from, to: args.to }, {
    trigger: "backfill",
    dryRun: !args.apply,
    runId: randomUUID(),
  });
  printReport(report, rows);

  if (args.emitSql) {
    writeFileSync(args.emitSql, toSql(report, OWNER_USER_ID));
    console.log(`SQL escrito en ${args.emitSql} (${report.changes.length} cambios). Revisalo antes de correrlo.`);
  }

  if (args.apply && supabase) {
    logDecisions(report);
    await applyReport(supabase, OWNER_USER_ID, report);
    if (report.errors.length > 0) {
      console.error(`Terminó con ${report.errors.length} errores.`);
      process.exitCode = 1;
    } else {
      console.log(`Aplicado: ${report.changes.length} cambios, run_id=${report.runId}.`);
    }
  } else if (!args.emitSql) {
    console.log("Dry-run: no se escribió nada. Repetí con --apply para aplicar.");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
