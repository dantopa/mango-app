// =============================================================================
// Maquinita — MCP server (Supabase Edge Function)
// =============================================================================
// A domain-specific MCP server for the external statement-parsing assistant.
// Instead of raw SQL, it exposes safe, named tools that enforce the data
// contract (owner user_id, USD snapshot, expense sign, snapshot upsert).
//
// Transport: MCP Streamable HTTP (JSON-RPC 2.0 over a single POST endpoint).
// Auth:      simple shared secret (header `x-maquinita-key` or `?key=` query),
//            single-owner model — every write is stamped with OWNER_USER_ID.
// Access:    uses the service-role key (auto-injected by Supabase) so it can
//            write rows for the owner regardless of RLS.
// =============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

// --- Configuration -----------------------------------------------------------
// The owner every row is written for. Change this (and redeploy) if you start
// using your own user instead of the demo one.
const OWNER_USER_ID =
  Deno.env.get("MAQUINITA_OWNER_USER_ID") ?? "e99371b1-6163-4216-b624-c79d8ee01520";

// Shared secret the parser must present. Override via the
// MAQUINITA_MCP_SECRET function secret in the Supabase dashboard to rotate.
const SECRET =
  Deno.env.get("MAQUINITA_MCP_SECRET") ?? "mqnt_3f9aK7Qe2hV8sLpZ1xR6yTbN4wD0cJ5";

const SERVER_INFO = { name: "maquinita-mcp", version: "1.2.0" };
const DEFAULT_PROTOCOL = "2025-06-18";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, x-maquinita-key, mcp-protocol-version",
};

// --- Domain helpers ----------------------------------------------------------

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Fixed source catalog seeded into every new monthly close (mirrors the app). */
const DEFAULT_CLOSE_SOURCES = [
  { source: "RappiCard", item_type: "extracto_pdf" },
  { source: "BBVA Visa", item_type: "extracto_pdf" },
  { source: "BBVA Mastercard", item_type: "extracto_pdf" },
  { source: "Bancolombia", item_type: "gmail_auto" },
  { source: "Arriendo", item_type: "gmail_auto" },
  { source: "Nexo saldo", item_type: "saldo" },
  { source: "IBKR saldo", item_type: "saldo" },
  { source: "Wise saldo", item_type: "saldo" },
];

/** Resolve the monthly_close for a period (YYYY-MM), or null. */
async function findClose(period: string) {
  const { data, error } = await supabase
    .from("monthly_close")
    .select("*, items:monthly_close_items(*)")
    .eq("user_id", OWNER_USER_ID)
    .eq("period", period)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

function usdFor(amountNative: number, fx: number, amountUsd?: number): number {
  return amountUsd != null ? amountUsd : round4(amountNative * fx);
}

/** Default FX for stablecoin/USD when not provided. */
function defaultFx(currency: string, fx?: number): number {
  if (fx != null) return fx;
  if (currency === "USD" || currency === "USDT") return 1;
  throw new Error(`Falta fx_rate_to_usd para la moneda ${currency}`);
}

async function resolveAccount(args: {
  account_id?: string;
  account_name?: string;
}): Promise<{
  id: string;
  native_currency: string;
  country: string | null;
  payment_type: string | null;
}> {
  const { data, error } = await supabase
    .from("accounts")
    .select("id, name, native_currency, country, payment_type")
    .eq("user_id", OWNER_USER_ID);
  if (error) throw new Error(error.message);

  const pick = (a: typeof data[number]) => ({
    id: a.id,
    native_currency: a.native_currency,
    country: a.country,
    payment_type: a.payment_type,
  });

  if (args.account_id) {
    const a = data.find((x) => x.id === args.account_id);
    if (!a) throw new Error(`account_id no encontrado: ${args.account_id}`);
    return pick(a);
  }
  if (args.account_name) {
    const a = data.find(
      (x) => x.name.toLowerCase() === args.account_name!.toLowerCase(),
    );
    if (!a) {
      throw new Error(
        `Cuenta "${args.account_name}" no existe. Cuentas: ${data
          .map((x) => x.name)
          .join(", ")}`,
      );
    }
    return pick(a);
  }
  throw new Error("Indicá account_id o account_name");
}

async function resolveCategory(args: {
  category_id?: string | null;
  category_name?: string | null;
}): Promise<string | null> {
  if (args.category_id !== undefined) return args.category_id;
  if (!args.category_name) return null;
  const { data, error } = await supabase
    .from("categories")
    .select("id, name")
    .eq("user_id", OWNER_USER_ID);
  if (error) throw new Error(error.message);
  const c = data.find(
    (x) => x.name.toLowerCase() === args.category_name!.toLowerCase(),
  );
  if (!c) {
    throw new Error(
      `Categoría "${args.category_name}" no existe. Categorías: ${data
        .map((x) => x.name)
        .join(", ")}`,
    );
  }
  return c.id;
}

// deno-lint-ignore no-explicit-any
async function buildTransactionRow(t: any) {
  const account = await resolveAccount(t);
  const currency = t.native_currency ?? account.native_currency;
  const fx = defaultFx(currency, t.fx_rate_to_usd);
  const category_id = await resolveCategory(t);
  const isExtraordinary = t.is_extraordinary ?? t.expense_type === "extraordinario";
  return {
    user_id: OWNER_USER_ID,
    account_id: account.id,
    tx_date: t.tx_date,
    description_raw: t.description_raw,
    merchant: t.merchant ?? null,
    amount_native: t.amount_native,
    native_currency: currency,
    fx_rate_to_usd: fx,
    amount_usd: usdFor(t.amount_native, fx, t.amount_usd),
    category_id,
    is_payment: t.is_payment ?? false,
    is_extraordinary: isExtraordinary,
    installments: t.installments ?? null,
    statement_period: t.statement_period ?? null,
    // v2 dimensions: inherit from the account when not provided.
    country: t.country ?? account.country ?? "CO",
    payment_type: t.payment_type ?? account.payment_type ?? null,
    expense_type: t.expense_type ?? (isExtraordinary ? "extraordinario" : "variable"),
  };
}

// --- Tool implementations ----------------------------------------------------

// deno-lint-ignore no-explicit-any
const handlers: Record<string, (args: any) => Promise<unknown>> = {
  async leer_cuentas() {
    const { data, error } = await supabase
      .from("accounts")
      .select("id, name, type, native_currency, country, payment_type, is_active")
      .eq("user_id", OWNER_USER_ID)
      .order("name");
    if (error) throw new Error(error.message);
    return data;
  },

  async leer_categorias() {
    const { data, error } = await supabase
      .from("categories")
      .select("id, name, color, parent_id, monthly_budget_usd")
      .eq("user_id", OWNER_USER_ID)
      .order("name");
    if (error) throw new Error(error.message);
    return data;
  },

  // --- Accounts CRUD ---------------------------------------------------------

  async crear_cuenta(args) {
    if (!args.name) throw new Error("Falta name");
    if (!args.native_currency) {
      throw new Error("Falta native_currency (USD, COP, ARS, USDT, …)");
    }
    const validTypes = ["crypto", "broker", "bank", "wallet", "cash"];
    const type = args.type ?? "bank";
    if (!validTypes.includes(type)) {
      throw new Error(`type inválido: ${type}. Usá uno de: ${validTypes.join(", ")}`);
    }

    // Idempotente: si ya existe una cuenta con ese nombre, la devuelve.
    const cols = "id, name, type, native_currency, country, payment_type, is_active";
    const { data: existing, error: exErr } = await supabase
      .from("accounts")
      .select(cols)
      .eq("user_id", OWNER_USER_ID)
      .ilike("name", args.name);
    if (exErr) throw new Error(exErr.message);
    if (existing && existing.length > 0) {
      return { ok: true, created: false, account: existing[0] };
    }

    const { data, error } = await supabase
      .from("accounts")
      .insert({
        user_id: OWNER_USER_ID,
        name: args.name,
        type,
        native_currency: args.native_currency,
        country: args.country ?? null,
        payment_type: args.payment_type ?? null,
        is_active: args.is_active ?? true,
      })
      .select(cols)
      .single();
    if (error) throw new Error(error.message);
    return { ok: true, created: true, account: data };
  },

  async actualizar_cuenta(args) {
    const account = await resolveAccount(args); // throws if not found
    const validTypes = ["crypto", "broker", "bank", "wallet", "cash"];
    // deno-lint-ignore no-explicit-any
    const patch: Record<string, any> = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.type !== undefined) {
      if (!validTypes.includes(args.type)) {
        throw new Error(`type inválido: ${args.type}. Usá uno de: ${validTypes.join(", ")}`);
      }
      patch.type = args.type;
    }
    if (args.native_currency !== undefined) patch.native_currency = args.native_currency;
    if (args.country !== undefined) patch.country = args.country;
    if (args.payment_type !== undefined) patch.payment_type = args.payment_type;
    if (args.is_active !== undefined) patch.is_active = args.is_active;
    if (Object.keys(patch).length === 0) {
      throw new Error("No pasaste ningún campo a actualizar");
    }

    const { data, error } = await supabase
      .from("accounts")
      .update(patch)
      .eq("id", account.id)
      .eq("user_id", OWNER_USER_ID)
      .select("id, name, type, native_currency, country, payment_type, is_active")
      .single();
    if (error) throw new Error(error.message);
    return { ok: true, account: data };
  },

  async registrar_transaccion(args) {
    const row = await buildTransactionRow(args);
    const { data, error } = await supabase
      .from("transactions")
      .insert(row)
      .select("id, tx_date, merchant, amount_native, amount_usd")
      .single();
    if (error) throw new Error(error.message);
    return { ok: true, transaction: data };
  },

  async registrar_transacciones_lote(args) {
    if (!Array.isArray(args.items) || args.items.length === 0) {
      throw new Error("items debe ser un array no vacío");
    }
    const rows = [];
    for (const t of args.items) rows.push(await buildTransactionRow(t));
    const { data, error } = await supabase
      .from("transactions")
      .insert(rows)
      .select("id");
    if (error) throw new Error(error.message);
    return { ok: true, inserted: data.length, ids: data.map((d) => d.id) };
  },

  async upsert_snapshot(args) {
    const account = await resolveAccount(args);
    const currency = args.native_currency ?? account.native_currency;
    const fx = defaultFx(currency, args.fx_rate_to_usd);
    const row = {
      user_id: OWNER_USER_ID,
      account_id: account.id,
      snapshot_date: args.snapshot_date,
      balance_native: args.balance_native,
      native_currency: currency,
      fx_rate_to_usd: fx,
      balance_usd: usdFor(args.balance_native, fx, args.balance_usd),
      notes: args.notes ?? null,
      is_pending: args.is_pending ?? false,
    };
    const { data, error } = await supabase
      .from("net_worth_snapshots")
      .upsert(row, { onConflict: "account_id,snapshot_date" })
      .select("id, snapshot_date, balance_usd")
      .single();
    if (error) throw new Error(error.message);
    return { ok: true, snapshot: data };
  },

  async recategorizar(args) {
    if (!args.transaction_id) throw new Error("Falta transaction_id");
    const category_id = await resolveCategory(args);
    const { data, error } = await supabase
      .from("transactions")
      .update({ category_id })
      .eq("id", args.transaction_id)
      .eq("user_id", OWNER_USER_ID)
      .select("id, category_id")
      .single();
    if (error) throw new Error(error.message);
    return { ok: true, transaction: data };
  },

  async leer_transacciones(args) {
    let q = supabase
      .from("transactions")
      .select("id, tx_date, merchant, description_raw, amount_native, native_currency, amount_usd, account_id, category:categories(name), is_payment, source, card_last4, expense_type")
      .eq("user_id", OWNER_USER_ID)
      .order("tx_date", { ascending: false });

    if (args.month) {
      const monthStart = `${args.month}-01`;
      const [y, m] = args.month.split("-").map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      const monthEnd = `${args.month}-${String(lastDay).padStart(2, "0")}`;
      q = q.gte("tx_date", monthStart).lte("tx_date", monthEnd);
    }
    if (args.account_name) {
      const account = await resolveAccount({ account_name: args.account_name });
      q = q.eq("account_id", account.id);
    }
    if (args.limit) q = q.limit(args.limit);
    else q = q.limit(100);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return { count: data.length, transactions: data };
  },

  async eliminar_transaccion(args) {
    if (!args.transaction_id) throw new Error("Falta transaction_id");
    const { data, error } = await supabase
      .from("transactions")
      .delete()
      .eq("id", args.transaction_id)
      .eq("user_id", OWNER_USER_ID)
      .select("id, tx_date, merchant, amount_native");
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) throw new Error("No se encontró la transacción o no pertenece al dueño");
    return { ok: true, deleted: data[0] };
  },

  async eliminar_transacciones_lote(args) {
    if (!Array.isArray(args.ids) || args.ids.length === 0) {
      throw new Error("ids debe ser un array no vacío de transaction IDs");
    }
    const { data, error } = await supabase
      .from("transactions")
      .delete()
      .in("id", args.ids)
      .eq("user_id", OWNER_USER_ID)
      .select("id");
    if (error) throw new Error(error.message);
    return { ok: true, deleted_count: data.length, ids: data.map((d) => d.id) };
  },

  async actualizar_transaccion(args) {
    if (!args.transaction_id) throw new Error("Falta transaction_id");
    const patch: Record<string, unknown> = {};
    if (args.merchant !== undefined) patch.merchant = args.merchant;
    if (args.description_raw !== undefined) patch.description_raw = args.description_raw;
    if (args.amount_native !== undefined) patch.amount_native = args.amount_native;
    if (args.tx_date !== undefined) patch.tx_date = args.tx_date;
    if (args.is_payment !== undefined) patch.is_payment = args.is_payment;
    if (args.is_extraordinary !== undefined) patch.is_extraordinary = args.is_extraordinary;
    if (args.expense_type !== undefined) patch.expense_type = args.expense_type;
    if (args.native_currency !== undefined) patch.native_currency = args.native_currency;
    if (args.fx_rate_to_usd !== undefined) patch.fx_rate_to_usd = args.fx_rate_to_usd;
    if (args.amount_usd !== undefined) patch.amount_usd = args.amount_usd;
    if (args.category_name !== undefined || args.category_id !== undefined) {
      patch.category_id = await resolveCategory(args);
    }
    if (Object.keys(patch).length === 0) throw new Error("Nada que actualizar");
    const { data, error } = await supabase
      .from("transactions")
      .update(patch)
      .eq("id", args.transaction_id)
      .eq("user_id", OWNER_USER_ID)
      .select("id, tx_date, merchant, amount_native, amount_usd")
      .single();
    if (error) throw new Error(error.message);
    return { ok: true, transaction: data };
  },

  async leer_snapshots(args) {
    // If snapshot_date is provided, get snapshots for that specific date.
    // Otherwise, get the latest snapshot per active account.
    const accounts = await supabase
      .from("accounts")
      .select("id, name, type, native_currency")
      .eq("user_id", OWNER_USER_ID)
      .eq("is_active", true)
      .order("name");
    if (accounts.error) throw new Error(accounts.error.message);

    const snapDate: string | undefined = args?.snapshot_date;
    let snapshots;

    if (snapDate) {
      // Exact date
      const { data, error } = await supabase
        .from("net_worth_snapshots")
        .select("account_id, snapshot_date, balance_native, native_currency, fx_rate_to_usd, balance_usd, notes, is_pending")
        .eq("user_id", OWNER_USER_ID)
        .eq("snapshot_date", snapDate);
      if (error) throw new Error(error.message);
      snapshots = data;
    } else {
      // Latest per account: use distinct on via RPC or manual approach
      // Get the most recent snapshot per account
      const { data, error } = await supabase
        .from("net_worth_snapshots")
        .select("account_id, snapshot_date, balance_native, native_currency, fx_rate_to_usd, balance_usd, notes, is_pending")
        .eq("user_id", OWNER_USER_ID)
        .order("snapshot_date", { ascending: false });
      if (error) throw new Error(error.message);

      // Keep only the latest per account_id
      const seen = new Set<string>();
      const latest: typeof data = [];
      for (const row of data) {
        if (!seen.has(row.account_id)) {
          seen.add(row.account_id);
          latest.push(row);
        }
      }
      snapshots = latest;
    }

    // Join with account names
    const accountMap = new Map(accounts.data!.map((a) => [a.id, a]));
    const result = snapshots.map((s) => {
      const acct = accountMap.get(s.account_id);
      return {
        account_name: acct?.name ?? "desconocida",
        account_type: acct?.type ?? "unknown",
        snapshot_date: s.snapshot_date,
        balance_native: s.balance_native,
        native_currency: s.native_currency,
        fx_rate_to_usd: s.fx_rate_to_usd,
        balance_usd: s.balance_usd,
        notes: s.notes,
        is_pending: s.is_pending,
      };
    });

    const totalUsd = round4(result.reduce((sum, r) => sum + (r.balance_usd ?? 0), 0));

    return {
      snapshot_date: snapDate ?? "último de cada cuenta",
      net_worth_usd: totalUsd,
      count: result.length,
      accounts: result.sort((a, b) => (b.balance_usd ?? 0) - (a.balance_usd ?? 0)),
    };
  },

  async leer_resumen_gastos(args) {
    const { data, error } = await supabase
      .from("transactions")
      .select("amount_usd, is_payment, tx_date, category:categories(name)")
      .eq("user_id", OWNER_USER_ID);
    if (error) throw new Error(error.message);

    const rows = (data ?? []).filter((t) => !t.is_payment && t.amount_usd > 0);
    const month: string | undefined = args?.month;
    const scoped = month ? rows.filter((t) => t.tx_date.slice(0, 7) === month) : rows;

    const byCat: Record<string, number> = {};
    let total = 0;
    for (const t of scoped) {
      // deno-lint-ignore no-explicit-any
      const name = (t.category as any)?.name ?? "Sin categoría";
      byCat[name] = round4((byCat[name] ?? 0) + t.amount_usd);
      total = round4(total + t.amount_usd);
    }
    return {
      month: month ?? "todos",
      total_usd: total,
      count: scoped.length,
      by_category: Object.entries(byCat)
        .map(([name, usd]) => ({ name, usd }))
        .sort((a, b) => b.usd - a.usd),
    };
  },

  // --- Monthly close ---------------------------------------------------------

  async leer_cierre(args) {
    const period: string = args?.period ?? new Date().toISOString().slice(0, 7);
    const close = await findClose(period);
    if (!close) return { period, exists: false };
    return { period, exists: true, close };
  },

  async crear_cierre(args) {
    const period: string = args?.period ?? new Date().toISOString().slice(0, 7);
    const existing = await findClose(period);
    if (existing) return { ok: true, created: false, close: existing };

    const { data: close, error } = await supabase
      .from("monthly_close")
      .insert({ user_id: OWNER_USER_ID, period, status: "en_progreso" })
      .select()
      .single();
    if (error) throw new Error(error.message);

    const items = DEFAULT_CLOSE_SOURCES.map((s) => ({
      ...s,
      close_id: close.id,
      user_id: OWNER_USER_ID,
    }));
    const { error: itemsError } = await supabase
      .from("monthly_close_items")
      .insert(items);
    if (itemsError) throw new Error(itemsError.message);
    return { ok: true, created: true, close, items: items.length };
  },

  async actualizar_item_cierre(args) {
    const status: string = args.status ?? "cargado";
    if (!["pendiente", "cargado", "omitido"].includes(status)) {
      throw new Error("status debe ser pendiente | cargado | omitido");
    }
    const patch = {
      status,
      loaded_at: status === "cargado" ? new Date().toISOString() : null,
    };

    let q = supabase.from("monthly_close_items").update(patch).eq("user_id", OWNER_USER_ID);
    if (args.item_id) {
      q = q.eq("id", args.item_id);
    } else if (args.period && args.source) {
      const close = await findClose(args.period);
      if (!close) throw new Error(`No hay cierre para ${args.period}`);
      q = q.eq("close_id", close.id).eq("source", args.source);
    } else {
      throw new Error("Indicá item_id, o bien period + source");
    }
    const { data, error } = await q.select("id, source, status, loaded_at");
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) throw new Error("No se encontró el item");
    return { ok: true, updated: data };
  },

  async cerrar_mes(args) {
    if (!args.period) throw new Error("Falta period (YYYY-MM)");
    const close = await findClose(args.period);
    if (!close) throw new Error(`No hay cierre para ${args.period}`);
    const { data, error } = await supabase
      .from("monthly_close")
      .update({
        status: "cerrado",
        closed_at: new Date().toISOString(),
        net_worth_usd: args.net_worth_usd ?? null,
        total_spend_usd: args.total_spend_usd ?? null,
        savings_usd: args.savings_usd ?? null,
        notes: args.notes ?? close.notes ?? null,
      })
      .eq("id", close.id)
      .eq("user_id", OWNER_USER_ID)
      .select("id, period, status, closed_at, net_worth_usd")
      .single();
    if (error) throw new Error(error.message);
    return { ok: true, close: data };
  },
};

// --- Tool schemas (advertised via tools/list) --------------------------------

const accountRef = {
  account_id: { type: "string", description: "ID de la cuenta (alternativa a account_name)." },
  account_name: { type: "string", description: "Nombre exacto de la cuenta, ej 'Rappi', 'Bancolombia Ahorros'." },
};
const categoryRef = {
  category_id: { type: "string", description: "ID de la categoría (null para dejar sin categoría)." },
  category_name: { type: "string", description: "Nombre exacto de la categoría, ej 'Delivery comida'." },
};

const txProps = {
  ...accountRef,
  ...categoryRef,
  tx_date: { type: "string", description: "Fecha del consumo, formato YYYY-MM-DD." },
  description_raw: { type: "string", description: "Descripción tal cual viene del banco." },
  merchant: { type: "string", description: "Comercio normalizado (opcional)." },
  amount_native: {
    type: "number",
    description: "Monto en moneda nativa. >0 = gasto, <0 = pago/devolución.",
  },
  native_currency: { type: "string", description: "USD, COP, ARS, USDT… Si se omite usa la de la cuenta." },
  fx_rate_to_usd: { type: "number", description: "Tipo de cambio native→USD. Default 1 para USD/USDT." },
  amount_usd: { type: "number", description: "Opcional; si se omite se calcula amount_native*fx." },
  is_payment: { type: "boolean", description: "true para pagos de tarjeta/devoluciones (no cuenta como gasto)." },
  is_extraordinary: { type: "boolean", description: "(legacy) true para one-offs. Preferí expense_type='extraordinario'." },
  installments: { type: "string", description: "ej '1 de 1', '3 de 6'." },
  statement_period: { type: "string", description: "ej '2026-04-30 a 2026-05-28'." },
  country: {
    type: "string",
    description: "Dónde se hizo el gasto: AR | CO | US | global. Si se omite hereda el país de la cuenta (o CO).",
  },
  payment_type: {
    type: "string",
    description: "Medio de pago: credito | debito | transferencia | pse_qr | efectivo | inversion | wallet. Si se omite hereda el de la cuenta.",
  },
  expense_type: {
    type: "string",
    description: "Naturaleza del gasto: fijo (arriendo, prepaga, suscripciones) | variable (delivery, transporte, salidas) | extraordinario (one-offs). Default variable.",
  },
};

const TOOLS = [
  {
    name: "leer_cuentas",
    description: "Lista las cuentas del dueño (id, nombre, tipo, moneda, país, medio de pago). Usalo para resolver nombre→id.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "leer_categorias",
    description: "Lista las categorías del dueño (id, nombre, color). Usalo para resolver nombre→id.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "crear_cuenta",
    description:
      "Crea una cuenta/billetera nueva del dueño. Idempotente por nombre (si ya existe la devuelve sin duplicar). Tenés que crear la cuenta ANTES de cargarle transacciones o snapshots.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nombre de la cuenta, ej 'Wise Personal'." },
        type: { type: "string", description: "crypto | broker | bank | wallet | cash. Default bank." },
        native_currency: { type: "string", description: "Moneda nativa: USD, COP, ARS, USDT, …" },
        country: { type: "string", description: "AR | CO | US | global (opcional)." },
        payment_type: {
          type: "string",
          description: "credito | debito | transferencia | pse_qr | efectivo | inversion | wallet (opcional).",
        },
        is_active: { type: "boolean", description: "Default true." },
      },
      required: ["name", "native_currency"],
    },
  },
  {
    name: "actualizar_cuenta",
    description:
      "Actualiza una cuenta existente (identificala por account_id o account_name). Pasá solo los campos a cambiar. Sirve para renombrar, cambiar medio de pago/país o desactivar (is_active=false).",
    inputSchema: {
      type: "object",
      properties: {
        ...accountRef,
        name: { type: "string", description: "Nuevo nombre (opcional)." },
        type: { type: "string", description: "crypto | broker | bank | wallet | cash (opcional)." },
        native_currency: { type: "string", description: "Nueva moneda (opcional)." },
        country: { type: "string", description: "AR | CO | US | global (opcional)." },
        payment_type: { type: "string", description: "Nuevo medio de pago (opcional)." },
        is_active: { type: "boolean", description: "Activar/desactivar la cuenta (opcional)." },
      },
    },
  },
  {
    name: "registrar_transaccion",
    description:
      "Inserta un consumo individual de un extracto. Calcula amount_usd si no se pasa. Stampa el user_id del dueño. Acepta dimensiones country/payment_type/expense_type (heredan de la cuenta si se omiten).",
    inputSchema: {
      type: "object",
      properties: txProps,
      required: ["tx_date", "description_raw", "amount_native"],
    },
  },
  {
    name: "registrar_transacciones_lote",
    description: "Inserta varias transacciones de una (un extracto entero). Cada item usa el mismo formato que registrar_transaccion.",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "object", properties: txProps } },
      },
      required: ["items"],
    },
  },
  {
    name: "upsert_snapshot",
    description:
      "Crea o actualiza el saldo de una cuenta a una fecha de corte (upsert por cuenta+fecha). Calcula balance_usd si no se pasa.",
    inputSchema: {
      type: "object",
      properties: {
        ...accountRef,
        snapshot_date: { type: "string", description: "Fecha de corte YYYY-MM-DD." },
        balance_native: { type: "number", description: "Saldo en moneda nativa." },
        native_currency: { type: "string", description: "Si se omite usa la de la cuenta." },
        fx_rate_to_usd: { type: "number", description: "native→USD. Default 1 para USD/USDT." },
        balance_usd: { type: "number", description: "Opcional; si se omite se calcula." },
        notes: { type: "string", description: "ej '44916 USDT + 2984 NEXO'." },
        is_pending: { type: "boolean", description: "true para plata en proceso / reintegros." },
      },
      required: ["snapshot_date", "balance_native"],
    },
  },
  {
    name: "recategorizar",
    description: "Cambia la categoría de una transacción existente (category_name, category_id o null para limpiar).",
    inputSchema: {
      type: "object",
      properties: { transaction_id: { type: "string" }, ...categoryRef },
      required: ["transaction_id"],
    },
  },
  {
    name: "leer_transacciones",
    description:
      "Lista transacciones con filtros. Usalo para buscar duplicados, verificar cargas, o inspeccionar qué hay. Devuelve id, fecha, merchant, monto, moneda, cuenta, categoría, source, card_last4.",
    inputSchema: {
      type: "object",
      properties: {
        month: { type: "string", description: "Filtrar por mes YYYY-MM (opcional)." },
        account_name: { type: "string", description: "Filtrar por nombre de cuenta (opcional)." },
        limit: { type: "number", description: "Máximo de resultados (default 100)." },
      },
    },
  },
  {
    name: "eliminar_transaccion",
    description: "Elimina una transacción por su ID. Usalo para limpiar duplicados o errores.",
    inputSchema: {
      type: "object",
      properties: { transaction_id: { type: "string", description: "ID de la transacción a eliminar." } },
      required: ["transaction_id"],
    },
  },
  {
    name: "eliminar_transacciones_lote",
    description: "Elimina varias transacciones por sus IDs de una. Para limpiar duplicados en batch.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Array de IDs de transacciones a eliminar." },
      },
      required: ["ids"],
    },
  },
  {
    name: "actualizar_transaccion",
    description: "Actualiza campos de una transacción existente (merchant, monto, fecha, categoría, tipo, etc). Solo pasa los campos que querés cambiar.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: { type: "string", description: "ID de la transacción." },
        merchant: { type: "string" },
        description_raw: { type: "string" },
        amount_native: { type: "number" },
        tx_date: { type: "string" },
        is_payment: { type: "boolean" },
        is_extraordinary: { type: "boolean" },
        expense_type: { type: "string" },
        native_currency: { type: "string" },
        fx_rate_to_usd: { type: "number" },
        amount_usd: { type: "number" },
        ...categoryRef,
      },
      required: ["transaction_id"],
    },
  },
  {
    name: "leer_snapshots",
    description:
      "Lee los snapshots de patrimonio. Sin fecha devuelve el último snapshot de cada cuenta activa + patrimonio neto total. Con snapshot_date devuelve los de esa fecha exacta.",
    inputSchema: {
      type: "object",
      properties: {
        snapshot_date: { type: "string", description: "Fecha YYYY-MM-DD (opcional; sin ella devuelve el último de cada cuenta)." },
      },
    },
  },
  {
    name: "leer_resumen_gastos",
    description:
      "Devuelve total y desglose por categoría de un mes (YYYY-MM; sin mes = todo). Excluye pagos/devoluciones.",
    inputSchema: {
      type: "object",
      properties: { month: { type: "string", description: "Mes YYYY-MM. Opcional." } },
    },
  },
  {
    name: "leer_cierre",
    description:
      "Lee el cierre mensual de un período (YYYY-MM; sin período = mes actual) con su checklist de fuentes. Usalo para ver qué falta cargar.",
    inputSchema: {
      type: "object",
      properties: { period: { type: "string", description: "Período YYYY-MM. Opcional (default mes actual)." } },
    },
  },
  {
    name: "crear_cierre",
    description:
      "Abre el cierre de un período y siembra el checklist de 8 fuentes (RappiCard, BBVA Visa/Mastercard, Bancolombia, Arriendo, Nexo/IBKR/Wise saldo). Idempotente: si ya existe lo devuelve.",
    inputSchema: {
      type: "object",
      properties: { period: { type: "string", description: "Período YYYY-MM. Opcional (default mes actual)." } },
    },
  },
  {
    name: "actualizar_item_cierre",
    description:
      "Marca una fuente del checklist como cargada/omitida/pendiente. Identificá el item por item_id, o por period + source (ej period='2026-06', source='RappiCard').",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "ID del item (alternativa a period+source)." },
        period: { type: "string", description: "Período YYYY-MM (con source)." },
        source: { type: "string", description: "Nombre de la fuente, ej 'RappiCard'." },
        status: { type: "string", description: "cargado | omitido | pendiente. Default cargado." },
      },
    },
  },
  {
    name: "cerrar_mes",
    description:
      "Cierra el mes (status=cerrado) y congela el snapshot. Pasá net_worth_usd / total_spend_usd / savings_usd si los calculaste.",
    inputSchema: {
      type: "object",
      properties: {
        period: { type: "string", description: "Período YYYY-MM." },
        net_worth_usd: { type: "number", description: "Patrimonio neto del cierre (opcional)." },
        total_spend_usd: { type: "number", description: "Gasto total del mes (opcional)." },
        savings_usd: { type: "number", description: "Ahorro vs mes anterior (opcional)." },
        notes: { type: "string", description: "Notas (opcional)." },
      },
      required: ["period"],
    },
  },
];

// --- JSON-RPC / MCP plumbing -------------------------------------------------

// deno-lint-ignore no-explicit-any
function rpcResult(id: any, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
// deno-lint-ignore no-explicit-any
function rpcError(id: any, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// deno-lint-ignore no-explicit-any
async function handleRpc(msg: any): Promise<unknown | null> {
  const { id, method, params } = msg ?? {};

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications: no response
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name as string;
      const handler = handlers[name];
      if (!handler) return rpcResult(id, errorContent(`Tool desconocida: ${name}`));
      try {
        const out = await handler(params?.arguments ?? {});
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        });
      } catch (e) {
        return rpcResult(id, errorContent(e instanceof Error ? e.message : String(e)));
      }
    }
    default:
      if (id === undefined) return null; // unknown notification
      return rpcError(id, -32601, `Método no soportado: ${method}`);
  }
}

function errorContent(message: string) {
  return { content: [{ type: "text", text: `ERROR: ${message}` }], isError: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "content-type": "application/json" },
    });

  if (req.method !== "POST") {
    // No server-initiated SSE stream is offered.
    return new Response("Method Not Allowed", { status: 405, headers: CORS });
  }

  // Auth: shared secret via header or ?key=
  const url = new URL(req.url);
  const key = req.headers.get("x-maquinita-key") ?? url.searchParams.get("key");
  if (key !== SECRET) {
    return json(rpcError(null, -32001, "No autorizado: secret inválido"), 401);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json(rpcError(null, -32700, "JSON inválido"), 400);
  }

  // Support JSON-RPC batches.
  if (Array.isArray(payload)) {
    const out = [];
    for (const m of payload) {
      const r = await handleRpc(m);
      if (r !== null) out.push(r);
    }
    return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
  }

  const result = await handleRpc(payload);
  if (result === null) return new Response(null, { status: 202, headers: CORS });
  return json(result);
});
