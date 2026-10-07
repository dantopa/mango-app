import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateDevice = vi.fn();
vi.mock("@/lib/push-ingest/devices", () => ({ authenticateDevice: (...args: unknown[]) => authenticateDevice(...args) }));

const from = vi.fn();
vi.mock("@/lib/push-ingest/supabase-admin", () => ({ getSupabaseAdmin: () => ({ from }) }));

import { resetRateLimit } from "@/lib/push-ingest/rate-limiter";

import { GET } from "./route";

/**
 * A query builder whose every chain resolves to `result`, whatever the order;
 * a chain ending in `maybeSingle()` resolves to `single` instead (one row).
 */
function query(result: unknown, single: unknown = result) {
  const q: Record<string, unknown> = {};
  for (const method of ["select", "eq", "gt", "gte", "lte", "order", "limit", "range"]) q[method] = () => q;
  q.maybeSingle = () => Promise.resolve(single);
  q.then = (resolve: (v: unknown) => void) => resolve(result);
  return q;
}

function request(headers: Record<string, string> = {}) {
  return new Request("https://app.test/api/widget", { headers });
}

describe("GET /api/widget", () => {
  beforeEach(() => {
    authenticateDevice.mockReset();
    from.mockReset();
    resetRateLimit();
    process.env.PUSH_INGEST_SECRET = "shared-secret";
  });

  it("rejects a request without a token, without touching the database", async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });

  it("does not accept the shared ingest secret: only a paired device reads spending", async () => {
    authenticateDevice.mockResolvedValue(null);
    const res = await GET(request({ authorization: "Bearer shared-secret" }));
    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });

  it("answers a paired device with its own summary, uncached", async () => {
    authenticateDevice.mockResolvedValue({ id: "d1", userId: "user-1" });
    from.mockImplementation((table: string) => {
      if (table === "user_settings") return query({ data: { budget_ceiling_usd: 3100 }, error: null });
      return query(
        { data: [{ amount_usd: "400" }, { amount_usd: 100.5 }], error: null },
        { data: { merchant: "RAPPI", amount_usd: 12.4, tx_date: "2026-10-12", created_at: "2026-10-12T19:32:00Z" }, error: null },
      );
    });

    const res = await GET(request({ authorization: "Bearer device-token" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.spent_usd).toBe(500.5);
    expect(body.ceiling_usd).toBe(3100);
    expect(body.last).toMatchObject({ merchant: "RAPPI", amount_usd: 12.4 });
    expect(authenticateDevice).toHaveBeenCalledWith("device-token", expect.any(Date));
  });

  it("scopes every read to the device's user", async () => {
    authenticateDevice.mockResolvedValue({ id: "d1", userId: "user-1" });
    const eq = vi.fn();
    from.mockImplementation(() => {
      const q = query({ data: [], error: null });
      q.eq = (column: string, value: unknown) => {
        eq(column, value);
        return q;
      };
      return q;
    });

    await GET(request({ authorization: "Bearer device-token" }));

    const userFilters = eq.mock.calls.filter(([column]) => column === "user_id");
    expect(userFilters.length).toBeGreaterThanOrEqual(3);
    expect(userFilters.every(([, value]) => value === "user-1")).toBe(true);
  });

  it("fails closed with a generic error", async () => {
    authenticateDevice.mockResolvedValue({ id: "d1", userId: "user-1" });
    from.mockImplementation(() => query({ data: null, error: { message: "secret db detail" } }));

    const res = await GET(request({ authorization: "Bearer device-token" }));

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret db detail");
  });
});
