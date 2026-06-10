# Implementation Plan: Realtime Expense Sensor

## Overview

Sistema de ingesta automática de gastos en tiempo real basado en notificaciones push de pagos NFC. Implementación en fases incrementales dentro del Next.js app existente (Vercel), usando Route Handler + módulos en `src/lib/push-ingest/`. Fase 0 (log-only) es mandatory-first para recolectar payloads reales antes de escribir parsers.

## Tasks

- [x] 1. Set up test runner and shared types
  - [x] 1.1 Add vitest + fast-check as devDependencies and configure
    - Run `npm install -D vitest fast-check @testing-library/react`
    - Create `vitest.config.ts` at project root with path aliases matching `tsconfig.json`
    - Add `"test": "vitest --run"` and `"test:watch": "vitest"` to `package.json` scripts
    - _Requirements: Design Testing Strategy_

  - [x] 1.2 Create shared types (`src/lib/push-ingest/types.ts`)
    - Define `PushPayload`, `ParsedTransaction`, `ParserFn`, `SemaphoreState`, `SemaphoreResult`, `PipelineResult`, `IngestMode`, `SemaphoreInput` types exactly as specified in design
    - _Requirements: 2.1, 5.5, 12.2, 17.1_

  - [x] 1.3 Create Supabase admin client (`src/lib/push-ingest/supabase-admin.ts`)
    - Create singleton `supabaseAdmin` using `createClient` with `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
    - Set `auth: { persistSession: false }`
    - Follow same pattern as existing `src/lib/supabase/` clients
    - _Requirements: 3.2, 8.2_

- [x] 2. Create database migration
  - [x] 2.1 Create `supabase/migrations/0006_push_sensor_tables.sql`
    - Create `push_raw_log` table (id uuid PK, user_id FK, package_name text, payload jsonb, received_at timestamptz, created_at timestamptz)
    - Create index `idx_push_raw_log_user_received` on `(user_id, received_at)`
    - Disable RLS on `push_raw_log`
    - Create `push_ingest_log` table (dedup_key text PK, user_id FK, package_name text, amount_native numeric, native_currency text, amount_usd numeric nullable, merchant text nullable, status text, transaction_id uuid FK nullable, raw_log_id uuid FK nullable, related_dedup_key text, error_message text, created_at timestamptz, updated_at timestamptz)
    - Add CHECK constraint on status values: processing, registered, duplicate, deduped_cross_source, no_parser, fx_pending, registration_failed, transfer
    - Create index `idx_push_ingest_amount_created` on `(amount_native, created_at)`
    - Create index `idx_push_ingest_status` on `(status)`
    - Disable RLS on `push_ingest_log`
    - Create `merchant_category_rules` table (id uuid PK, user_id FK, pattern text, match_type text default 'ilike', category_id uuid FK, priority integer default 0, created_at timestamptz)
    - Create index on `(user_id, priority DESC)`
    - Disable RLS on `merchant_category_rules`
    - Create `transfer_classification_rules` table (id uuid PK, user_id FK, pattern text, match_type text default 'ilike', list_type text default 'allowlist', description text, created_at timestamptz)
    - Create index on `(user_id)`
    - Disable RLS on `transfer_classification_rules`
    - ALTER `transactions`: add `needs_review boolean NOT NULL DEFAULT false`, add `source text NOT NULL DEFAULT 'manual'`
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 16.1, 16.2, 16.3, 16.4, 16.5, 9.1, 10.1, 8.1_

- [x] 3. Implement Phase 0 core modules (auth, schemas, rate-limiter)
  - [x] 3.1 Create auth module (`src/lib/push-ingest/auth.ts`)
    - Implement `validateAuth(authHeader: string | null): AuthResult`
    - Compare Bearer token against `process.env.PUSH_INGEST_SECRET` using constant-time comparison
    - Return `{ ok: true }` on match, `{ ok: false, status: 401, body: { error: "unauthorized" } }` otherwise
    - _Requirements: 1.1, 1.2, 1.3_

  - [x] 3.2 Create Zod schemas (`src/lib/push-ingest/schemas.ts`)
    - Define `pushPayloadSchema` with required fields: `packageName` (string min 1), `title` (string), `text` (string), `timestamp` (number positive int | ISO string)
    - Define optional fields: `postTime` (number int), `key` (string), `extras` (record unknown)
    - Define `pushResponseSchema` as discriminated union
    - Follow existing `src/lib/schemas.ts` patterns
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.3 Create rate limiter (`src/lib/push-ingest/rate-limiter.ts`)
    - Implement sliding window in-memory rate limiter
    - Export `checkRateLimit(ip: string): RateLimitResult`
    - Configurable limit via `PUSH_INGEST_RATE_LIMIT` env var (default 60/min)
    - Return `{ allowed: true }` or `{ allowed: false, retryAfter: number }`
    - _Requirements: 4.1, 4.2, 4.3_

  - [ ]* 3.4 Write property tests for auth module
    - **Property 1: Auth Validation Correctness**
    - Test with arbitrary strings, null, valid Bearer token, malformed headers
    - Verify: only exact `Bearer <PUSH_INGEST_SECRET>` passes
    - **Validates: Requirements 1.1, 1.2, 1.3**

  - [ ]* 3.5 Write property tests for schema validation
    - **Property 2: Schema Validation Completeness**
    - Generate random objects, valid payloads with mutations
    - Verify: passes iff packageName non-empty + title string + text string + valid timestamp
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4**

  - [ ]* 3.6 Write property test for rate limiter
    - **Property 4: Rate Limiter Monotonic Rejection**
    - Generate N requests from same IP within window
    - Verify: first N allowed, N+1 rejected with retryAfter > 0
    - **Validates: Requirements 4.1, 4.2, 4.3**

- [x] 4. Implement Phase 0 Route Handler (log-only mode)
  - [x] 4.1 Create Route Handler (`src/app/api/push-ingest/route.ts`)
    - Export async `POST(request: Request)` function
    - Pipeline: auth → JSON parse → Zod validate → rate limit → INSERT push_raw_log → respond 200
    - Read `PUSH_INGEST_MODE` env var; if not `"full_pipeline"`, operate as `log_only`
    - In `log_only` mode: after raw log INSERT, respond `{"status": "logged"}`
    - Handle errors per design Error Handling table (401, 400, 422, 429, 500)
    - Respond within 3s target
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.5, 4.1, 4.2, 4.3, 17.1, 17.2, 17.3, 17.4, 18.1, 18.3_

  - [ ]* 4.2 Write property test for mode fallback
    - **Property 13: Mode Fallback Safety**
    - Generate arbitrary strings for PUSH_INGEST_MODE
    - Verify: any value other than exactly "full_pipeline" behaves as log_only
    - **Validates: Requirements 17.2, 17.4**

- [x] 5. Checkpoint — Phase 0 complete, deploy to Vercel
  - Ensure all tests pass, ask the user if questions arise.
  - User should deploy to Vercel, configure PUSH_INGEST_SECRET, set PUSH_INGEST_MODE=log_only
  - User configures Android forwarder and makes real purchases to collect ~15-20 payloads

- [x] 6. Implement Phase 1 pipeline modules (dedup, FX, pipeline orchestrator)
  - [x] 6.1 Create dedup engine (`src/lib/push-ingest/dedup.ts`)
    - Implement `computeDedupKey(payload: PushPayload): string` — hash of (packageName + title + text + floor(timestamp/60000))
    - Implement `isDuplicate(dedupKey: string): Promise<boolean>` — query push_ingest_log by PK
    - Use SHA-256 hash for deterministic key generation
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 6.2 Create FX service client (`src/lib/push-ingest/fx.ts`)
    - Implement `getExchangeRate(from, to, timeoutMs?)` with configurable timeout (default 2s)
    - Implement `resolveRate(nativeCurrency)` — return rate 1 for USD/USDT, otherwise call FX API
    - FX API URL configurable via `FX_SERVICE_URL` env var
    - Return `{ ok: true, rate }` or `{ ok: false, reason: "timeout" | "error" }`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 6.3 Create categorizer (`src/lib/push-ingest/categorizer.ts`)
    - Implement `categorize(merchant, userId)` — query `merchant_category_rules` ordered by priority DESC
    - Match using ILIKE or regex based on `match_type` column
    - Return `{ matched: true, category_id, rule_id }` or `{ matched: false }`
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 6.4 Create transfer classifier (`src/lib/push-ingest/classifier.ts`)
    - Implement `classify(parsed, userId)` — query `transfer_classification_rules`
    - Allowlist match → `{ type: "transfer", is_payment: true }`
    - Denylist match → `{ type: "expense" }`
    - No match → `{ type: "unknown", needs_review: true }`
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [ ]* 6.5 Write property test for dedup key
    - **Property 5: Dedup Key Determinism and Collision**
    - Generate pairs of payloads with varying timestamps
    - Verify: same key iff same packageName + title + text + same minute-truncated timestamp
    - **Validates: Requirements 6.1**

  - [ ]* 6.6 Write property test for FX calculation
    - **Property 6: FX Calculation Correctness**
    - Generate (amount_native, native_currency, fx_rate) tuples
    - Verify: USD/USDT → rate=1, amount_usd=amount_native; else amount_usd = round(amount*rate, 4)
    - **Validates: Requirements 7.2, 7.3, 7.4**

- [x] 7. Implement Phase 1 parser registry and stub parsers
  - [x] 7.1 Create parser registry (`src/lib/push-ingest/parser-registry.ts`)
    - Implement `parserRegistry: Map<string, ParserFn>`
    - Export `getParser(packageName)`, `registerParser(packageName, parser)`
    - _Requirements: 5.1, 5.2, 5.3_

  - [x] 7.2 Create parser stubs (`src/lib/push-ingest/parsers/`)
    - Create `bancolombia.ts` — stub parser for `com.todo1.mobile`, returns null (TBD post Fase 0)
    - Create `rappi.ts` — stub parser for `com.grability.rappi`, returns null
    - Create `google-wallet.ts` — stub parser for `com.google.android.apps.walletnfcrel`, returns null
    - Create `nexo.ts` — stub parser for `com.nexo.*`, returns null
    - Each file exports a `ParserFn` with a TODO comment for implementation post payload analysis
    - _Requirements: 5.4, 5.5_

  - [x] 7.3 Create pipeline orchestrator (`src/lib/push-ingest/pipeline.ts`)
    - Implement `executePipeline(payload, mode, userId): Promise<PipelineResult>`
    - Orchestrate: raw log → (if log_only return) → parser lookup → dedup check → classify → categorize → FX → INSERT transaction → update ingest_log → return result
    - Handle `no_parser`, `duplicate`, `fx_pending`, `registration_failed` states
    - Resolve `account_name` to `account_id` via DB query
    - _Requirements: 3.1, 5.2, 5.3, 6.1, 6.2, 6.3, 7.1, 7.5, 8.1, 8.2, 8.3, 8.4, 8.5, 9.1, 10.1, 17.2, 17.3, 18.4_

- [x] 8. Wire Route Handler to full pipeline
  - [x] 8.1 Update Route Handler for `full_pipeline` mode
    - When `PUSH_INGEST_MODE=full_pipeline`, call `executePipeline()` after raw log INSERT
    - Map pipeline result to appropriate HTTP response (always 200 for downstream states, 500 only for raw log failure)
    - Include `OWNER_USER_ID` env var for stamping user_id on transactions
    - _Requirements: 8.2, 17.3, 18.1, 18.2, 18.4_

  - [ ]* 8.2 Write property tests for categorizer priority
    - **Property 8: Merchant Categorization Priority**
    - Generate merchant strings + ordered rule sets with priorities
    - Verify: highest priority matching rule wins; no match → { matched: false }
    - **Validates: Requirements 9.1, 9.2, 9.3, 9.4**

  - [ ]* 8.3 Write property tests for transfer classification
    - **Property 9: Transfer Classification Trichotomy**
    - Generate parsed transactions + rule sets (allowlist/denylist)
    - Verify: exactly one of three outcomes, mutually exclusive and exhaustive
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4**

- [x] 9. Checkpoint — Phase 1 complete
  - Ensure all tests pass, ask the user if questions arise.
  - User writes actual parsers based on collected payloads from Phase 0
  - User switches `PUSH_INGEST_MODE=full_pipeline` in Vercel env vars

- [x] 10. Implement Phase 2 — Cross-source dedup + Semaphore
  - [x] 10.1 Create cross-source dedup logic (`src/lib/push-ingest/dedup.ts` — extend)
    - Implement `findCrossSourceDuplicate(amount_native, excludePackage, timestamp)` — query push_ingest_log for same amount from different package within 2-min window
    - Implement retention logic: keep transaction with non-null merchant; if tie, keep earlier
    - Mark discarded transaction as `deduped_cross_source` with `related_dedup_key`
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [x] 10.2 Create semaphore pure function (`src/lib/push-ingest/semaphore.ts`)
    - Implement `computeSemaphore(input: SemaphoreInput): SemaphoreResult`
    - verde: accumulated_spend < ceiling × (current_day / days_in_month)
    - amarillo: ceiling × (current_day / days_in_month) ≤ accumulated_spend < ceiling
    - rojo: accumulated_spend ≥ ceiling
    - Return full SemaphoreResult with state, spent, ceiling, pct, expected_pct, day, days_in_month
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

  - [x] 10.3 Integrate cross-source dedup and semaphore into pipeline
    - Call `findCrossSourceDuplicate` before transaction INSERT in `pipeline.ts`
    - After successful transaction INSERT, query accumulated spend for current month and call `computeSemaphore`
    - Include semaphore result in pipeline response
    - Read `SEMAPHORE_CEILING_USD` from env var
    - _Requirements: 11.1, 12.1_

  - [ ]* 10.4 Write property test for semaphore
    - **Property 7: Semaphore State Correctness**
    - Generate valid SemaphoreInput (ceiling > 0, day 1-31, days 28-31, spend ≥ 0)
    - Verify: state matches thresholds exactly, function is pure (same input → same output)
    - **Validates: Requirements 12.2, 12.3, 12.4, 12.5**

  - [ ]* 10.5 Write property test for cross-source dedup window
    - **Property 10: Cross-Source Dedup Window**
    - Generate pairs of timestamps from different packages with same amount
    - Verify: duplicates iff |t1 - t2| ≤ 2 minutes
    - **Validates: Requirements 11.1, 11.5**

  - [ ]* 10.6 Write property test for cross-source retention selection
    - **Property 11: Cross-Source Dedup Retention Selection**
    - Generate pairs of transactions with varying merchant/created_at
    - Verify: non-null merchant retained; if tie, earlier created_at retained
    - **Validates: Requirements 11.2, 11.3**

- [x] 11. Implement Phase 2 — Semaphore UI + Alert
  - [x] 11.1 Create semaphore TanStack Query hook (`src/hooks/use-semaphore.ts`)
    - Query accumulated spend for current month from `transactions` (where is_payment=false, source='push_ingest')
    - Call `computeSemaphore` with result + ceiling from config
    - Invalidate on new transaction registration
    - _Requirements: 13.3, 13.5_

  - [x] 11.2 Create semaphore gauge component (`src/components/semaphore-gauge.tsx`)
    - Render Recharts gauge/progress bar showing verde/amarillo/rojo state
    - Display: accumulated spend, ceiling, percentage consumed, state text
    - Use accessible colors + text labels for each state
    - Consistent with existing chart components in `src/components/charts/`
    - _Requirements: 13.1, 13.2, 13.4_

  - [x] 11.3 Implement alert mechanism (stub)
    - Add alert dispatch logic in pipeline after semaphore state change detection
    - Store last alert state in DB or memory to ensure idempotency (one alert per transition per month)
    - Alert channel TBD — implement as console.log + structured event for now
    - _Requirements: 14.1, 14.2, 14.3, 14.4_

  - [ ]* 11.4 Write property test for alert idempotency
    - **Property 12: Alert Idempotency**
    - Generate sequences of semaphore transitions within same month
    - Verify: exactly one alert per (month, state_before, state_after) pair
    - **Validates: Requirements 14.4**

- [x] 12. Final integration and wiring
  - [x] 12.1 Wire semaphore component into dashboard
    - Import and render `<SemaphoreGauge />` in `src/app/(app)/page.tsx`
    - Position alongside existing stat cards
    - Ensure responsive layout
    - _Requirements: 13.1, 13.5_

  - [ ] 12.2 End-to-end integration verification
    - Verify full flow: push payload → auth → validate → raw log → parse → dedup → FX → register → semaphore → respond
    - Verify log_only mode still works independently
    - Verify all error paths respond correctly (401, 400, 422, 429, 500, 200 with status)
    - Verify cross-source dedup with pipeline integration
    - _Requirements: 1.1–1.5, 2.1–2.4, 3.1–3.5, 4.1–4.3, 5.1–5.5, 6.1–6.4, 7.1–7.5, 8.1–8.5, 9.1–9.4, 10.1–10.4, 11.1–11.5, 12.1–12.6, 17.1–17.4, 18.1–18.4_

- [ ] 13. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- **Phase 0 MUST be deployed first** — parser implementations are stubs until real payloads are collected
- Parser stubs (task 7.2) return `null` intentionally — they will be written from real payload data post Phase 0
- The test runner (vitest + fast-check) is added as the first task since none exists yet
- FX service URL and semaphore ceiling are configurable via env vars (values TBD)
- All DB writes use service role key (bypass RLS), same pattern as maquinita-mcp
- Vercel timeout constraint: pipeline must respond < 3s; FX has 2s internal timeout with fx_pending fallback

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["3.1", "3.2", "3.3"] },
    { "id": 3, "tasks": ["3.4", "3.5", "3.6", "4.1"] },
    { "id": 4, "tasks": ["4.2"] },
    { "id": 5, "tasks": ["6.1", "6.2", "6.3", "6.4", "7.1"] },
    { "id": 6, "tasks": ["6.5", "6.6", "7.2", "7.3"] },
    { "id": 7, "tasks": ["8.1"] },
    { "id": 8, "tasks": ["8.2", "8.3"] },
    { "id": 9, "tasks": ["10.1", "10.2"] },
    { "id": 10, "tasks": ["10.3", "10.4", "10.5", "10.6"] },
    { "id": 11, "tasks": ["11.1", "11.2", "11.3"] },
    { "id": 12, "tasks": ["11.4", "12.1", "12.2"] }
  ]
}
```
