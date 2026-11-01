import { beforeEach, describe, expect, it, vi } from "vitest";

const authenticateDevice = vi.fn();
vi.mock("@/lib/push-ingest/devices", () => ({ authenticateDevice: (...args: unknown[]) => authenticateDevice(...args) }));

const getUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser } }) }));

const from = vi.fn();
vi.mock("@/lib/push-ingest/supabase-admin", () => ({ getSupabaseAdmin: () => ({ from }) }));

import { OWNER_USER_ID } from "@/lib/owner";
import { resetRateLimit } from "@/lib/push-ingest/rate-limiter";

import { GET, POST } from "./route";

function query(result: unknown) {
  const q: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order"]) q[method] = () => q;
  q.then = (resolve: (v: unknown) => void) => resolve(result);
  return q;
}

function request(method: "GET" | "POST", headers: Record<string, string> = {}, body?: unknown) {
  return new Request("https://app.test/api/push-ingest/apps", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/push-ingest/apps", () => {
  beforeEach(() => {
    authenticateDevice.mockReset();
    getUser.mockReset().mockResolvedValue({ data: { user: null } });
    from.mockReset();
    resetRateLimit();
    process.env.PUSH_INGEST_SECRET = "shared-secret";
  });

  it("rejects the shared ingest secret: it posts notifications, it does not decide what is read", async () => {
    authenticateDevice.mockResolvedValue(null);
    const res = await GET(request("GET", { authorization: "Bearer shared-secret" }));
    expect(res.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });

  it("gives a paired phone the defaults plus its user's decisions", async () => {
    authenticateDevice.mockResolvedValue({ id: "d1", userId: "user-1" });
    from.mockReturnValue(
      query({
        data: [
          { package_name: "com.mercadopago.wallet", label: "Mercado Pago", decision: "allowed" },
          { package_name: "com.grability.rappi", label: "Rappi", decision: "blocked" },
        ],
        error: null,
      }),
    );

    const res = await GET(request("GET", { authorization: "Bearer device-token" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.allowed).toContain("com.mercadopago.wallet");
    expect(body.allowed).toContain("com.brubank");
    expect(body.allowed).not.toContain("com.grability.rappi");
    expect(body.blocked).toContain("com.grability.rappi");
    expect(body.blocked).toContain("com.whatsapp");
  });

  it("records the phone's answer for its own user", async () => {
    authenticateDevice.mockResolvedValue({ id: "d1", userId: "user-1" });
    const upsert = vi.fn().mockResolvedValue({ error: null });
    from.mockReturnValue({ upsert });

    const res = await POST(
      request("POST", { authorization: "Bearer device-token" }, { packageName: "com.brubank", label: "Brubank", decision: "allowed" }),
    );

    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "user-1", package_name: "com.brubank", decision: "allowed", decided_via: "device" }),
      { onConflict: "user_id,package_name" },
    );
  });

  it("refuses to allow a chat app", async () => {
    authenticateDevice.mockResolvedValue({ id: "d1", userId: "user-1" });
    const res = await POST(
      request("POST", { authorization: "Bearer device-token" }, { packageName: "com.whatsapp", decision: "allowed" }),
    );
    expect(res.status).toBe(422);
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects something that is not a package name", async () => {
    authenticateDevice.mockResolvedValue({ id: "d1", userId: "user-1" });
    const res = await POST(request("POST", { authorization: "Bearer device-token" }, { packageName: "x; drop", decision: "allowed" }));
    expect(res.status).toBe(400);
  });

  it("lets the owner's browser session decide too, marked as web", async () => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER_USER_ID } } });
    const upsert = vi.fn().mockResolvedValue({ error: null });
    from.mockReturnValue({ upsert });

    const res = await POST(request("POST", {}, { packageName: "com.grability.rappi", decision: "blocked" }));

    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ user_id: OWNER_USER_ID, decided_via: "web" }), expect.anything());
  });

  it("rejects a signed-in user who is not the owner", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "someone-else" } } });
    const res = await GET(request("GET"));
    expect(res.status).toBe(401);
  });
});
