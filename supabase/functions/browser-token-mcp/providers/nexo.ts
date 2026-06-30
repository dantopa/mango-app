// =============================================================================
// browser-token-mcp — Nexo Provider Module
// =============================================================================
// Read-only tools for the Nexo platform:
// - nexo_get_balances: account balances
// - nexo_get_card_transactions: Nexo Card spending history
// =============================================================================

import type { NexoSessionToken, ProviderModule, ToolResult } from "../types.ts";
import { redactToken, sanitizeError } from "../security.ts";

const NEXO_BASE = "https://platform.nexo.com";
const BALANCES_PATH = "/api/1/get_balances";
const ENVELOPES_PATH = "/api/platform/envelope/v1/envelopes";
const REQUEST_TIMEOUT_MS = 15_000;

export const nexoProvider: ProviderModule = {
  name: "nexo",

  tools: [
    {
      name: "nexo_get_balances",
      description:
        "Retrieves Nexo account balances (read-only). Returns assets with currency, available balance, and total balance.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "nexo_get_card_transactions",
      description:
        "Retrieves Nexo Card spending transactions (read-only). Returns card purchases with merchant, amount_usd, date, category, and cashback. Use limit/offset for pagination.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of transactions (default 50, max 100)" },
          offset: { type: "number", description: "Pagination offset (default 0)" },
        },
        required: [],
      },
    },
  ],

  async handle(toolName, params, token): Promise<ToolResult> {
    let sessionToken: NexoSessionToken;
    try {
      sessionToken = JSON.parse(token) as NexoSessionToken;
      if (!sessionToken.nsi || !sessionToken.esi || !sessionToken.installation_id) {
        throw new Error("Missing fields");
      }
    } catch {
      return errorResult("Invalid session token for provider 'nexo'. Push a valid token via the refresh endpoint.");
    }

    switch (toolName) {
      case "nexo_get_balances":
        return await handleGetBalances(sessionToken, token);
      case "nexo_get_card_transactions":
        return await handleGetCardTransactions(sessionToken, token, params);
      default:
        return errorResult(`Unknown tool: ${toolName}`);
    }
  },
};

// --- Shared ------------------------------------------------------------------

function errorResult(msg: string): ToolResult {
  return { content: [{ type: "text", text: `ERROR: ${msg}` }], isError: true };
}

function buildHeaders(s: NexoSessionToken): Record<string, string> {
  // Nexo no longer uses JSESSIONID — session is via nsi + esi + nexo_session_id cookies
  const cookieParts = [`nsi=${s.nsi}`, `esi=${s.esi}`];
  if (s.jsessionid && s.jsessionid !== 'none') {
    cookieParts.push(`nexo_session_id=${s.jsessionid}`);
  }
  cookieParts.push(`nexo_installation_id=${s.installation_id}`);

  return {
    Cookie: cookieParts.join("; "),
    "x-nexo-installation-id": s.installation_id,
    correlationid: crypto.randomUUID(),
    "platform-name": "Web",
    accept: "application/json",
    origin: NEXO_BASE,
    referer: `${NEXO_BASE}/`,
    "content-type": "application/json",
  };
}

async function nexoFetch(
  url: string, s: NexoSessionToken, token: string, method = "POST", body: string | null = null,
): Promise<ToolResult | Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers: buildHeaders(s), body, signal: controller.signal });
    clearTimeout(timeout);
    if (res.status === 401 || res.status === 403) {
      return errorResult("Session token for provider 'nexo' has expired. Re-login and push a new token.");
    }
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).substring(0, 200); } catch { detail = ""; }
      return errorResult(`Nexo API HTTP ${res.status}. ${redactToken(detail, token)}`);
    }
    return res;
  } catch (e: unknown) {
    clearTimeout(timeout);
    if (e instanceof DOMException && e.name === "AbortError") {
      return errorResult("Request to Nexo timed out (15s).");
    }
    return errorResult(`Network error: ${redactToken(sanitizeError(e), token)}`);
  }
}

// --- Balances ----------------------------------------------------------------

async function handleGetBalances(s: NexoSessionToken, token: string): Promise<ToolResult> {
  const res = await nexoFetch(`${NEXO_BASE}${BALANCES_PATH}`, s, token, "POST", "{}");
  if (!(res instanceof Response)) return res;
  const data = await res.json();
  return { content: [{ type: "text", text: JSON.stringify(formatBalances(data)) }] };
}

function formatBalances(data: unknown): {
  total_portfolio_usd: number;
  available_today_usd: number;
  locked_term_usd: number;
  balances: Array<{
    currency: string;
    wallet_liquid: string;
    flexible_earn: string;
    locked_term: string;
    total: string;
    total_usd: number;
  }>;
} {
  if (!data || typeof data !== "object") {
    return { total_portfolio_usd: 0, available_today_usd: 0, locked_term_usd: 0, balances: [] };
  }
  const root = data as Record<string, unknown>;
  const p = (root.payload ?? {}) as Record<string, unknown>;
  const entries: unknown[] = Array.isArray(p.balances) ? p.balances : [];
  const out: Array<{
    currency: string;
    wallet_liquid: string;
    flexible_earn: string;
    locked_term: string;
    total: string;
    total_usd: number;
  }> = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    const total = Number(r.total_balance ?? 0);
    if (total > 0) {
      const usdCourse = Number(r.usd_course ?? 0);
      out.push({
        currency: String(r.short_name ?? ""),
        wallet_liquid: String(r.credit_line_balance ?? r.balance ?? "0"),
        flexible_earn: String(r.deposit_balance ?? "0"),
        locked_term: String(r.locked_balance ?? "0"),
        total: String(total),
        total_usd: Math.round(total * usdCourse * 1e4) / 1e4,
      });
    }
  }
  const availableToday =
    Number(p.total_amount_in_deposit_wallet_in_usd ?? 0) + Number(p.total_amount_in_credit_wallet_in_usd ?? 0);
  return {
    total_portfolio_usd: Math.round(Number(p.total_portfolio_balance ?? 0) * 1e4) / 1e4,
    available_today_usd: Math.round(availableToday * 1e4) / 1e4,
    locked_term_usd: Math.round(Number(p.total_amount_in_locked_wallet_in_usd ?? 0) * 1e4) / 1e4,
    balances: out,
  };
}

// --- Card Transactions -------------------------------------------------------

async function handleGetCardTransactions(
  s: NexoSessionToken, token: string, params: Record<string, unknown>,
): Promise<ToolResult> {
  const limit = Math.min(Number(params.limit) || 50, 100);
  const offset = Number(params.offset) || 0;
  const url = `${NEXO_BASE}${ENVELOPES_PATH}?limit=${limit}&sortType=DESC&offset=${offset}`;
  const res = await nexoFetch(url, s, token, "GET");
  if (!(res instanceof Response)) return res;
  const data = await res.json();
  return { content: [{ type: "text", text: JSON.stringify(formatCardTransactions(data)) }] };
}

interface CardTx {
  date: string;
  merchant: string;
  category: string;
  amount_usd: number;
  amount_local: string;
  local_currency: string;
  cashback_usd: string;
  status: string;
  type: string;
}

function formatCardTransactions(data: unknown): CardTx[] {
  if (!data || typeof data !== "object") return [];
  const root = data as Record<string, unknown>;
  const envelopes = Array.isArray(root.envelopes) ? root.envelopes : [];

  const out: CardTx[] = [];
  for (const env of envelopes) {
    if (!env || typeof env !== "object") continue;
    const e = env as Record<string, unknown>;

    // Only include card transactions
    const type = String(e.type ?? "");
    if (type !== "NEXO_CARD_AUTHORIZATION") continue;

    const status = String(e.status ?? "");
    if (status === "REJECTED") continue; // skip failed transactions

    const domainData = e.domainData as Record<string, unknown> | undefined;
    const card = domainData?.nexoCard as Record<string, unknown> | undefined;

    const amountUsd = Math.abs(Number(e.creditAmount ?? 0));
    const date = e.displayTime
      ? new Date(Number(e.displayTime) * 1000).toISOString().split("T")[0]
      : "";

    out.push({
      date,
      merchant: String(card?.merchantName ?? e.details ?? ""),
      category: String(card?.merchantCategory ?? ""),
      amount_usd: amountUsd,
      amount_local: String(card?.localCurrencyAmount ?? ""),
      local_currency: String(card?.localCurrencyCode ?? ""),
      cashback_usd: String(card?.rewardAmountUsd ?? "0"),
      status,
      type: String(card?.cardMode ?? ""),
    });
  }
  return out;
}
