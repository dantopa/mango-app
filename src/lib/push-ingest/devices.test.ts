import { describe, it, expect, beforeEach, vi } from "vitest";

// --- Supabase fake -------------------------------------------------------------
// Every builder method returns the same object and records itself, so a test can
// assert which filters a query applied — that is where the security properties of
// this module actually live.

type Call = { method: string; args: unknown[] };

let calls: Call[] = [];
let result: { data: unknown; error: unknown } = { data: null, error: null };

function makeQuery() {
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return query;
  };
  const resolve = () => Promise.resolve(result);
  const query = {
    select: record("select"),
    upsert: record("upsert"),
    update: record("update"),
    delete: record("delete"),
    insert: record("insert"),
    eq: record("eq"),
    is: record("is"),
    not: record("not"),
    lt: record("lt"),
    gt: record("gt"),
    order: record("order"),
    single: resolve,
    maybeSingle: resolve,
    then: (fn: (value: typeof result) => void) => fn(result),
  };
  return query;
}

const mockSupabase = { from: (table: string) => { calls.push({ method: "from", args: [table] }); return makeQuery(); } };

vi.mock("./supabase-admin", () => ({
  getSupabaseAdmin: () => mockSupabase,
}));

import {
  authenticateDevice,
  enrollDevice,
  enrollSchema,
  isLastUsedStale,
  pairDevice,
  pairSchema,
  sha256Hex,
  PAIRING_TTL_MS,
} from "./devices";

const NOW = new Date("2026-08-19T03:00:00.000Z");
const HEX = "a".repeat(64);

function argsOf(method: string): unknown[][] {
  return calls.filter((c) => c.method === method).map((c) => c.args);
}

beforeEach(() => {
  calls = [];
  result = { data: null, error: null };
});

describe("sha256Hex", () => {
  it("produces the well-known digest", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("enrollSchema", () => {
  it("accepts 32 bytes of lowercase hex", () => {
    const parsed = enrollSchema.safeParse({
      token_hash: HEX,
      pairing_code_hash: "b".repeat(64),
      label: "Google Pixel 10 Pro",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a short or uppercase digest", () => {
    expect(enrollSchema.safeParse({ token_hash: "abc", pairing_code_hash: HEX, label: "x" }).success)
      .toBe(false);
    expect(enrollSchema.safeParse({ token_hash: "A".repeat(64), pairing_code_hash: HEX, label: "x" }).success)
      .toBe(false);
  });

  it("rejects an empty label", () => {
    expect(enrollSchema.safeParse({ token_hash: HEX, pairing_code_hash: HEX, label: "   " }).success)
      .toBe(false);
  });
});

describe("pairSchema", () => {
  it("rejects anything that is not a 32-byte hex code", () => {
    expect(pairSchema.safeParse({ code: "123456" }).success).toBe(false);
    expect(pairSchema.safeParse({ code: HEX }).success).toBe(true);
  });
});

describe("enrollDevice", () => {
  const input = { token_hash: HEX, pairing_code_hash: "b".repeat(64), label: "Pixel" };

  it("stores the digests unowned, with a bounded pairing window", async () => {
    result = { data: { id: "dev-1", pairing_expires_at: "later" }, error: null };

    const device = await enrollDevice(input, NOW);

    expect(device).toEqual({ id: "dev-1", pairing_expires_at: "later" });
    const [row, options] = argsOf("upsert")[0] as [Record<string, unknown>, unknown];
    expect(row.user_id).toBeNull();
    expect(row.paired_at).toBeNull();
    expect(row.token_hash).toBe(HEX);
    expect(row.pairing_expires_at).toBe(new Date(NOW.getTime() + PAIRING_TTL_MS).toISOString());
    // Keyed on the token so re-pairing a phone updates its row instead of
    // orphaning it.
    expect(options).toEqual({ onConflict: "token_hash" });
  });

  it("drops expired enrolments that were never approved", async () => {
    result = { data: { id: "dev-1", pairing_expires_at: "later" }, error: null };

    await enrollDevice(input, NOW);

    expect(argsOf("delete")).toHaveLength(1);
    expect(argsOf("is")[0]).toEqual(["user_id", null]);
    expect(argsOf("lt")[0]).toEqual(["pairing_expires_at", NOW.toISOString()]);
  });

  it("returns null when the write fails", async () => {
    result = { data: null, error: { message: "boom" } };
    expect(await enrollDevice(input, NOW)).toBeNull();
  });
});

describe("pairDevice", () => {
  it("matches the hash of the code, never the code", async () => {
    result = { data: { id: "dev-1", label: "Pixel" }, error: null };

    const paired = await pairDevice(HEX, "user-1", NOW);

    expect(paired).toEqual({ id: "dev-1", label: "Pixel" });
    expect(argsOf("eq")[0]).toEqual(["pairing_code_hash", sha256Hex(HEX)]);
  });

  it("only approves an unowned, unexpired enrolment", async () => {
    result = { data: { id: "dev-1", label: "Pixel" }, error: null };

    await pairDevice(HEX, "user-1", NOW);

    expect(argsOf("is")[0]).toEqual(["user_id", null]);
    expect(argsOf("gt")[0]).toEqual(["pairing_expires_at", NOW.toISOString()]);
  });

  it("clears the code so it cannot be replayed", async () => {
    result = { data: { id: "dev-1", label: "Pixel" }, error: null };

    await pairDevice(HEX, "user-1", NOW);

    const [patch] = argsOf("update")[0] as [Record<string, unknown>];
    expect(patch.pairing_code_hash).toBeNull();
    expect(patch.user_id).toBe("user-1");
    expect(patch.paired_at).toBe(NOW.toISOString());
  });

  it("returns null for a code that matched nothing", async () => {
    result = { data: null, error: null };
    expect(await pairDevice(HEX, "user-1", NOW)).toBeNull();
  });
});

describe("authenticateDevice", () => {
  it("resolves a token to its owner via the hash", async () => {
    result = { data: { id: "dev-1", user_id: "user-1", last_used_at: NOW.toISOString() }, error: null };

    expect(await authenticateDevice("plaintext-token", NOW)).toEqual({
      id: "dev-1",
      userId: "user-1",
    });
    expect(argsOf("eq")[0]).toEqual(["token_hash", sha256Hex("plaintext-token")]);
  });

  it("requires an owner and no revocation", async () => {
    result = { data: { id: "dev-1", user_id: "user-1", last_used_at: NOW.toISOString() }, error: null };

    await authenticateDevice("t", NOW);

    expect(argsOf("not")[0]).toEqual(["user_id", "is", null]);
    expect(argsOf("is")[0]).toEqual(["revoked_at", null]);
  });

  it("rejects an enrolment that was never paired", async () => {
    result = { data: null, error: null };
    expect(await authenticateDevice("t", NOW)).toBeNull();
  });

  it("touches last_used_at only when it is stale", async () => {
    result = { data: { id: "dev-1", user_id: "user-1", last_used_at: NOW.toISOString() }, error: null };
    await authenticateDevice("t", NOW);
    expect(argsOf("update")).toHaveLength(0);

    calls = [];
    result = { data: { id: "dev-1", user_id: "user-1", last_used_at: null }, error: null };
    await authenticateDevice("t", NOW);
    expect(argsOf("update")).toHaveLength(1);
  });
});

describe("isLastUsedStale", () => {
  it("treats a device that was never used as stale", () => {
    expect(isLastUsedStale(null, NOW)).toBe(true);
  });

  it("throttles within the hour and lets a later touch through", () => {
    expect(isLastUsedStale(new Date(NOW.getTime() - 59 * 60_000).toISOString(), NOW)).toBe(false);
    expect(isLastUsedStale(new Date(NOW.getTime() - 61 * 60_000).toISOString(), NOW)).toBe(true);
  });
});
