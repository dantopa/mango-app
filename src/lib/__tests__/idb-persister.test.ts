import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedClient } from "@tanstack/react-query-persist-client";

import { createIDBPersister, type IDBStorageAdapter } from "../query-persist";

function memoryAdapter() {
  const store = new Map<string, string>();
  const writes: string[] = [];
  const adapter: IDBStorageAdapter = {
    getItem: async (key) => store.get(key) ?? null,
    setItem: async (key, value) => {
      writes.push(key);
      store.set(key, value);
    },
    removeItem: async (key) => {
      store.delete(key);
    },
  };
  return { adapter, store, writes };
}

function client(buster: string): PersistedClient {
  return { timestamp: 1, buster, clientState: { mutations: [], queries: [] } };
}

describe("createIDBPersister", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("restores what it persisted under the same key", async () => {
    const { adapter } = memoryAdapter();
    const persister = createIDBPersister(adapter);

    await persister.persistClient(client("b1"));
    await vi.advanceTimersByTimeAsync(1000);

    // Regression: the sync wrapper wrote one key and pre-read another, so a
    // reload never got its cache back.
    expect(await createIDBPersister(adapter).restoreClient()).toEqual(client("b1"));
  });

  it("writes a burst of updates once, with the latest state", async () => {
    const { adapter, writes } = memoryAdapter();
    const persister = createIDBPersister(adapter);

    await persister.persistClient(client("a"));
    await persister.persistClient(client("b"));
    await persister.persistClient(client("c"));
    expect(writes).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toHaveLength(1);
    expect((await persister.restoreClient())?.buster).toBe("c");
  });

  it("restores nothing when the stored value is not valid JSON", async () => {
    const { adapter, store } = memoryAdapter();
    store.set("tanstack-query-persist", "{not json");
    expect(await createIDBPersister(adapter).restoreClient()).toBeUndefined();
  });

  it("drops a pending write when the client is removed", async () => {
    const { adapter, writes } = memoryAdapter();
    const persister = createIDBPersister(adapter);

    await persister.persistClient(client("x"));
    await persister.removeClient();
    await vi.advanceTimersByTimeAsync(1000);

    expect(writes).toHaveLength(0);
    expect(await persister.restoreClient()).toBeUndefined();
  });
});
