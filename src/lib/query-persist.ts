/**
 * IndexedDB-backed storage adapter for TanStack Query persistence.
 *
 * Implements the Storage-like interface expected by
 * @tanstack/query-sync-storage-persister, backed by the
 * `maquinita-query-cache` IndexedDB database.
 *
 * Gracefully degrades to noop when IndexedDB is unavailable
 * (e.g. private browsing mode, denied permissions).
 */

const DB_NAME = "maquinita-query-cache";
const STORE_NAME = "queries";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }

    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.warn("[query-persist] IndexedDB open failed:", request.error);
        resolve(null);
      };
    } catch {
      console.warn("[query-persist] IndexedDB unavailable");
      resolve(null);
    }
  });
}

export interface IDBStorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function createIDBStorageAdapter(): IDBStorageAdapter {
  return {
    async getItem(key: string): Promise<string | null> {
      const db = await openDB();
      if (!db) return null;

      return new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE_NAME, "readonly");
          const store = tx.objectStore(STORE_NAME);
          const request = store.get(key);

          request.onsuccess = () => resolve(request.result ?? null);
          request.onerror = () => {
            console.warn("[query-persist] getItem failed:", request.error);
            resolve(null);
          };
        } catch {
          resolve(null);
        }
      });
    },

    async setItem(key: string, value: string): Promise<void> {
      const db = await openDB();
      if (!db) return;

      return new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE_NAME, "readwrite");
          const store = tx.objectStore(STORE_NAME);
          const request = store.put(value, key);

          request.onsuccess = () => resolve();
          request.onerror = () => {
            console.warn("[query-persist] setItem failed:", request.error);
            resolve();
          };
        } catch {
          resolve();
        }
      });
    },

    async removeItem(key: string): Promise<void> {
      const db = await openDB();
      if (!db) return;

      return new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE_NAME, "readwrite");
          const store = tx.objectStore(STORE_NAME);
          const request = store.delete(key);

          request.onsuccess = () => resolve();
          request.onerror = () => {
            console.warn("[query-persist] removeItem failed:", request.error);
            resolve();
          };
        } catch {
          resolve();
        }
      });
    },
  };
}

/**
 * Create a sync-compatible storage persister that wraps the async
 * IndexedDB adapter. The @tanstack/query-sync-storage-persister
 * expects a synchronous Storage-like interface, so we provide a
 * wrapper that works with its internal throttling.
 */
export function createIDBSyncStorage(): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
} {
  const adapter = createIDBStorageAdapter();

  // In-memory cache to serve sync reads while IDB resolves
  const cache = new Map<string, string>();

  // Hydrate cache from IDB on first access
  let hydrated = false;
  const hydratePromise =
    typeof window !== "undefined"
      ? adapter.getItem("tanstack-query-persist").then((value) => {
          if (value !== null) {
            cache.set("tanstack-query-persist", value);
          }
          hydrated = true;
        })
      : Promise.resolve();

  // Expose the hydration promise for external await
  (globalThis as Record<string, unknown>).__queryPersistHydration =
    hydratePromise;

  return {
    getItem(key: string): string | null {
      return cache.get(key) ?? null;
    },

    setItem(key: string, value: string): void {
      cache.set(key, value);
      adapter.setItem(key, value).catch(() => {
        // Silently fail — in-memory cache still holds the value
      });
    },

    removeItem(key: string): void {
      cache.delete(key);
      adapter.removeItem(key).catch(() => {
        // Silently fail
      });
    },
  };
}
