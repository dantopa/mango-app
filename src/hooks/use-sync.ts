"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type {
  SyncParams,
  SyncProgress,
  SyncSource,
  SyncSourceResult,
  SyncErrorResponse,
} from "@/lib/sync/types";
import { queryKeys } from "@/hooks/use-finance";

const SOURCE_ENDPOINTS: Record<SyncSource, string> = {
  sync_bancolombia: "/api/sync/bancolombia",
  sync_nexo: "/api/sync/nexo",
};

/**
 * Hook que orquesta la ejecución secuencial del sync.
 * Expone: { startSync, progress, reset }
 *
 * Internamente:
 * - Itera sources en orden
 * - Hace POST a /api/sync/{source}
 * - Acumula resultados en progress
 * - Invalida query de transactions al terminar
 */
export function useSync() {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<SyncProgress>({
    current_source: null,
    completed: [],
    errors: [],
    status: "idle",
  });

  const startSync = useCallback(
    async (params: SyncParams) => {
      setProgress({
        current_source: null,
        completed: [],
        errors: [],
        status: "running",
      });

      const completed: SyncSourceResult[] = [];
      const errors: Array<{ source: SyncSource; error: string }> = [];

      for (const source of params.sources) {
        setProgress((prev) => ({ ...prev, current_source: source }));

        try {
          const response = await fetch(SOURCE_ENDPOINTS[source], {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ month: params.month }),
          });

          if (!response.ok) {
            const errBody: SyncErrorResponse = await response.json().catch(
              () => ({ error: `HTTP ${response.status}`, code: "MCP_ERROR" as const })
            );
            errors.push({ source, error: errBody.error });
            setProgress((prev) => ({
              ...prev,
              errors: [...prev.errors, { source, error: errBody.error }],
            }));
            continue;
          }

          const data: { result: SyncSourceResult } = await response.json();
          completed.push(data.result);
          setProgress((prev) => ({
            ...prev,
            completed: [...prev.completed, data.result],
          }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Error de red";
          errors.push({ source, error: msg });
          setProgress((prev) => ({
            ...prev,
            errors: [...prev.errors, { source, error: msg }],
          }));
        }
      }

      // Invalidate transactions query to refresh the table
      if (completed.some((r) => r.inserted > 0)) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.transactions });
      }

      setProgress({
        current_source: null,
        completed,
        errors,
        status: "done",
      });
    },
    [queryClient]
  );

  const reset = useCallback(() => {
    setProgress({
      current_source: null,
      completed: [],
      errors: [],
      status: "idle",
    });
  }, []);

  return { startSync, progress, reset };
}
