import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveRate, calculateUsd } from "./fx";

/** open.er-api.com's success shape. */
function mockRate(rate: number) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({ result: "success", rates: { USD: rate } }),
  } as Response);
}

afterEach(() => vi.restoreAllMocks());

describe("resolveRate", () => {
  it("returns 1 for USD without a network call", async () => {
    const fetchSpy = mockRate(0.00024);
    expect(await resolveRate("usd")).toEqual({ ok: true, rate: 1 });
    expect(await resolveRate("USDT")).toEqual({ ok: true, rate: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches a currency once and serves the rest from cache", async () => {
    // Reprocessing a month asks for the same rate hundreds of times; the free
    // upstream API rate-limits, and a 429 turns into fx_pending transactions.
    const fetchSpy = mockRate(0.00025);

    const first = await resolveRate("COP");
    const second = await resolveRate("cop");

    expect(first).toEqual({ ok: true, rate: 0.00025 });
    expect(second).toEqual({ ok: true, rate: 0.00025 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure", async () => {
    const failing = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 429 } as Response);
    expect(await resolveRate("ARS")).toEqual({ ok: false, reason: "error" });
    // Both the primary and the fallback endpoint were tried.
    expect(failing.mock.calls.length).toBeGreaterThanOrEqual(2);

    failing.mockRestore();
    mockRate(0.001);
    expect(await resolveRate("ARS")).toEqual({ ok: true, rate: 0.001 });
  });
});

describe("calculateUsd", () => {
  it("rounds to 4 decimals", () => {
    expect(calculateUsd(33300, 0.000244)).toBe(8.1252);
    expect(calculateUsd(1, 1)).toBe(1);
  });
});
