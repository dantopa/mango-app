export type FxResult =
  | { ok: true; rate: number }
  | { ok: false; reason: "timeout" | "error" };

/**
 * Default FX API: frankfurter.app (free, no API key needed)
 * Format: https://api.frankfurter.app/latest?from=COP&to=USD
 * Response: { "rates": { "USD": 0.000234 } }
 */
const DEFAULT_FX_URL = "https://api.frankfurter.app/latest";

/**
 * Get exchange rate from FX service.
 * Uses FX_SERVICE_URL env var if set, otherwise falls back to frankfurter.app.
 */
export async function getExchangeRate(
  from: string,
  to: string,
  timeoutMs: number = 3000,
): Promise<FxResult> {
  const baseUrl = process.env.FX_SERVICE_URL || DEFAULT_FX_URL;

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
