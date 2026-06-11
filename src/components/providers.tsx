"use client";

import * as React from "react";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { createIDBSyncStorage } from "@/lib/query-persist";
import { useRevalidateOnReconnect } from "@/hooks/use-revalidate-on-reconnect";

const PERSIST_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

// Only create persister on the client side
const persister =
  typeof window !== "undefined"
    ? createSyncStoragePersister({
        storage: createIDBSyncStorage(),
      })
    : createSyncStoragePersister({
        storage: {
          getItem: () => null,
          setItem: () => undefined,
          removeItem: () => undefined,
        },
      });

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            gcTime: Infinity,
            refetchOnWindowFocus: false,
            retry: 1,
            retryDelay: 2000,
          },
        },
      }),
  );

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: PERSIST_MAX_AGE,
        buster: process.env.NEXT_PUBLIC_BUILD_ID ?? "",
      }}
    >
      <RevalidateOnReconnect />
      {children}
    </PersistQueryClientProvider>
  );
}

/** Activates auto-revalidation of stale queries when the browser comes back online. */
function RevalidateOnReconnect() {
  useRevalidateOnReconnect();
  return null;
}
