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
  Deno.env.get("MAQUINITA_OWNER_USER_ID") ?? "49b33f55-dcf2-4370-ba9a-204b91f2551d";

// Shared secret the parser must present. Override via the
// MAQUINITA_MCP_SECRET function secret in the Supabase dashboard to rotate.
const SECRET =
  Deno.env.get("MAQUINITA_MCP_SECRET") ?? "mqnt_3f9aK7Qe2hV8sLpZ1xR6yTbN4wD0cJ5";

const SERVER_INFO = { name: "maquinita-mcp", version: "1.0.0" };
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
}): Promise<{ id: string; native_currency: string }> {
  const { data, error } = await supabase
    .from("accounts")
    .select("id, name, native_currency")
    .eq("user_id", OWNER_USER_ID);
  if (error) throw new Error(error.message);

  if (args.account_id) {
    const a = data.find((x) => x.id === args.account_id);
    if (!a) throw new Error(`account_id no encontrado: ${args.account_id}`);
    return { id: a.id, native_currency: a.native_currency };
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
    return { id: a.id, native_currency: a.native_currency };
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
    is_extraordinary: t.is_extraordinary ?? false,
    installments: t.installments ?? null,
    statement_period: t.statement_period ?? null,
  };
}

// --- Tool implementations ----------------------------------------------------

// deno-lint-ignore no-explicit-any
const handlers: Record<string, (args: any) => Promise<unknown>> = {
  async leer_cuentas() {
    const { data, error } = await supabase
      .from("accounts")
      .select("id, name, type, native_currency, is_active")
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
  is_extraordinary: { type: "boolean", description: "true para gastos one-off (pasajes, electrodomésticos)." },
  installments: { type: "string", description: "ej '1 de 1', '3 de 6'." },
  statement_period: { type: "string", description: "ej '2026-04-30 a 2026-05-28'." },
};

const TOOLS = [
  {
    name: "leer_cuentas",
    description: "Lista las cuentas del dueño (id, nombre, tipo, moneda). Usalo para resolver nombre→id.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "leer_categorias",
    description: "Lista las categorías del dueño (id, nombre, color). Usalo para resolver nombre→id.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "registrar_transaccion",
    description:
      "Inserta un consumo individual de un extracto. Calcula amount_usd si no se pasa. Stampa el user_id del dueño.",
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
    name: "leer_resumen_gastos",
    description:
      "Devuelve total y desglose por categoría de un mes (YYYY-MM; sin mes = todo). Excluye pagos/devoluciones.",
    inputSchema: {
      type: "object",
      properties: { month: { type: "string", description: "Mes YYYY-MM. Opcional." } },
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
