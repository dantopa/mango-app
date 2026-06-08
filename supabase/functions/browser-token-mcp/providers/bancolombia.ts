// =============================================================================
// browser-token-mcp — Bancolombia Provider Module
// =============================================================================
// Read-only tools for Bancolombia:
// - bancolombia_get_accounts: list accounts, balances, investments
// - bancolombia_get_transactions: account movements
// Auth: Bearer token (from Sucursal Virtual session)
// =============================================================================

import type { ProviderModule, ToolResult } from "../types.ts";
import { redactToken, sanitizeError } from "../security.ts";

const BASE = "https://canalpersonas-ext.apps.bancolombia.com";
const ACCOUNTS_PATH = "/super-svp/api/v1/security-filters/ch-ms-deposits/hybrid/accounts/customization/consolidated-balance";
const INVESTMENTS_PATH = "/super-svp/api/v1/security-filters/super-svp-ch-ms-sale-virtual-investment/customization/list";
const TRANSACTIONS_PATH = "/super-svp/api/v1/security-filters/ch-ms-deposits/account/transactions";
const TIMEOUT_MS = 15_000;

interface BancolombiaToken {
  bearer: string;
  session_tracker: string;
  device_id: string;
  ip?: string;
}

export const bancolombiaProvider: ProviderModule = {
  name: "bancolombia",

  tools: [
    {
      name: "bancolombia_get_accounts",
      description:
        "Lists Bancolombia accounts with balances (COP) and investments. Returns savings accounts with available/current balance plus active investment products with amounts and rates.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "bancolombia_get_transactions",
      description:
        "Retrieves Bancolombia account transactions. Returns movements with date, description, amount (COP), type (CREDITO=outflow, DEBITO=inflow). Includes QR payments, PSE, transfers, etc.",
      inputSchema: {
        type: "object",
        properties: {
          account_number: { type: "string", description: "Account number without dashes (e.g. '23044359898')" },
          page: { type: "number", description: "Page for pagination (default 1)" },
          date_from: { type: "string", description: "Start date YYYY/MM/DD (optional)" },
          date_to: { type: "string", description: "End date YYYY/MM/DD (optional)" },
        },
        required: ["account_number"],
      },
    },
  ],

  async handle(toolName, params, token): Promise<ToolResult> {
    let s: BancolombiaToken;
    try {
      s = JSON.parse(token) as BancolombiaToken;
      if (!s.bearer || !s.session_tracker || !s.device_id) throw new Error("missing");
    } catch {
      return err("Invalid token for 'bancolombia'. Push a valid token via refresh endpoint.");
    }

    switch (toolName) {
      case "bancolombia_get_accounts":
        return await handleGetAccounts(s, token);
      case "bancolombia_get_transactions":
        return await handleGetTransactions(s, token, params);
      default:
        return err(`Unknown tool: ${toolName}`);
    }
  },
};

// --- Helpers -----------------------------------------------------------------

function err(msg: string): ToolResult {
  return { content: [{ type: "text", text: `ERROR: ${msg}` }], isError: true };
}

function headers(s: BancolombiaToken): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    Authorization: `Bearer ${s.bearer}`,
    "app-version": "3.10.3",
    channel: "SVP",
    "device-id": s.device_id,
    "device-info": '{"device":"Apple","os":"Mac OS","browser":"Chrome-149","major":"149"}',
    "session-tracker": s.session_tracker,
    "message-id": crypto.randomUUID(),
    "request-timestamp": formatTimestamp(),
    "platform-type": "web",
    origin: "https://svpersonas.apps.bancolombia.com",
    referer: "https://svpersonas.apps.bancolombia.com/",
  };
  if (s.ip) h["ip"] = s.ip;
  return h;
}

function formatTimestamp(): string {
  const d = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}:${pad(d.getMilliseconds(), 3)}`;
}

async function bcFetch(url: string, s: BancolombiaToken, token: string, method = "GET", body?: string): Promise<ToolResult | Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers: headers(s), body: body ?? null, signal: controller.signal });
    clearTimeout(timeout);
    if (res.status === 401 || res.status === 403) {
      return err("Session token for 'bancolombia' expired. Re-login and push a new token.");
    }
    if (!res.ok) {
      let d = ""; try { d = (await res.text()).substring(0, 200); } catch { /* */ }
      return err(`Bancolombia HTTP ${res.status}. ${redactToken(d, token)}`);
    }
    return res;
  } catch (e: unknown) {
    clearTimeout(timeout);
    if (e instanceof DOMException && e.name === "AbortError") return err("Bancolombia timed out (15s).");
    return err(`Network error: ${redactToken(sanitizeError(e), token)}`);
  }
}

// --- Get Accounts + Investments ----------------------------------------------

async function handleGetAccounts(s: BancolombiaToken, token: string): Promise<ToolResult> {
  // Fetch accounts (GET request)
  const accRes = await bcFetch(`${BASE}${ACCOUNTS_PATH}`, s, token, "GET");
  if (!(accRes instanceof Response)) return accRes;
  const accData = await accRes.json();

  // Fetch investments (GET request)
  const invRes = await bcFetch(`${BASE}${INVESTMENTS_PATH}`, s, token, "GET");
  let investments: unknown[] = [];
  if (invRes instanceof Response) {
    const invData = await invRes.json();
    investments = Array.isArray(invData?.data) ? invData.data : [];
  }

  const result = formatAccounts(accData, investments);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

interface AccountInfo {
  number: string;
  name: string;
  type: string;
  currency: string;
  available: number;
  current: number;
  status: string;
}

interface InvestmentInfo {
  number: string;
  amount: string;
  currency: string;
  rate: string;
  start_date: string;
  end_date: string;
}

function formatAccounts(data: unknown, investments: unknown[]): { accounts: AccountInfo[]; investments: InvestmentInfo[] } {
  const accounts: AccountInfo[] = [];
  const root = data as Record<string, unknown>;
  const d = root?.data as Record<string, unknown>;
  const accs = d?.accounts as Array<Record<string, unknown>> ?? [];

  for (const a of accs) {
    const balances = a.balances as Record<string, number> ?? {};
    accounts.push({
      number: String(a.number ?? ""),
      name: String(a.name ?? ""),
      type: String(a.type ?? ""),
      currency: String(a.currency ?? "COP"),
      available: Number(balances.available ?? 0),
      current: Number(balances.current ?? 0),
      status: String(a.status ?? ""),
    });
  }

  const invs: InvestmentInfo[] = [];
  for (const inv of investments) {
    const i = inv as Record<string, unknown>;
    const bal = i.balance as Record<string, unknown> ?? {};
    invs.push({
      number: String(i.number ?? ""),
      amount: String(bal.amount ?? "0"),
      currency: String(bal.currency ?? "COP"),
      rate: String(i.rate ?? ""),
      start_date: String(i.startDate ?? ""),
      end_date: String(i.endDate ?? ""),
    });
  }

  return { accounts, investments: invs };
}

// --- Get Transactions --------------------------------------------------------

async function handleGetTransactions(s: BancolombiaToken, token: string, params: Record<string, unknown>): Promise<ToolResult> {
  const accountNumber = String(params.account_number ?? "");
  if (!accountNumber) return err("account_number is required");

  const page = Number(params.page) || 1;
  const dateFrom = String(params.date_from ?? "");
  const dateTo = String(params.date_to ?? "");

  const body = JSON.stringify({
    account: { number: accountNumber, type: "CUENTA_DE_AHORRO" },
    pagination: { key: page },
    filter: { dateFrom, dateTo, description: "" },
  });

  const res = await bcFetch(`${BASE}${TRANSACTIONS_PATH}`, s, token, "POST", body);
  if (!(res instanceof Response)) return res;

  const data = await res.json();
  return { content: [{ type: "text", text: JSON.stringify(formatTransactions(data)) }] };
}

interface BankTx {
  date: string;
  description: string;
  amount: number;
  type: string;
  office: string;
}

function formatTransactions(data: unknown): BankTx[] {
  const root = data as Record<string, unknown>;
  const d = root?.data as Record<string, unknown>;
  const txs = d?.transactions as Array<Record<string, unknown>> ?? [];

  const out: BankTx[] = [];
  for (const tx of txs) {
    out.push({
      date: String(tx.transactionDate ?? ""),
      description: String(tx.description ?? ""),
      amount: Number(tx.amount ?? 0),
      type: String(tx.type ?? ""),
      office: String((tx.office as Record<string, unknown>)?.name ?? ""),
    });
  }
  return out;
}
