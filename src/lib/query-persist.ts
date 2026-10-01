import type { PersistedClient, Persister } from "@tanstack/react-query-persist-client";

/**
 * IndexedDB-backed storage adapter for TanStack Query persistence.
 *
 * Backs the TanStack Query persister (`createIDBPersister`) with the
 * `maquinita-query-cache` IndexedDB database.
 *
 * Gracefully degrades to noop when IndexedDB is unavailable
 * (e.g. private browsing mode, denied permissions).
 */

const DB_NAME = "maquinita-query-cache";
const STORE_NAME = "queries";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** One connection per page; reopening on every read and write was pure overhead. */
function openDB(): Promise<IDBDatabase | null> {
  dbPromise ??= openDBOnce().then((db) => {
    if (!db) dbPromise = null; // let a later call retry
    return db;
  });
  return dbPromise;
}

function openDBOnce(): Promise<IDBDatabase | null> {
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

/** Key the persisted cache lives under. */
export const PERSIST_KEY = "tanstack-query-persist";

/** How often a burst of cache changes is written at most. */
const PERSIST_THROTTLE_MS = 1000;

/**
 * TanStack Query persister backed by IndexedDB.
 *
 * Async on purpose. The previous sync wrapper served reads from an in-memory
 * map filled by an IndexedDB read in flight, so at startup the restore always
 * found it empty; and it pre-loaded "tanstack-query-persist" while the sync
 * persister reads "REACT_QUERY_OFFLINE_CACHE", so nothing persisted was ever
 * restored. An async persister lets the provider wait for the real read.
 */
export function createIDBPersister(
  adapter: IDBStorageAdapter = createIDBStorageAdapter(),
  key: string = PERSIST_KEY,
): Persister {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: PersistedClient | null = null;

  const flush = () => {
    timer = null;
    const client = pending;
    pending = null;
    if (!client) return;
    adapter.setItem(key, JSON.stringify(client)).catch(() => {
      // Persisting is best effort: the next change tries again.
    });
  };

  return {
    persistClient(client) {
      // Every query update triggers a persist; writing ~1 MB per update would
      // block the main thread, so only the latest state of a burst is written.
      pending = client;
      timer ??= setTimeout(flush, PERSIST_THROTTLE_MS);
    },
    async restoreClient() {
      const raw = await adapter.getItem(key);
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw) as PersistedClient;
      } catch {
        return undefined;
      }
    },
    async removeClient() {
      pending = null;
      await adapter.removeItem(key);
    },
  };
}
