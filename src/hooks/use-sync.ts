"use client";

import React, { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type {
  ClientSyncSource,
  SyncProgress,
  SyncSource,
  SyncSourceResult,
  SyncErrorResponse,
} from "@/lib/sync/types";
import type { GmailSyncCursor, GmailSyncResponse } from "@/lib/sync/gmail/types";
import { queryKeys } from "@/hooks/use-finance";

const SOURCE_ENDPOINTS: Record<SyncSource | "sync_notifications", string> = {
  sync_bancolombia: "/api/sync/bancolombia",
  sync_nexo: "/api/sync/nexo",
  sync_bbva: "/api/sync/bbva",
  sync_gmail_bancolombia: "/api/sync/gmail",
  sync_gmail_rappicard: "/api/sync/gmail",
  sync_gmail_arriendo: "/api/sync/gmail",
  sync_notifications: "/api/sync/notifications",
};

const GMAIL_ENDPOINT = "/api/sync/gmail";

/**
 * Hook que orquesta la ejecución secuencial del sync.
 * Expone: { startSync, progress, reset }
 *
 * Internamente:
 * - Itera sources en orden
 * - Para fuentes legacy: hace un solo POST a /api/sync/{source}
 * - Para "sync_gmail": POST en loop con cursor hasta next === null
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
    async (params: { month: string; sources: ClientSyncSource[] }) => {
      setProgress({
        current_source: null,
        completed: [],
        errors: [],
        status: "running",
      });

      const completed: SyncSourceResult[] = [];
      const errors: Array<{ source: ClientSyncSource; error: string }> = [];

      for (const source of params.sources) {
        setProgress((prev) => ({ ...prev, current_source: source }));

        if (source === "sync_gmail") {
          // Gmail: cursor-based loop
          await syncGmail(params.month, completed, errors, setProgress);
        } else if (source === "sync_notifications") {
          // Notifications: single POST like legacy
          await syncLegacySource("sync_notifications" as SyncSource, params.month, completed, errors, setProgress);
        } else {
          // Legacy sources: single POST
          await syncLegacySource(source, params.month, completed, errors, setProgress);
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

/** Sync a single legacy source with one POST request */
async function syncLegacySource(
  source: SyncSource,
  month: string,
  completed: SyncSourceResult[],
  errors: Array<{ source: ClientSyncSource; error: string }>,
  setProgress: React.Dispatch<React.SetStateAction<SyncProgress>>
) {
  try {
    const response = await fetch(SOURCE_ENDPOINTS[source], {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month }),
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
      return;
    }

    const data: { result?: SyncSourceResult; results?: SyncSourceResult[] } = await response.json();

    // BBVA returns multiple results (one per card); others return a single result
    const sourceResults = data.results ?? (data.result ? [data.result] : []);
    for (const r of sourceResults) {
      completed.push(r);
    }
    setProgress((prev) => ({
      ...prev,
      completed: [...prev.completed, ...sourceResults],
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

/**
 * Sync Gmail with cursor-based pagination.
 * POSTs in a loop while the server returns `next !== null`, accumulating
 * partial sub-source results (one SyncSourceResult per gmail sub-source).
 */
async function syncGmail(
  month: string,
  completed: SyncSourceResult[],
  errors: Array<{ source: ClientSyncSource; error: string }>,
  setProgress: React.Dispatch<React.SetStateAction<SyncProgress>>
) {
  let cursor: GmailSyncCursor | undefined;

  try {
    while (true) {
      const body: { month: string; cursor?: GmailSyncCursor } = { month };
      if (cursor) body.cursor = cursor;

      const response = await fetch(GMAIL_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errBody: SyncErrorResponse = await response.json().catch(
          () => ({ error: `HTTP ${response.status}`, code: "GMAIL_API_ERROR" as const })
        );
        errors.push({ source: "sync_gmail", error: errBody.error });
        setProgress((prev) => ({
          ...prev,
          errors: [...prev.errors, { source: "sync_gmail", error: errBody.error }],
        }));
        return;
      }

      const data: GmailSyncResponse = await response.json();

      // Merge partial results into completed: accumulate per sub-source
      for (const result of data.results) {
        const existing = completed.find((r) => r.source === result.source);
        if (existing) {
          existing.found += result.found;
          existing.inserted += result.inserted;
          existing.duplicates += result.duplicates;
          existing.needs_review += result.needs_review;
          existing.errors.push(...result.errors);
        } else {
          completed.push({ ...result });
        }
      }

      // Update progress with merged state
      setProgress((prev) => ({
        ...prev,
        completed: [...completed],
      }));

      // If no more pages, we're done
      if (!data.next) break;
      cursor = data.next;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error de red";
    errors.push({ source: "sync_gmail", error: msg });
    setProgress((prev) => ({
      ...prev,
      errors: [...prev.errors, { source: "sync_gmail", error: msg }],
    }));
  }
}
