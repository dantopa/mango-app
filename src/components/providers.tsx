"use client";

import * as React from "react";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createIDBPersister } from "@/lib/query-persist";
import { useRevalidateOnReconnect } from "@/hooks/use-revalidate-on-reconnect";

const PERSIST_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

// IndexedDB is client-only; on the server the adapter finds no indexedDB and
// every call is a no-op, so the same persister is safe to build anywhere.
const persister = createIDBPersister();

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
