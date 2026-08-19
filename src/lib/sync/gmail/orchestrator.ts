import { createHash } from "crypto";

import { getSupabaseAdmin } from "../../push-ingest/supabase-admin";
import { processCandidates } from "../sync-engine";
import type { SyncSourceResult } from "../types";
import type { GmailSourceDef, GmailSourceId, GmailSyncCursor, GmailSyncResponse } from "./types";
import { refreshAccessToken, listMessageIds, getMessage } from "./client";
import { GmailAuthError } from "./client";
import { markCloseItem } from "./close-items";
import { learnFromEmail, tryLearnedTemplates } from "./learned-parser";
import { GMAIL_SOURCES } from "./sources";

const OWNER_USER_ID = "e99371b1-6163-4216-b624-c79d8ee01520";

/**
 * Compute idempotency key for a Gmail message.
 * sha256("gmail|" + messageId), truncated to 32 hex chars.
 * Deterministic — same input always produces same output.
 */
export function gmailDedupKey(messageId: string): string {
  return createHash("sha256")
    .update("gmail|" + messageId)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Filter out message IDs that have already been processed (exist in push_ingest_log).
 * Returns only the IDs that are NOT yet in the log (i.e., new/unprocessed).
 * Queries in chunks of 200 to avoid Postgres query size limits.
 */
export async function filterAlreadyProcessed(
  messageIds: string[]
): Promise<string[]> {
  if (messageIds.length === 0) return [];

  const supabase = getSupabaseAdmin();
  const CHUNK_SIZE = 200;

  // Map messageId → dedupKey for lookup
  const idToKey = new Map<string, string>();
  for (const id of messageIds) {
    idToKey.set(id, gmailDedupKey(id));
  }

  // Collect all dedup keys that already exist in the DB
  const existingKeys = new Set<string>();

  const allKeys = Array.from(idToKey.values());
  for (let i = 0; i < allKeys.length; i += CHUNK_SIZE) {
    const chunk = allKeys.slice(i, i + CHUNK_SIZE);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from("push_ingest_log")
      .select("dedup_key")
      .in("dedup_key", chunk);

    if (error) {
      console.error(
        "[gmail-orchestrator] filterAlreadyProcessed query error:",
        error.message
      );
      // Fail open: if we can't check, assume all are new (will be caught by PK on insert)
      continue;
    }

    for (const row of data ?? []) {
      existingKeys.add(row.dedup_key);
    }
  }

  // Return message IDs whose dedup keys are NOT in the DB
  return messageIds.filter((id) => !existingKeys.has(idToKey.get(id)!));
}

/**
 * Log a processed email into push_ingest_log for idempotency tracking.
 * Silently ignores duplicate key conflicts (email was already logged).
 */
export async function logProcessedEmail(params: {
  messageId: string;
  sourceId: GmailSourceId;
  status: "registered" | "duplicate" | "no_parser" | "transfer";
  amountNative?: number;
  errorMessage?: string;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const dedupKey = gmailDedupKey(params.messageId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any)
    .from("push_ingest_log")
    .upsert(
      {
        dedup_key: dedupKey,
        user_id: OWNER_USER_ID,
        package_name: "gmail." + params.sourceId,
        status: params.status,
        ...(params.amountNative !== undefined && {
          amount_native: params.amountNative,
        }),
        ...(params.errorMessage !== undefined && {
          error_message: params.errorMessage,
        }),
      },
      { onConflict: "dedup_key", ignoreDuplicates: true }
    );

  if (error) {
    // Log but don't throw — idempotency layer should not break the sync
    console.error(
      "[gmail-orchestrator] logProcessedEmail error:",
      error.message
    );
  }
}


// ---------------------------------------------------------------------------
// Ingreso detection regex (Bancolombia "recibiste una transferencia/un pago")
// ---------------------------------------------------------------------------

const RE_INGRESO = /recibiste (una transferencia|un pago)/i;

// ---------------------------------------------------------------------------
// runGmailSource
// ---------------------------------------------------------------------------

const MESSAGE_CHUNK_SIZE = 20;

/**
 * AI calls this source may spend teaching itself new formats, per request.
 *
 * Beyond the cap the email is left unlogged and the source reports itself
 * exhausted, so the client resumes it with a fresh budget instead of burning the
 * request deadline. This terminates because every AI call that actually happens
 * settles its email — as a transaction, as a stored `ignore` pattern, or as a
 * `no_parser` row — so no email can be offered to the model twice.
 */
const MAX_LEARN_CALLS_PER_SOURCE = 6;

/**
 * Run a single Gmail sub-source: list → filter processed → fetch & parse → processCandidates.
 *
 * Returns partial results + exhausted flag when time budget runs out.
 * Errors on individual emails don't abort the source (logged and counted).
 */
export async function runGmailSource(
  sourceDef: GmailSourceDef,
  month: string,
  userId: string,
  accessToken: string,
  budgetMs: number
): Promise<{ result: SyncSourceResult; exhausted: boolean }> {
  const startTime = Date.now();
  let learnCalls = 0;

  const result: SyncSourceResult = {
    source: sourceDef.syncSource,
    found: 0,
    inserted: 0,
    duplicates: 0,
    needs_review: 0,
    errors: [],
  };

  // 1. List ALL message IDs (paginated)
  const allMessageIds: string[] = [];
  let pageToken: string | undefined;

  do {
    const page = await listMessageIds(
      accessToken,
      sourceDef.buildQuery(month),
      pageToken
    );
    allMessageIds.push(...page.messageIds);
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);

  result.found = allMessageIds.length;

  if (allMessageIds.length === 0) {
    // Only mark close item if source doesn't require results (0 found is valid)
    if (sourceDef.closeItemSource && !sourceDef.requiresResults) {
      await markCloseItem(sourceDef.closeItemSource, month);
    }
    return { result, exhausted: false };
  }

  // 2. Filter already processed
  const newIds = await filterAlreadyProcessed(allMessageIds);
  result.duplicates = allMessageIds.length - newIds.length;

  if (newIds.length === 0) {
    if (sourceDef.closeItemSource) {
      await markCloseItem(sourceDef.closeItemSource, month);
    }
    return { result, exhausted: false };
  }

  // 3. Process in chunks of MESSAGE_CHUNK_SIZE
  for (let i = 0; i < newIds.length; i += MESSAGE_CHUNK_SIZE) {
    // Budget check before each chunk
    if (Date.now() - startTime > budgetMs) {
      return { result, exhausted: true };
    }

    const chunk = newIds.slice(i, i + MESSAGE_CHUNK_SIZE);

    for (const messageId of chunk) {
      // Budget check per message as well
      if (Date.now() - startTime > budgetMs) {
        return { result, exhausted: true };
      }

      try {
        // 3a. Fetch email
        const email = await getMessage(accessToken, messageId);

        // 3b. Parse
        let candidates = sourceDef.parse(email);

        // 3c. The hand-written parser found nothing. Try the learned patterns,
        //     and only if those miss too, spend an AI call to learn this format.
        if (candidates.length === 0) {
          // Ingresos are settled here: money coming in is never an expense, and
          // that is cheap to decide without a model.
          if (RE_INGRESO.test(email.bodyText)) {
            await logProcessedEmail({
              messageId,
              sourceId: sourceDef.id,
              status: "transfer",
              errorMessage: "Ingreso detectado (transferencia/pago recibido)",
            });
            continue;
          }

          let learned = await tryLearnedTemplates(email, sourceDef, userId);

          if (learned.kind === "unknown") {
            if (learnCalls >= MAX_LEARN_CALLS_PER_SOURCE) {
              // Deliberately not logged: the email has to stay available so the
              // next request can still learn from it.
              return { result, exhausted: true };
            }
            learnCalls++;
            learned = await learnFromEmail(email, sourceDef, userId);
          }

          if (learned.kind === "transaction") {
            candidates = learned.candidates;
          } else {
            await logProcessedEmail({
              messageId,
              sourceId: sourceDef.id,
              status: "no_parser",
              errorMessage:
                learned.kind === "ignore"
                  ? "Descartado: no es un gasto (plantilla aprendida)"
                  : "Parser returned empty",
            });
            continue;
          }
        }

        // 3d. Process candidates through the engine
        const engineResult = await processCandidates(candidates, userId, month);

        // 3e. Log processed email — only if engine actually did something.
        // If engine returned only errors (inserted=0, duplicates=0) it means
        // a systemic failure (e.g. account not found) and we should NOT log,
        // so the email remains available for re-processing on next run.
        const engineDidWork =
          engineResult.inserted > 0 || engineResult.duplicates > 0;

        if (engineDidWork) {
          const logStatus =
            engineResult.inserted === 0 && engineResult.duplicates > 0
              ? "duplicate"
              : "registered";

          await logProcessedEmail({
            messageId,
            sourceId: sourceDef.id,
            status: logStatus,
            amountNative: candidates[0].amount_native,
          });
        } else if (engineResult.errors.length > 0) {
          // Don't log — leave email unprocessed for retry.
          // But DO count the errors in the result.
        }

        // 3f. Merge engine result into running result
        result.inserted += engineResult.inserted;
        result.duplicates += engineResult.duplicates;
        result.needs_review += engineResult.needs_review;
        if (engineResult.errors.length > 0) {
          result.errors.push(...engineResult.errors);
        }
      } catch (err) {
        // GmailAuthError propagates up (caller handles)
        if (err instanceof GmailAuthError) {
          throw err;
        }

        // GmailApiError on a specific message: count as error, continue.
        // Do NOT log to push_ingest_log so the email remains available for retry.
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(
          `[${sourceDef.id}] Error processing message ${messageId}: ${msg}`
        );
      }
    }
  }

  // Mark close item if sub-source completed without errors and has closeItemSource
  if (result.errors.length === 0 && sourceDef.closeItemSource) {
    await markCloseItem(sourceDef.closeItemSource, month);
  }

  return { result, exhausted: false };
}

// ---------------------------------------------------------------------------
// runGmailMonth
// ---------------------------------------------------------------------------

const DEFAULT_BUDGET_MS = 20_000;

/**
 * Top-level Gmail sync for a month.
 *
 * Iterates all (or filtered) Gmail sources in order, respecting time budget.
 * Returns partial results + cursor for resumption if budget is exhausted.
 * GmailAuthError propagates up — caller is responsible for handling it.
 */
export async function runGmailMonth(
  month: string,
  sources?: GmailSourceId[],
  cursor?: GmailSyncCursor | null,
  budgetMs?: number
): Promise<GmailSyncResponse> {
  const budget = budgetMs ?? DEFAULT_BUDGET_MS;
  const startTime = Date.now();

  // Get access token (throws GmailAuthError if not connected)
  const accessToken = await refreshAccessToken();

  const userId = OWNER_USER_ID;

  // Filter sources if specified
  let sourcesToRun = GMAIL_SOURCES;
  if (sources && sources.length > 0) {
    sourcesToRun = GMAIL_SOURCES.filter((s) => sources.includes(s.id));
  }

  // If cursor provided, skip sources before cursor.source
  let startIndex = 0;
  if (cursor) {
    const cursorIdx = sourcesToRun.findIndex((s) => s.id === cursor.source);
    if (cursorIdx >= 0) {
      startIndex = cursorIdx;
    }
  }

  const results: SyncSourceResult[] = [];

  for (let i = startIndex; i < sourcesToRun.length; i++) {
    const sourceDef = sourcesToRun[i];

    // Check remaining budget
    const elapsed = Date.now() - startTime;
    const remainingBudget = budget - elapsed;

    if (remainingBudget <= 0) {
      // Budget exhausted before starting this source — return cursor
      return {
        results,
        next: { source: sourceDef.id },
      };
    }

    try {
      const { result, exhausted } = await runGmailSource(
        sourceDef,
        month,
        userId,
        accessToken,
        remainingBudget
      );

      results.push(result);

      if (exhausted) {
        // Return cursor pointing to the current source for resumption
        return {
          results,
          next: { source: sourceDef.id },
        };
      }
    } catch (err) {
      // GmailAuthError propagates up
      if (err instanceof GmailAuthError) {
        throw err;
      }

      // Other errors: record in results but don't abort the whole run
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        source: sourceDef.syncSource,
        found: 0,
        inserted: 0,
        duplicates: 0,
        needs_review: 0,
        errors: [`[${sourceDef.id}] Sub-source failed: ${msg}`],
      });
    }
  }

  // All sources completed
  return { results, next: null };
}
