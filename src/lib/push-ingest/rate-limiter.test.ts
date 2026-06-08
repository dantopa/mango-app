import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { checkRateLimit, resetRateLimit, requestLog } from "./rate-limiter";

describe("rate-limiter", () => {
  beforeEach(() => {
    resetRateLimit();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows requests under the limit", () => {
    const result = checkRateLimit("192.168.1.1");
    expect(result).toEqual({ allowed: true });
  });

  it("allows up to the configured limit (default 60)", () => {
    for (let i = 0; i < 60; i++) {
      const result = checkRateLimit("10.0.0.1");
      expect(result.allowed).toBe(true);
    }
    // 61st should be rejected
    const rejected = checkRateLimit("10.0.0.1");
    expect(rejected.allowed).toBe(false);
    if (!rejected.allowed) {
      expect(rejected.retryAfter).toBeGreaterThan(0);
    }
  });

  it("respects PUSH_INGEST_RATE_LIMIT env var", () => {
    vi.stubEnv("PUSH_INGEST_RATE_LIMIT", "3");

    expect(checkRateLimit("10.0.0.2").allowed).toBe(true);
    expect(checkRateLimit("10.0.0.2").allowed).toBe(true);
    expect(checkRateLimit("10.0.0.2").allowed).toBe(true);
    // 4th should be rejected
    const result = checkRateLimit("10.0.0.2");
    expect(result.allowed).toBe(false);
  });

  it("tracks IPs independently", () => {
    vi.stubEnv("PUSH_INGEST_RATE_LIMIT", "2");

    expect(checkRateLimit("ip-a").allowed).toBe(true);
    expect(checkRateLimit("ip-a").allowed).toBe(true);
    expect(checkRateLimit("ip-a").allowed).toBe(false);

    // Different IP should still be allowed
    expect(checkRateLimit("ip-b").allowed).toBe(true);
  });

  it("returns retryAfter > 0 when rate limited", () => {
    vi.stubEnv("PUSH_INGEST_RATE_LIMIT", "1");

    checkRateLimit("10.0.0.3"); // first is allowed
    const result = checkRateLimit("10.0.0.3");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfter).toBeGreaterThanOrEqual(1);
      expect(result.retryAfter).toBeLessThanOrEqual(60);
    }
  });

  it("allows requests again after window expires", () => {
    vi.stubEnv("PUSH_INGEST_RATE_LIMIT", "2");

    // Manually place old timestamps (older than 60s)
    const now = Date.now();
    requestLog.set("10.0.0.4", [now - 70_000, now - 65_000]);

    // These old entries should be pruned, so new requests should be allowed
    const result = checkRateLimit("10.0.0.4");
    expect(result.allowed).toBe(true);
  });

  it("uses default 60 for invalid env var values", () => {
    vi.stubEnv("PUSH_INGEST_RATE_LIMIT", "not-a-number");

    // Should allow up to 60 requests (default)
    for (let i = 0; i < 60; i++) {
      expect(checkRateLimit("10.0.0.5").allowed).toBe(true);
    }
    expect(checkRateLimit("10.0.0.5").allowed).toBe(false);
  });

  it("resetRateLimit clears all state", () => {
    vi.stubEnv("PUSH_INGEST_RATE_LIMIT", "1");
    checkRateLimit("10.0.0.6");
    expect(checkRateLimit("10.0.0.6").allowed).toBe(false);

    resetRateLimit();
    expect(checkRateLimit("10.0.0.6").allowed).toBe(true);
  });
});
