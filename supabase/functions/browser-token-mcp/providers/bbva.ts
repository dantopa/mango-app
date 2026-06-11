// =============================================================================
// browser-token-mcp — BBVA Argentina Provider Module
// =============================================================================
// Read-only tools for BBVA Argentina:
// - bbva_get_cards: list credit cards (Visa/Mastercard)
// - bbva_get_card_transactions: card movements with filtering
// Auth: tsec + uid + xsrf_token (from Online Banking session)
// =============================================================================

import type { ProviderModule, ToolResult } from "../types.ts";
import { redactToken, sanitizeError } from "../security.ts";

const BASE = "https://online.bbva.com.ar/fnetcore";
const CARDS_PATH = "/servicios/cliente/productos/tarjetas";
const TRANSACTIONS_PATH = "/servicios/cards/v1/cards";
const TIMEOUT_MS = 15_000;

interface BbvaToken {
  tsec: string;
  uid: string;
  xsrf_token: string;
}

export const bbvaProvider: ProviderModule = {
  name: "bbva",

  tools: [
    {
      name: "bbva_get_cards",
      description:
        "Lists BBVA Argentina credit cards (Visa and Mastercard). Returns card id (numeroPan), brand, last 4 digits, and display name.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "bbva_get_card_transactions",
      description:
        "Retrieves BBVA Argentina credit card transactions. Returns movements with date, merchant, amount (ARS/USD), installments, type, and international flag. Only charges are included (payments/credits excluded).",
      inputSchema: {
        type: "object",
        properties: {
          card_id: { type: "string", description: "Card numeroPan identifier (from bbva_get_cards)" },
          date_from: { type: "string", description: "Start date YYYY-MM-DD (optional, client-side filter)" },
          date_to: { type: "string", description: "End date YYYY-MM-DD (optional, client-side filter)" },
        },
        required: ["card_id"],
      },
    },
  ],

  async handle(toolName, params, token): Promise<ToolResult> {
    const s = parseToken(token);
    if (!s) return err("Invalid token for 'bbva'. Push a valid token via refresh endpoint.");

    switch (toolName) {
      case "bbva_get_cards":
        return await handleGetCards(s, token);
      case "bbva_get_card_transactions":
        return await handleGetCardTransactions(s, token, params);
      default:
        return err(`Unknown tool: ${toolName}`);
    }
  },
};

// --- Helpers -----------------------------------------------------------------

function err(msg: string): ToolResult {
  return { content: [{ type: "text", text: `ERROR: ${msg}` }], isError: true };
}

function parseToken(token: string): BbvaToken | null {
  try {
    const parsed = JSON.parse(token) as BbvaToken;
    if (!parsed.tsec || !parsed.uid || !parsed.xsrf_token) return null;
    return parsed;
  } catch {
    return null;
  }
}

function headers(s: BbvaToken): Record<string, string> {
  return {
    "tsec": s.tsec,
    "uid": s.uid,
    "x-xsrf-token": s.xsrf_token,
    "rcp-id": "16000004|AR0017",
    "accept": "application/json",
    "referer": "https://online.bbva.com.ar/fnetcore/",
    "timestamp-uid": new Date().toISOString(),
  };
}

async function bbvaFetch(url: string, s: BbvaToken, token: string): Promise<ToolResult | Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", headers: headers(s), signal: controller.signal });
    clearTimeout(timeout);
    if (res.status === 401 || res.status === 403) {
      return err("Session token for 'bbva' expired. Re-login and push a new token.");
    }
    if (!res.ok) {
      let d = ""; try { d = (await res.text()).substring(0, 200); } catch { /* */ }
      return err(`BBVA HTTP ${res.status}. ${redactToken(d, token)}`);
    }
    // BBVA rotates tsec on each response — capture the new one for subsequent calls
    const newTsec = res.headers.get("tsec");
    if (newTsec) {
      s.tsec = newTsec;
    }
    return res;
  } catch (e: unknown) {
    clearTimeout(timeout);
    if (e instanceof DOMException && e.name === "AbortError") return err("BBVA timed out (15s).");
    return err(`Network error: ${redactToken(sanitizeError(e), token)}`);
  }
}

// --- Get Cards ---------------------------------------------------------------

interface BbvaCard {
  id: string;
  brand: "VISA" | "MASTERCARD";
  last4: string;
  name: string;
}

async function handleGetCards(s: BbvaToken, token: string): Promise<ToolResult> {
  const ts = Date.now();
  const url = `${BASE}${CARDS_PATH}?ts=${ts}`;

  const res = await bbvaFetch(url, s, token);
  if (!(res instanceof Response)) return res;

  const data = await res.json();
  const cards = formatCards(data);
  return { content: [{ type: "text", text: JSON.stringify(cards) }] };
}

function formatCards(data: unknown): BbvaCard[] {
  const cards: BbvaCard[] = [];
  const root = data as Record<string, unknown>;
  const result = root?.result as Record<string, unknown> ?? {};

  const visaCards = result.tarjetasCreditoVisa as Array<Record<string, unknown>> ?? [];
  for (const c of visaCards) {
    cards.push({
      id: String(c.numeroPan ?? ""),
      brand: "VISA",
      last4: extractLast4(String(c.numero ?? "")),
      name: "BBVA Visa",
    });
  }

  const mcCards = result.tarjetasCreditoMastercard as Array<Record<string, unknown>> ?? [];
  for (const c of mcCards) {
    cards.push({
      id: String(c.numeroPan ?? ""),
      brand: "MASTERCARD",
      last4: extractLast4(String(c.numero ?? "")),
      name: "BBVA Mastercard",
    });
  }

  return cards;
}

function extractLast4(numero: string): string {
  // Format: "****9253" → "9253"
  const match = numero.match(/(\d{4})$/);
  return match ? match[1] : numero.slice(-4);
}

// --- Get Card Transactions ---------------------------------------------------

interface BbvaTx {
  date: string;
  merchant: string;
  amount: number;
  currency: "ARS" | "USD";
  installments: string | null;
  type: string;
  international: boolean;
}

async function handleGetCardTransactions(s: BbvaToken, token: string, params: Record<string, unknown>): Promise<ToolResult> {
  const cardId = String(params.card_id ?? "");
  if (!cardId) return err("card_id is required");

  const dateFrom = String(params.date_from ?? "");
  const dateTo = String(params.date_to ?? "");

  const ts = Date.now();
  const url = `${BASE}${TRANSACTIONS_PATH}/${cardId}/transactions?ts=${ts}`;

  const res = await bbvaFetch(url, s, token);
  if (!(res instanceof Response)) return res;

  const data = await res.json();
  const txs = formatTransactions(data, dateFrom, dateTo);
  return { content: [{ type: "text", text: JSON.stringify(txs) }] };
}

function formatTransactions(data: unknown, dateFrom: string, dateTo: string): BbvaTx[] {
  const root = data as Record<string, unknown>;
  const rawTxs = (root?.data ?? root?.transactions ?? []) as Array<Record<string, unknown>>;

  const out: BbvaTx[] = [];
  for (const tx of rawTxs) {
    const localAmount = tx.localAmount as Record<string, unknown> ?? {};
    const amount = parseFloat(String(localAmount.amount ?? "0"));

    // Only include charges (positive amounts); skip payments/credits
    if (amount <= 0) continue;

    const operationDate = String(tx.operationDate ?? "");
    const date = operationDate.substring(0, 10); // "2026-06-09T00:00:00.000-0300" → "2026-06-09"

    // Client-side date filtering
    if (dateFrom && date < dateFrom) continue;
    if (dateTo && date > dateTo) continue;

    const transactionType = tx.transactionType as Record<string, unknown> ?? {};
    const financingType = String(tx.financingType ?? "");

    out.push({
      date,
      merchant: String(tx.concept ?? ""),
      amount: Math.abs(amount),
      currency: String(localAmount.currency ?? "ARS") as "ARS" | "USD",
      installments: financingType === "NON_FINANCING" ? null : (String(tx.installments ?? "") || null),
      type: String(transactionType.id ?? ""),
      international: Boolean(tx.international),
    });
  }

  return out;
}
