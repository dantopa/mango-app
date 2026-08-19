/**
 * Duplicate audit: a second pass over a month that is *allowed* to be slow.
 *
 * The sync engine dedupes as it inserts, one candidate at a time, and it has to
 * decide in milliseconds with no view of the month as a whole. This runs after
 * the fact over everything that landed, so it can afford to compare every
 * transaction against every other and then ask the model about the leftovers.
 *
 * The split matters: the grouping is deterministic and exhaustive, and the AI
 * only ever answers the one question code cannot — is this the same real-world
 * movement recorded twice, or did you genuinely buy two identical coffees. It is
 * never asked to *find* duplicates, only to judge candidates, and its verdict is
 * checked against the group it was given before anything is proposed.
 *
 * Nothing here deletes. It returns a proposal; deleting is the user's click.
 */
import { compareMerchants } from "./fuzzy-matcher";
import { getSupabaseAdmin } from "../push-ingest/supabase-admin";

export type AuditTx = {
  id: string;
  tx_date: string;
  amount_native: number;
  native_currency: string;
  merchant: string | null;
  description_raw: string;
  source: string;
  account_id: string;
  card_last4: string | null;
};

export type DuplicateGroup = {
  keep_id: string;
  drop_ids: string[];
  confidence: "high" | "low";
  reason: string;
  transactions: AuditTx[];
};

/** Two records of the same purchase can be days apart if one came from a statement. */
const MAX_DAY_GAP = 3;

/** Relative amount tolerance — the same charge can round differently per source. */
const AMOUNT_TOLERANCE = 0.005;

/** Groups sent to the model per run. Beyond this the month needs a human anyway. */
const MAX_GROUPS = 25;

/** Concurrent judge calls, to stay inside the route's deadline without hammering. */
const JUDGE_CONCURRENCY = 5;

const OPENAI_MODEL = "gpt-5.6-luna";
const OPENAI_TIMEOUT_MS = 12_000;

/** Raw text sent per transaction — enough to recognise a merchant, not a whole email. */
const MAX_DESCRIPTION_CHARS = 200;

function daysApart(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.round(ms / 86_400_000);
}

function amountsClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(a, b) * AMOUNT_TOLERANCE;
}

/**
 * Could these two be the same movement? Deliberately generous — this only decides
 * what is worth a closer look. The merchant check is what keeps it from flagging
 * every Nexo crypto purchase that happens to cost the same.
 */
function couldBeSame(a: AuditTx, b: AuditTx): boolean {
  if (a.native_currency !== b.native_currency) return false;
  if (!amountsClose(a.amount_native, b.amount_native)) return false;
  if (daysApart(a.tx_date, b.tx_date) > MAX_DAY_GAP) return false;
  return compareMerchants(a.merchant, b.merchant) !== "no_match";
}

/**
 * Cluster transactions into candidate groups by transitive closure: if A pairs
 * with B and B with C, all three are judged together. That is what catches a
 * charge recorded three times by three sources.
 *
 * Pure and exported so the grouping can be tested without a database or an API key.
 */
export function groupDuplicateCandidates(txs: AuditTx[]): AuditTx[][] {
  const parent = txs.map((_, i) => i);

  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    // Path compression, so a long chain does not cost anything the second time.
    while (parent[i] !== root) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };

  for (let i = 0; i < txs.length; i++) {
    for (let j = i + 1; j < txs.length; j++) {
      if (!couldBeSame(txs[i], txs[j])) continue;
      const rootI = find(i);
      const rootJ = find(j);
      if (rootI !== rootJ) parent[rootJ] = rootI;
    }
  }

  const clusters = new Map<number, AuditTx[]>();
  for (let i = 0; i < txs.length; i++) {
    const root = find(i);
    const cluster = clusters.get(root);
    if (cluster) cluster.push(txs[i]);
    else clusters.set(root, [txs[i]]);
  }

  return [...clusters.values()].filter((cluster) => cluster.length > 1);
}

const SYSTEM_PROMPT = `Sos un auditor de transacciones financieras personales. Te doy un grupo de transacciones que un filtro determinista marcó como POSIBLEMENTE la misma compra registrada más de una vez (mismo monto aproximado, fechas cercanas, comercio parecido).

Tu única tarea: decidir si son la MISMA operación del mundo real registrada varias veces, o si son operaciones distintas que casualmente se parecen.

Señales de que ES duplicado:
- Distintas fuentes ("source") viendo la misma compra: la notificación del celular, el mail del banco y el extracto son tres registros del mismo movimiento.
- Mismo comercio, mismo monto exacto, misma fecha o un día de diferencia (los extractos suelen atrasar la fecha).
- Misma tarjeta ("card_last4") y descripciones que dicen lo mismo con otro formato.

Señales de que NO es duplicado:
- Consumos repetidos plausibles: dos cafés, dos viajes en Uber, dos recargas el mismo día.
- Cuentas distintas ("account_id") sin ninguna razón para que sea el mismo movimiento.
- Montos parecidos pero no iguales en comercios distintos.

Ante la duda, respondé que NO son duplicados: borrar un gasto real es peor que dejar uno duplicado.

Respondé SOLO un objeto JSON:
{"same": true|false, "keep_id": "<id a conservar>", "drop_ids": ["<ids a borrar>"], "confidence": "high"|"low", "reason": "<una frase en español>"}

- Si "same" es false, dejá "keep_id" en "" y "drop_ids" vacío.
- "keep_id" es el registro más completo (el que tiene mejor merchant y descripción).
- "drop_ids" son los demás del grupo, nunca "keep_id".
- "confidence" es "high" solo si estás seguro.`;

export type Verdict = {
  same: boolean;
  keep_id: string;
  drop_ids: string[];
  confidence: "high" | "low";
  reason: string;
};

/** Shape check only — whether the ids make sense is validated against the group. */
function parseVerdict(content: unknown): Verdict | null {
  if (typeof content !== "string" || content.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return null;
    const raw = parsed as Record<string, unknown>;
    if (typeof raw.same !== "boolean") return null;

    return {
      same: raw.same,
      keep_id: typeof raw.keep_id === "string" ? raw.keep_id : "",
      drop_ids: Array.isArray(raw.drop_ids)
        ? raw.drop_ids.filter((id): id is string => typeof id === "string")
        : [],
      confidence: raw.confidence === "high" ? "high" : "low",
      reason: typeof raw.reason === "string" ? raw.reason.slice(0, 200) : "",
    };
  } catch {
    return null;
  }
}

/**
 * The hard signature: a verdict may only ever talk about the group it was given,
 * and it may never end up proposing that the whole group disappear.
 *
 * It also cannot claim high confidence without cross-source evidence. Two
 * identical rows from the same source are genuinely undecidable — the same
 * notification ingested twice and two real identical coffees look exactly alike —
 * and only "high" groups come pre-checked for deletion, so that call stays human.
 */
export function toGroup(verdict: Verdict, group: AuditTx[]): DuplicateGroup | null {
  if (!verdict.same) return null;

  const ids = new Set(group.map((tx) => tx.id));
  if (!ids.has(verdict.keep_id)) return null;

  const dropIds = [...new Set(verdict.drop_ids)].filter(
    (id) => ids.has(id) && id !== verdict.keep_id
  );
  if (dropIds.length === 0) return null;

  const crossSource = new Set(group.map((tx) => tx.source)).size > 1;

  return {
    keep_id: verdict.keep_id,
    drop_ids: dropIds,
    confidence: crossSource ? verdict.confidence : "low",
    reason: verdict.reason,
    transactions: group,
  };
}

async function judgeGroup(group: AuditTx[], apiKey: string): Promise<DuplicateGroup | null> {
  const payload = group.map((tx) => ({
    id: tx.id,
    date: tx.tx_date,
    amount: tx.amount_native,
    currency: tx.native_currency,
    merchant: tx.merchant,
    description: tx.description_raw.slice(0, MAX_DESCRIPTION_CHARS),
    source: tx.source,
    account_id: tx.account_id,
    card_last4: tx.card_last4,
  }));

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(payload) },
        ],
        // Unlike the categorizer, this one is a judgement call with a cost to
        // getting it wrong, so it gets to think.
        reasoning_effort: "low",
        response_format: { type: "json_object" },
        max_completion_tokens: 600,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    if (!response.ok) {
      console.error(`[duplicate-audit] OpenAI error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    const verdict = parseVerdict(data.choices?.[0]?.message?.content);
    if (!verdict) return null;

    return toGroup(verdict, group);
  } catch (err) {
    console.error("[duplicate-audit] judge failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export type AuditResult = {
  scanned: number;
  candidate_groups: number;
  /** Groups the model could not look at, because the run hit MAX_GROUPS. */
  skipped_groups: number;
  groups: DuplicateGroup[];
};

/** Last day of a "YYYY-MM" month. */
function monthEnd(month: string): string {
  const [year, m] = month.split("-").map(Number);
  const lastDay = new Date(year, m, 0).getDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
}

/**
 * Audit one month. Returns proposals only — deleting is a separate, explicit act.
 */
export async function auditMonth(userId: string, month: string): Promise<AuditResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const { data, error } = await getSupabaseAdmin()
    .from("transactions")
    .select("id, tx_date, amount_native, native_currency, merchant, description_raw, source, account_id, card_last4")
    .eq("user_id", userId)
    .gte("tx_date", `${month}-01`)
    .lte("tx_date", monthEnd(month))
    .order("tx_date", { ascending: true });

  if (error) throw new Error(`No se pudieron leer las transacciones: ${error.message}`);

  const txs: AuditTx[] = (data ?? []).map((row) => ({
    ...row,
    amount_native: Number(row.amount_native),
  }));

  const candidates = groupDuplicateCandidates(txs);
  const judged = candidates.slice(0, MAX_GROUPS);

  const groups: DuplicateGroup[] = [];
  for (let i = 0; i < judged.length; i += JUDGE_CONCURRENCY) {
    const batch = judged.slice(i, i + JUDGE_CONCURRENCY);
    const verdicts = await Promise.all(batch.map((group) => judgeGroup(group, apiKey)));
    for (const verdict of verdicts) {
      if (verdict) groups.push(verdict);
    }
  }

  return {
    scanned: txs.length,
    candidate_groups: candidates.length,
    skipped_groups: candidates.length - judged.length,
    groups,
  };
}
