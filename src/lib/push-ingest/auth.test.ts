import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateAuth } from "./auth";

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
