# Implementation Plan: Expense Sync

## Overview

Motor de reconciliación multi-fuente que permite sincronizar transacciones de un mes seleccionado desde Bancolombia y Nexo Card via `browser-token-mcp`, deduplicando contra transacciones existentes e insertando las nuevas. Reutiliza módulos existentes (fx.ts, categorizer, classifier, supabase-admin) y vive dentro de la app Next.js (Vercel).

## Tasks

- [ ] 1. Set up shared types and core utilities
  - [x] 1.1 Create shared types (`src/lib/sync/types.ts`)
    - Define `CandidateTransaction`, `SyncSource`, `DedupDecision`, `SyncSourceResult`, `SyncRequest`, `SyncResponse`, `SyncErrorResponse`, `SyncParams`, `SyncProgress` interfaces
    - Define error code union type and `ERROR_MESSAGES` map (in Spanish)
    - _Requirements: 2.1, 9.1, 9.2, 12.2_

  - [ ] 1.2 Implement fuzzy merchant matcher (`src/lib/sync/fuzzy-matcher.ts`)
    - Implement `normalizeMerchant(raw)`: uppercase → remove corporate suffixes (SA, SAS, S.A., S.A.S., LTDA, COL, S.L.) → remove non-alphanumeric except spaces → collapse multiple spaces → trim
    - Implement `compareMerchants(a, b)`: normalize both → exact match → prefix check → Levenshtein distance ≤ 3 → "ambiguous" | "no_match"
    - Pure function, no I/O
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ]* 1.3 Write property tests for fuzzy matcher (`src/lib/sync/__tests__/fuzzy-matcher.property.test.ts`)
    - **Property 3: Merchant Normalization Idempotence** — `normalizeMerchant(normalizeMerchant(s)) === normalizeMerchant(s)` for any string
    - **Property 4: Merchant Comparison Correctness** — identical normalized → "match", prefix → "match", >3 chars diff without prefix → "no_match"
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**

  - [ ]* 1.4 Write unit tests for fuzzy matcher (`src/lib/sync/__tests__/fuzzy-matcher.test.ts`)
    - Test concrete cases: "PERGAMINO VIVA ENVIGAD" vs "PERGAMINO VIVA ENVIGADO SA" → match
    - Test suffix removal: "RAPPI SAS" → "RAPPI"
    - Test prefix matching: "EXITO" vs "EXITO ENVIGADO" → match
    - Test no_match: "RAPPI" vs "UBER EATS" → no_match
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [ ] 2. Implement source adapters
  - [ ] 2.1 Implement Bancolombia adapter (`src/lib/sync/adapters/bancolombia.ts`)
    - Define `BancolombiaRawTx` interface
    - Implement `adaptBancolombia(rawTxs)`: filter only type "CREDITO" (which is API's inverted convention for outflows), transform to `CandidateTransaction[]` with `source: "sync_bancolombia"`, `native_currency: "COP"`, `account_name: "Bancolombia"`
    - Ensure `amount_native > 0` for all output items
    - _Requirements: 3.2, 3.3, 3.5_

  - [ ] 2.2 Implement Nexo adapter (`src/lib/sync/adapters/nexo.ts`)
    - Define `NexoRawTx` interface
    - Implement `adaptNexo(rawTxs)`: transform to `CandidateTransaction[]` with `source: "sync_nexo"`, `native_currency: "USD"`, `fx_rate_to_usd: 1`, `amount_usd = amount_native`, `account_name: "Nexo Card"`
    - _Requirements: 4.2, 4.4_

  - [ ]* 2.3 Write property tests for adapters (`src/lib/sync/__tests__/adapters.property.test.ts`)
    - **Property 1: Bancolombia Adapter Transformation** — only outflows included, source always "sync_bancolombia", currency always "COP", account always "Bancolombia", amount > 0
    - **Property 2: Nexo Adapter Transformation** — source always "sync_nexo", currency always "USD", fx_rate always 1, amount_usd equals amount_native, account always "Nexo Card"
    - **Validates: Requirements 3.2, 3.3, 3.5, 4.2, 4.4**

  - [ ]* 2.4 Write unit tests for adapters (`src/lib/sync/__tests__/adapters.test.ts`)
    - Test Bancolombia: fixture with mixed CREDITO/DEBITO → only CREDITO items pass through
    - Test Nexo: fixture with various transactions → correct USD assignment
    - Test edge cases: empty arrays, null merchants
    - _Requirements: 3.2, 3.3, 4.2, 4.4_

- [ ] 3. Checkpoint — Ensure types, fuzzy matcher, and adapters compile and pass tests
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Implement dedup engine
  - [ ] 4.1 Implement dedup sync logic (`src/lib/sync/dedup-sync.ts`)
    - Implement `evaluateCandidate(candidate, userId, monthStart, monthEnd)`: query transactions table for same amount_native + tx_date + account → apply fuzzy matcher → check push_ingest_log
    - Decision tree: exact match (incl. merchant fuzzy) → "discard"; amount+date match but merchant differs → "insert_review"; >1 ambiguous match → "insert_review"; no match → "insert"
    - Under-count principle: never "insert" when any ambiguous match exists
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 13.1, 13.2, 13.3, 13.4, 13.5_

  - [ ]* 4.2 Write property test for dedup engine (`src/lib/sync/__tests__/dedup-sync.property.test.ts`)
    - **Property 5: Dedup Decision Tree — Under-count Safety** — same amount+date+account with merchant match → "discard"; same amount+date but merchant differs → "insert_review"; >1 ambiguous → never "insert"; no match → "insert"
    - Mock Supabase queries with generated data
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.7, 13.1, 13.2, 13.3, 13.4, 13.5**

  - [ ]* 4.3 Write unit tests for dedup engine (`src/lib/sync/__tests__/dedup-sync.test.ts`)
    - Test scenario: 2 transactions same amount/date, only 1 merchant matches → discard only that one
    - Test scenario: push_ingest_log has matching entry → discard
    - Test scenario: no matches → insert
    - Test scenario: ambiguous merchant → insert_review
    - _Requirements: 5.2, 5.3, 5.4, 5.6, 13.1_

- [ ] 5. Implement sync engine
  - [ ] 5.1 Implement sync engine orchestrator (`src/lib/sync/sync-engine.ts`)
    - Implement `processCandidates(candidates, userId, month)`: iterate candidates → dedup → FX (reuse `resolveRate` from fx.ts) → classify (reuse classifier.ts) → categorize (reuse categorizer.ts) → insert into transactions table
    - Each candidate processed independently (failure isolation)
    - Resolve `account_id` from `accounts` table via `account_name`
    - USD candidates skip FX call (rate = 1)
    - Calculate `amount_usd = round(amount_native * fx_rate_to_usd, 4)`
    - Set `needs_review = true` when no category rule matches
    - Return `SyncSourceResult` with counts
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 10.1, 10.2, 10.3, 10.4, 12.1, 12.4_

  - [ ]* 5.2 Write property tests for sync engine (`src/lib/sync/__tests__/sync-engine.property.test.ts`)
    - **Property 6: FX Assignment Correctness** — USD → rate=1, amount_usd=amount_native; non-USD → amount_usd = round(amount_native * rate, 4), rate > 0
    - **Property 7: Candidate Failure Isolation** — K failures in N candidates → N-K still processed successfully
    - Mock dedup, FX, categorizer, classifier
    - **Validates: Requirements 7.2, 7.3, 7.4, 12.1, 12.2, 12.4**

  - [ ]* 5.3 Write unit tests for sync engine (`src/lib/sync/__tests__/sync-engine.test.ts`)
    - Test happy path: new candidate → inserted with correct fields
    - Test FX failure: candidate skipped, error reported
    - Test partial batch: some succeed, some fail → correct counts
    - _Requirements: 7.5, 8.1, 12.1, 12.4_

- [ ] 6. Checkpoint — Ensure sync engine and dedup pass all tests
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Implement Route Handlers
  - [ ] 7.1 Implement MCP client utility (`src/lib/sync/mcp-client.ts`)
    - Implement `callMcpTool(toolName, params)`: POST JSON-RPC to `browser-token-mcp` Edge Function
    - Auth via `Bearer BROWSER_MCP_SECRET` env var
    - Parse response: extract `rpc.result.content[0].text` as JSON
    - Handle errors: auth expired (401/403) → `AUTH_EXPIRED`, timeout → `TIMEOUT`, other → `MCP_ERROR`
    - _Requirements: 3.1, 3.4, 4.1, 4.3_

  - [ ] 7.2 Implement Bancolombia Route Handler (`src/app/api/sync/bancolombia/route.ts`)
    - POST handler: verify Supabase session → call MCP `bancolombia_get_transactions` with month range → adapt response → process via sync-engine → return `SyncResponse` or `SyncErrorResponse`
    - _Requirements: 2.1, 2.5, 3.1, 3.2, 3.4_

  - [ ] 7.3 Implement Nexo Route Handler (`src/app/api/sync/nexo/route.ts`)
    - POST handler: verify Supabase session → call MCP `nexo_get_card_transactions` with month range → adapt response → process via sync-engine → return `SyncResponse` or `SyncErrorResponse`
    - _Requirements: 2.1, 2.5, 4.1, 4.3_

  - [ ] 7.4 Implement Cron Route Handler (`src/app/api/sync/cron/route.ts`)
    - GET handler: verify `Authorization: Bearer SYNC_CRON_SECRET` → run sync for all sources for current month → return JSON summary
    - HTTP 401 if token mismatch, HTTP 200 on success
    - Compatible with Vercel Cron Jobs
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

- [ ] 8. Checkpoint — Ensure Route Handlers compile and integrate with sync engine
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Implement UI components
  - [ ] 9.1 Implement use-sync hook (`src/hooks/use-sync.ts`)
    - Export `useSync()`: `{ startSync, progress, reset }`
    - Sequential POST to `/api/sync/{source}` for each selected source
    - Accumulate results in `SyncProgress` state
    - Invalidate TanStack Query `transactions` key on completion
    - _Requirements: 2.2, 2.3, 2.4, 9.5_

  - [ ] 9.2 Implement Sync Dialog component (`src/components/sync-dialog.tsx`)
    - Modal dialog with: month selector (default: current), source checkboxes (default: all checked), "Iniciar sincronización" button
    - Progress indicator per source while running
    - Summary display: found, inserted, duplicates, needs_review per source
    - Final consolidated summary
    - Wire to `useSync` hook
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 9.1, 9.2, 9.3, 9.4_

  - [ ] 9.3 Wire Sync button into `/gastos` page header
    - Add "Sincronizar" button in the page header of `src/app/(app)/gastos/page.tsx`
    - Open `SyncDialog` on click
    - _Requirements: 1.1, 1.2_

- [ ] 10. Final checkpoint — Ensure all tests pass and components render
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate the 7 universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- Reuses existing infrastructure: `src/lib/push-ingest/fx.ts`, `categorizer.ts`, `classifier.ts`, `supabase-admin.ts`
- No new DB tables needed — inserts into existing `transactions` table
- Uses vitest + fast-check (already configured in project)
- MCP calls use JSON-RPC HTTP POST to `browser-token-mcp` Edge Function
- UI text in Spanish, code in English (project convention)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "2.2"] },
    { "id": 2, "tasks": ["1.3", "1.4", "2.3", "2.4"] },
    { "id": 3, "tasks": ["4.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "5.1"] },
    { "id": 5, "tasks": ["5.2", "5.3", "7.1"] },
    { "id": 6, "tasks": ["7.2", "7.3", "7.4"] },
    { "id": 7, "tasks": ["9.1"] },
    { "id": 8, "tasks": ["9.2"] },
    { "id": 9, "tasks": ["9.3"] }
  ]
}
```
