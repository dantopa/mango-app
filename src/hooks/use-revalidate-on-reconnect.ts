"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Automatically revalidates stale queries when the browser comes back online.
 * Only invalidates queries whose cached data is older than the configured staleTime
 * (defaults to 60s from the QueryClient default options).
 *
 * This hook listens for the browser `online` event and calls
 * `queryClient.invalidateQueries()` with a predicate that filters by data age.
 */
export function useRevalidateOnReconnect() {
  const queryClient = useQueryClient();

  useEffect(() => {
    function handleOnline() {
      const defaultStaleTime =
        (queryClient.getDefaultOptions().queries?.staleTime as
          | number
          | undefined) ?? 0;

      queryClient.invalidateQueries({
        predicate: (query) => {
          const { dataUpdatedAt } = query.state;
          // Skip queries that have never fetched data
          if (!dataUpdatedAt) return false;

          const age = Date.now() - dataUpdatedAt;
          return age > defaultStaleTime;
        },
      });
    }

    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [queryClient]);
}
