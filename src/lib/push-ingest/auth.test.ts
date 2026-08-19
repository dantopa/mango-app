import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("./devices", () => ({
  authenticateDevice: vi.fn(),
}));

import { validateAuth, validateIngestAuth } from "./auth";
import { authenticateDevice } from "./devices";

describe("validateAuth", () => {
  const REAL_SECRET = "test-secret-abc123";

  beforeEach(() => {
    process.env.PUSH_INGEST_SECRET = REAL_SECRET;
  });

  afterEach(() => {
    delete process.env.PUSH_INGEST_SECRET;
  });

  it("returns ok:true for valid Bearer token", () => {
    const result = validateAuth(`Bearer ${REAL_SECRET}`);
    expect(result).toEqual({ ok: true });
  });

  it("returns 401 when authHeader is null", () => {
    const result = validateAuth(null);
    expect(result).toEqual({
      ok: false,
      status: 401,
      body: { error: "unauthorized" },
    });
  });

  it("returns 401 when authHeader is empty string", () => {
    const result = validateAuth("");
    expect(result).toEqual({
      ok: false,
      status: 401,
      body: { error: "unauthorized" },
    });
  });

  it("returns 401 when authHeader has no Bearer prefix", () => {
    const result = validateAuth(REAL_SECRET);
    expect(result).toEqual({
      ok: false,
      status: 401,
      body: { error: "unauthorized" },
    });
  });

  it("returns 401 when token does not match secret", () => {
    const result = validateAuth("Bearer wrong-token");
    expect(result).toEqual({
      ok: false,
      status: 401,
      body: { error: "unauthorized" },
    });
  });

  it("returns 401 when PUSH_INGEST_SECRET is not configured", () => {
    delete process.env.PUSH_INGEST_SECRET;
    const result = validateAuth(`Bearer ${REAL_SECRET}`);
    expect(result).toEqual({
      ok: false,
      status: 401,
      body: { error: "unauthorized" },
    });
  });

  it("returns 401 for Bearer prefix with empty token when secret is non-empty", () => {
    const result = validateAuth("Bearer ");
    expect(result).toEqual({
      ok: false,
      status: 401,
      body: { error: "unauthorized" },
    });
  });

  it("is case-sensitive for Bearer prefix", () => {
    const result = validateAuth(`bearer ${REAL_SECRET}`);
    expect(result).toEqual({
      ok: false,
      status: 401,
      body: { error: "unauthorized" },
    });
  });
});

describe("validateIngestAuth", () => {
  const REAL_SECRET = "test-secret-abc123";

  beforeEach(() => {
    process.env.PUSH_INGEST_SECRET = REAL_SECRET;
    vi.mocked(authenticateDevice).mockReset();
  });

  afterEach(() => {
    delete process.env.PUSH_INGEST_SECRET;
  });

  it("accepts the shared secret without touching the database", async () => {
    expect(await validateIngestAuth(`Bearer ${REAL_SECRET}`)).toEqual({ ok: true });
    expect(authenticateDevice).not.toHaveBeenCalled();
  });

  it("falls back to a paired device token", async () => {
    vi.mocked(authenticateDevice).mockResolvedValue({ id: "dev-1", userId: "user-1" });

    expect(await validateIngestAuth("Bearer device-token")).toEqual({ ok: true });
    expect(authenticateDevice).toHaveBeenCalledWith("device-token", expect.any(Date));
  });

  it("rejects a token that matches no device", async () => {
    vi.mocked(authenticateDevice).mockResolvedValue(null);

    expect(await validateIngestAuth("Bearer nope")).toEqual({
      ok: false,
      status: 401,
      body: { error: "unauthorized" },
    });
  });

  it("does not look up a device when there is no bearer token", async () => {
    expect(await validateIngestAuth(null)).toEqual({
      ok: false,
      status: 401,
      body: { error: "unauthorized" },
    });
    expect(await validateIngestAuth("Bearer ")).toEqual({
      ok: false,
      status: 401,
      body: { error: "unauthorized" },
    });
    expect(authenticateDevice).not.toHaveBeenCalled();
  });

  /**
   * A missing secret must not turn every request into a device lookup that
   * happens to succeed on an empty token.
   */
  it("still requires a device match when the shared secret is unset", async () => {
    delete process.env.PUSH_INGEST_SECRET;
    vi.mocked(authenticateDevice).mockResolvedValue(null);

    expect(await validateIngestAuth(`Bearer ${REAL_SECRET}`)).toEqual({
      ok: false,
      status: 401,
      body: { error: "unauthorized" },
    });
  });
});
