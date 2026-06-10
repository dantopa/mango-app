import { describe, it, expect, vi, beforeEach } from "vitest";
import { markCloseItem } from "../close-items";

// Mock the supabase admin client
vi.mock("../../../push-ingest/supabase-admin", () => ({
  getSupabaseAdmin: vi.fn(),
}));

import { getSupabaseAdmin } from "../../../push-ingest/supabase-admin";

describe("markCloseItem", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fromCalls: Array<{ table: string; chain: Record<string, any> }>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function createChain(overrides: Record<string, any> = {}) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: Record<string, any> = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      update: vi.fn().mockReturnThis(),
      ...overrides,
    };
    // eq at end of update chain returns a promise
    return chain;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function setupMock(chains: Array<{ table: string; chain: Record<string, any> }>) {
    fromCalls = [];
    let callIndex = 0;
    const mockFrom = vi.fn().mockImplementation((table: string) => {
      const entry = chains[callIndex] || chains[chains.length - 1];
      fromCalls.push({ table, chain: entry.chain });
      callIndex++;
      return entry.chain;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: mockFrom } as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when no monthly_close exists for the period", async () => {
    const closeChain = createChain();
    closeChain.maybeSingle.mockResolvedValue({ data: null, error: null });

    setupMock([{ table: "monthly_close", chain: closeChain }]);

    await markCloseItem("Arriendo", "2026-06");

    expect(fromCalls).toHaveLength(1);
    expect(fromCalls[0].table).toBe("monthly_close");
  });

  it("does nothing when close item is not found", async () => {
    const closeChain = createChain();
    closeChain.maybeSingle.mockResolvedValue({ data: { id: "close-uuid-1" }, error: null });

    const itemsChain = createChain();
    itemsChain.maybeSingle.mockResolvedValue({ data: null, error: null });

    setupMock([
      { table: "monthly_close", chain: closeChain },
      { table: "monthly_close_items", chain: itemsChain },
    ]);

    await markCloseItem("Arriendo", "2026-06");

    expect(fromCalls).toHaveLength(2);
    expect(fromCalls[0].table).toBe("monthly_close");
    expect(fromCalls[1].table).toBe("monthly_close_items");
    expect(itemsChain.update).not.toHaveBeenCalled();
  });

  it("updates the close item to cargado when found", async () => {
    const closeChain = createChain();
    closeChain.maybeSingle.mockResolvedValue({ data: { id: "close-uuid-1" }, error: null });

    const itemsChain = createChain();
    itemsChain.maybeSingle.mockResolvedValue({ data: { id: "item-uuid-1" }, error: null });

    const updateChain = createChain();
    updateChain.eq.mockResolvedValue({ error: null });

    setupMock([
      { table: "monthly_close", chain: closeChain },
      { table: "monthly_close_items", chain: itemsChain },
      { table: "monthly_close_items", chain: updateChain },
    ]);

    await markCloseItem("Bancolombia", "2026-06");

    expect(fromCalls).toHaveLength(3);
    expect(fromCalls[2].table).toBe("monthly_close_items");
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "cargado",
        loaded_at: expect.any(String),
      })
    );
  });

  it("uses ilike for case-insensitive source matching", async () => {
    const closeChain = createChain();
    closeChain.maybeSingle.mockResolvedValue({ data: { id: "close-uuid-1" }, error: null });

    const itemsChain = createChain();
    itemsChain.maybeSingle.mockResolvedValue({ data: null, error: null });

    setupMock([
      { table: "monthly_close", chain: closeChain },
      { table: "monthly_close_items", chain: itemsChain },
    ]);

    await markCloseItem("Arriendo", "2026-06");

    expect(itemsChain.ilike).toHaveBeenCalledWith("source", "Arriendo");
  });

  it("filters by item_type gmail_auto", async () => {
    const closeChain = createChain();
    closeChain.maybeSingle.mockResolvedValue({ data: { id: "close-uuid-1" }, error: null });

    const itemsChain = createChain();
    itemsChain.maybeSingle.mockResolvedValue({ data: null, error: null });

    setupMock([
      { table: "monthly_close", chain: closeChain },
      { table: "monthly_close_items", chain: itemsChain },
    ]);

    await markCloseItem("Arriendo", "2026-06");

    const eqCalls = itemsChain.eq.mock.calls;
    const hasItemTypeFilter = eqCalls.some(
      ([key, val]: [string, string]) => key === "item_type" && val === "gmail_auto"
    );
    expect(hasItemTypeFilter).toBe(true);
  });

  it("never throws even on DB errors", async () => {
    const closeChain = createChain();
    closeChain.maybeSingle.mockResolvedValue({
      data: null,
      error: { message: "connection refused" },
    });

    setupMock([{ table: "monthly_close", chain: closeChain }]);

    await expect(markCloseItem("Arriendo", "2026-06")).resolves.toBeUndefined();
  });

  it("never throws on unexpected errors", async () => {
    vi.mocked(getSupabaseAdmin).mockImplementation(() => {
      throw new Error("env var missing");
    });

    await expect(markCloseItem("Arriendo", "2026-06")).resolves.toBeUndefined();
  });
});
