import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { gmailDedupKey, filterAlreadyProcessed, logProcessedEmail } from "../orchestrator";

// Mock the supabase admin client
vi.mock("../../../push-ingest/supabase-admin", () => ({
  getSupabaseAdmin: vi.fn(),
}));

import { getSupabaseAdmin } from "../../../push-ingest/supabase-admin";

function createMockSupabase() {
  const mockChain = {
    from: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue({ data: [], error: null }),
    upsert: vi.fn().mockResolvedValue({ error: null }),
  };
  return mockChain;
}

describe("gmailDedupKey", () => {
  it("produces a deterministic 32-char hex string", () => {
    const key = gmailDedupKey("abc123");
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(gmailDedupKey("abc123")).toBe(key);
  });

  it("produces different keys for different inputs", () => {
    const k1 = gmailDedupKey("msg-1");
    const k2 = gmailDedupKey("msg-2");
    expect(k1).not.toBe(k2);
  });

  it("uses sha256 of 'gmail|' + messageId", () => {
    // Manually compute expected
    const expected = createHash("sha256")
      .update("gmail|test-id")
      .digest("hex")
      .slice(0, 32);
    expect(gmailDedupKey("test-id")).toBe(expected);
  });
});

describe("filterAlreadyProcessed", () => {
  let mockSupabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as any);
  });

  it("returns all IDs when none exist in the DB", async () => {
    mockSupabase.in.mockResolvedValue({ data: [], error: null });

    const result = await filterAlreadyProcessed(["a", "b", "c"]);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("filters out IDs that already exist in the DB", async () => {
    const keyForB = gmailDedupKey("b");
    mockSupabase.in.mockResolvedValue({
      data: [{ dedup_key: keyForB }],
      error: null,
    });

    const result = await filterAlreadyProcessed(["a", "b", "c"]);
    expect(result).toEqual(["a", "c"]);
  });

  it("returns empty array for empty input", async () => {
    const result = await filterAlreadyProcessed([]);
    expect(result).toEqual([]);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it("chunks queries for large arrays (>200 items)", async () => {
    // Create 250 IDs
    const ids = Array.from({ length: 250 }, (_, i) => `msg-${i}`);
    mockSupabase.in.mockResolvedValue({ data: [], error: null });

    await filterAlreadyProcessed(ids);

    // Should have called .in twice (200 + 50)
    expect(mockSupabase.in).toHaveBeenCalledTimes(2);
    const firstChunk = mockSupabase.in.mock.calls[0][1];
    const secondChunk = mockSupabase.in.mock.calls[1][1];
    expect(firstChunk).toHaveLength(200);
    expect(secondChunk).toHaveLength(50);
  });

  it("fails open on query error (returns all IDs)", async () => {
    mockSupabase.in.mockResolvedValue({
      data: null,
      error: { message: "connection failed" },
    });

    const result = await filterAlreadyProcessed(["a", "b"]);
    expect(result).toEqual(["a", "b"]);
  });
});

describe("logProcessedEmail", () => {
  let mockSupabase: ReturnType<typeof createMockSupabase>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getSupabaseAdmin).mockReturnValue(mockSupabase as any);
  });

  it("inserts a row with correct dedup_key and package_name", async () => {
    await logProcessedEmail({
      messageId: "msg-123",
      sourceId: "bancolombia",
      status: "registered",
    });

    expect(mockSupabase.from).toHaveBeenCalledWith("push_ingest_log");
    expect(mockSupabase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        dedup_key: gmailDedupKey("msg-123"),
        package_name: "gmail.bancolombia",
        status: "registered",
        user_id: expect.any(String),
      }),
      { onConflict: "dedup_key", ignoreDuplicates: true }
    );
  });

  it("includes amount_native when provided", async () => {
    await logProcessedEmail({
      messageId: "msg-456",
      sourceId: "rappicard",
      status: "registered",
      amountNative: 88443,
    });

    expect(mockSupabase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        amount_native: 88443,
      }),
      expect.any(Object)
    );
  });

  it("includes error_message when provided", async () => {
    await logProcessedEmail({
      messageId: "msg-789",
      sourceId: "bancolombia",
      status: "no_parser",
      errorMessage: "Could not extract amount",
    });

    expect(mockSupabase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "no_parser",
        error_message: "Could not extract amount",
      }),
      expect.any(Object)
    );
  });

  it("does not throw on upsert error (logs silently)", async () => {
    mockSupabase.upsert.mockResolvedValue({
      error: { message: "some DB error" },
    });

    // Should not throw
    await expect(
      logProcessedEmail({
        messageId: "msg-fail",
        sourceId: "arriendo",
        status: "registered",
      })
    ).resolves.toBeUndefined();
  });

  it("handles transfer status", async () => {
    await logProcessedEmail({
      messageId: "income-msg",
      sourceId: "bancolombia",
      status: "transfer",
      errorMessage: "Ingreso: recibiste una transferencia",
    });

    expect(mockSupabase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "transfer",
        error_message: "Ingreso: recibiste una transferencia",
      }),
      expect.any(Object)
    );
  });
});
