export type FxResult =
  | { ok: true; rate: number }
  | { ok: false; reason: "timeout" | "error" };

/**
 * Primary FX API: open.er-api.com (free, no API key, supports COP)
 * Format: https://open.er-api.com/v6/latest/COP
 * Response: { "result": "success", "rates": { "USD": 0.000278 } }
 *
 * Fallback: frankfurter.app (ECB data, no COP support)
 */
const PRIMARY_FX_URL = "https://open.er-api.com/v6/latest";
const FALLBACK_FX_URL = "https://api.frankfurter.app/latest";

/**
 * Get exchange rate from FX service.
 * Uses FX_SERVICE_URL env var if set, otherwise tries open.er-api.com then frankfurter.
 */
export async function getExchangeRate(
  from: string,
  to: string,
  timeoutMs: number = 5000,
): Promise<FxResult> {
  const customUrl = process.env.FX_SERVICE_URL;

  if (customUrl) {
    return fetchRate(customUrl, from, to, timeoutMs);
  }

  // Try primary (open.er-api.com — supports COP, BRL, etc.)
  const primary = await fetchRateOpenEr(from, to, timeoutMs);
  if (primary.ok) return primary;

  // Fallback to frankfurter.app
  return fetchRate(FALLBACK_FX_URL, from, to, timeoutMs);
}

/** Fetch from open.er-api.com which uses /v6/latest/{FROM} format */
async function fetchRateOpenEr(
  from: string,
  to: string,
  timeoutMs: number,
): Promise<FxResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${PRIMARY_FX_URL}/${encodeURIComponent(from)}`;
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      return { ok: false, reason: "error" };
    }

    const data = await response.json();

    if (data.result === "success" && data.rates && typeof data.rates[to] === "number") {
      return { ok: true, rate: data.rates[to] };
    }

    return { ok: false, reason: "error" };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "error" };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch from frankfurter-style API (?from=X&to=Y format) */
async function fetchRate(
  baseUrl: string,
  from: string,
  to: string,
  timeoutMs: number,
): Promise<FxResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${baseUrl}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      return { ok: false, reason: "error" };
    }

    const data = await response.json();

    // Support frankfurter.app format: { "rates": { "USD": 0.000234 } }
    if (data.rates && typeof data.rates[to] === "number") {
      return { ok: true, rate: data.rates[to] };
    }

    // Support generic format: { "rate": 0.000234 }
    if (typeof data.rate === "number" && isFinite(data.rate)) {
      return { ok: true, rate: data.rate };
    }

    return { ok: false, reason: "error" };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve rate for a native currency to USD.
 * If USD or USDT, return rate=1 without network call.
 * Otherwise fetch from FX service.
 */
export async function resolveRate(nativeCurrency: string): Promise<FxResult> {
  const upper = nativeCurrency.toUpperCase();
  if (upper === "USD" || upper === "USDT") {
    return { ok: true, rate: 1 };
  }
  return getExchangeRate(upper, "USD");
}

/**
 * Calculate amount_usd rounded to 4 decimals.
 */
export function calculateUsd(amountNative: number, rate: number): number {
  return Math.round(amountNative * rate * 10000) / 10000;
}
