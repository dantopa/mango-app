export type FxResult =
  | { ok: true; rate: number }
  | { ok: false; reason: "timeout" | "error" };

/**
 * Get exchange rate from configurable FX service.
 * Reads FX_SERVICE_URL from env. Uses AbortController for timeout (default 2000ms).
 */
export async function getExchangeRate(
  from: string,
  to: string,
  timeoutMs: number = 2000,
): Promise<FxResult> {
  const baseUrl = process.env.FX_SERVICE_URL;
  if (!baseUrl) {
    return { ok: false, reason: "error" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${baseUrl}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      return { ok: false, reason: "error" };
    }

    const data = (await response.json()) as { rate?: number };
    if (typeof data.rate !== "number" || !isFinite(data.rate)) {
      return { ok: false, reason: "error" };
    }

    return { ok: true, rate: data.rate };
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
