# Implementation Plan: Android Notification Forwarder

## Overview

Implement a native Android companion app (Kotlin) that captures financial notifications from whitelisted packages and forwards them to `POST /api/push-ingest`. The implementation follows a bottom-up approach: project scaffolding → data layer → filtering → delivery → auth → services → UI, ensuring each layer builds on the previous one with no orphaned code.

## Tasks

- [ ] 1. Project scaffolding and core interfaces
  - [ ] 1.1 Create Gradle project structure with Kotlin DSL
    - Create `android/` directory with root `build.gradle.kts`, `settings.gradle.kts`, `gradle.properties`
    - Create `app/build.gradle.kts` with minSdk 26, targetSdk 34, all dependencies from design
    - Add Gradle wrapper files (`gradle/wrapper/gradle-wrapper.jar`, `gradle-wrapper.properties`)
    - Configure KSP for Room annotation processing
    - Add Kotest + MockK test dependencies
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [ ] 1.2 Create AndroidManifest.xml and core interfaces
    - Declare all permissions: INTERNET, FOREGROUND_SERVICE, FOREGROUND_SERVICE_SPECIAL_USE, RECEIVE_BOOT_COMPLETED, ACCESS_NETWORK_STATE, POST_NOTIFICATIONS
    - Declare NotificationCaptureService, ForwarderForegroundService, BootReceiver, ConfigActivity
    - Create `MaquinitaApp.kt` Application class stub
    - Define `NotificationFilter` interface, `NotificationPayload` data class, `DeliveryResult` sealed class, `NotificationDelivery` interface, `SessionState` sealed class, `AuthManager` interface
    - _Requirements: 8.1, 8.4, 3.7_

- [ ] 2. Persistence layer (Room database + DAO)
  - [ ] 2.1 Implement Room entity and DAO
    - Create `PendingNotificationEntity` with columns: id, packageName, title, text, timestamp, key, enqueueTime
    - Create `PendingNotificationDao` with: getAllFifo(), count(), insert(), delete(), deleteExpired(cutoffMs), deleteOldest()
    - Create `RetryDatabase` RoomDatabase class with entity registration
    - _Requirements: 5.1, 5.2, 5.3_

  - [ ]* 2.2 Write property test: Queue FIFO ordering (Property 7)
    - **Property 7: Queue FIFO ordering**
    - Verify getAllFifo() returns entries sorted by enqueueTime ascending
    - Use random enqueue times, verify sort order invariant
    - **Validates: Requirements 5.3**

  - [ ]* 2.3 Write property test: Queue bounded growth invariant (Property 6)
    - **Property 6: Queue bounded growth invariant**
    - Insert 1000+ entries, verify count never exceeds 1000
    - When at capacity, oldest entry removed before new insertion
    - **Validates: Requirements 5.1, 5.8**

  - [ ]* 2.4 Write property test: Queue expiry purges only stale entries (Property 8)
    - **Property 8: Queue expiry purges only stale entries**
    - Mix of old/new enqueue times around a cutoff; verify deleteExpired removes only entries with enqueueTime < cutoffMs
    - **Validates: Requirements 5.7**

- [ ] 3. Filtering layer
  - [ ] 3.1 Implement PackageFilter
    - Hardcode whitelist: com.google.android.apps.messaging, com.google.android.apps.walletnfcrel, com.grability.rappi, com.todo1.mobile, com.bbva.nxt_argentina, com.nequi.MobileApp, com.nexowallet
    - Return true only if packageName is in whitelist
    - _Requirements: 1.2, 1.3, 1.5_

  - [ ] 3.2 Implement KeywordFilter
    - Hardcode Financial_Keywords: "bancolombia", "compra", "transferencia", "retiro", "recibiste", "pago", "nequi", "rappi", "bold"
    - Case-insensitive substring match against notification text
    - Return true if at least one keyword matches; false if text is null/empty or no match
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [ ] 3.3 Implement DuplicateFilter
    - Track last-seen postTime per notification key (use ConcurrentHashMap with periodic cleanup)
    - Reject if same key arrives within 2000ms of previous
    - _Requirements: 1.8_

  - [ ]* 3.4 Write property test: Notification filter completeness (Property 1)
    - **Property 1: Notification filter completeness**
    - Random package names (from whitelist + random) + random text (with/without keywords)
    - Verify filter accepts iff: packageName in whitelist AND (not SMS OR text contains keyword)
    - **Validates: Requirements 1.3, 1.4, 1.5, 2.2, 2.3, 2.4**

  - [ ]* 3.5 Write property test: Keyword filter case insensitivity (Property 2)
    - **Property 2: Keyword filter case insensitivity**
    - Random keywords with random case permutation; verify accepts identically to lowercase
    - **Validates: Requirements 2.2**

  - [ ]* 3.6 Write property test: Duplicate window enforcement (Property 3)
    - **Property 3: Duplicate window enforcement**
    - Random notification keys + pairs of timestamps with delta in [0, 5000]ms
    - Verify second rejected iff delta < 2000ms
    - **Validates: Requirements 1.8**

- [ ] 4. Delivery layer (OkHttp + payload + auth interceptor)
  - [ ] 4.1 Implement PayloadBuilder
    - Convert notification data (packageName, title, text, postTime, key) to `NotificationPayload`
    - Substitute empty string for null title/text fields
    - Serialize to JSON matching backend `pushPayloadSchema`
    - _Requirements: 1.1, 1.6, 4.1_

  - [ ] 4.2 Implement AuthInterceptor
    - OkHttp Interceptor that adds `Authorization: Bearer <JWT>` header
    - Call `AuthManager.getValidToken()` — if null, throw/skip (caller handles enqueue)
    - Add `Content-Type: application/json` header
    - _Requirements: 4.2, 6.3, 6.4_

  - [ ] 4.3 Implement NotificationSender
    - Create OkHttp client with 10s connection timeout, 15s read timeout
    - POST payload to backend URL
    - Classify response: 2xx → Success, 429 → TransientFailure, 4xx → PermanentFailure, 5xx → TransientFailure
    - Network exceptions (IOException, timeout) → TransientFailure
    - _Requirements: 4.3, 4.4, 4.5, 4.6, 4.7, 9.1, 9.2_

  - [ ]* 4.4 Write property test: Payload construction preserves data (Property 4)
    - **Property 4: Payload construction preserves notification data**
    - Random strings for packageName/title/text, random positive Longs for postTime
    - Verify JSON fields match inputs exactly
    - **Validates: Requirements 1.1, 4.1**

  - [ ]* 4.5 Write property test: HTTP response classification (Property 5)
    - **Property 5: HTTP response classification is deterministic and correct**
    - Random ints in [200, 599]; verify classification matches spec
    - **Validates: Requirements 4.4, 4.5, 4.6**

- [ ] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Auth layer (Supabase + EncryptedSharedPreferences)
  - [ ] 6.1 Implement SupabaseAuthManager
    - Initialize Supabase client with Google OAuth provider
    - Implement `signIn(activity)`: launch Google OAuth flow via Supabase SDK
    - Implement `signOut()`: clear tokens from EncryptedSharedPreferences, transition to NoSession
    - Implement `getValidToken()`: check expiresAt, refresh if expired (10s timeout), return JWT or null
    - Expose `sessionState: StateFlow<SessionState>` (Authenticated, NoSession, Refreshing)
    - Store/retrieve tokens from EncryptedSharedPreferences (supabase_access_token, supabase_refresh_token, supabase_expires_at, supabase_user_email)
    - On sign-in success with pending queue: trigger FIFO drain
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8_

  - [ ]* 6.2 Write property test: No-session state forces enqueue (Property 9)
    - **Property 9: No-session state forces enqueue**
    - Random payloads with mocked NoSession state; verify zero network calls and all enqueued
    - **Validates: Requirements 6.6**

- [ ] 7. Service layer (ForegroundService + NotificationListener + BootReceiver)
  - [ ] 7.1 Implement ForwarderForegroundService
    - Create notification channel (maquinita_foreground, IMPORTANCE_MIN, no sound/vibration)
    - Start as foreground with persistent "Maquinita activa" notification
    - Declare foregroundServiceType="specialUse"
    - Store `service_enabled` flag in EncryptedSharedPreferences
    - _Requirements: 3.1, 3.2, 3.7_

  - [ ] 7.2 Implement NotificationCaptureService
    - Override `onNotificationPosted()`: extract packageName, title, text, postTime, key
    - Skip group summary notifications (FLAG_GROUP_SUMMARY check)
    - Apply filter chain: PackageFilter → KeywordFilter (SMS only) → DuplicateFilter
    - On pass: build payload → check session state → deliver or enqueue
    - Handle null title/text by substituting empty string
    - Override `onListenerDisconnected()`: attempt requestRebind() up to 3 times at 30s intervals; post user notification if all fail
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 3.3, 3.4, 3.5_

  - [ ] 7.3 Implement BootReceiver
    - On BOOT_COMPLETED: check `service_enabled` preference → start ForwarderForegroundService if true
    - _Requirements: 3.6_

- [ ] 8. Background retry (WorkManager + ConnectivityObserver)
  - [ ] 8.1 Implement RetryWorker
    - WorkManager periodic task (minimum interval 15 minutes)
    - On doWork(): purge expired entries (7-day TTL), process queue in FIFO order
    - For each entry: attempt delivery → Success: delete, PermanentFailure: delete + log, TransientFailure: keep
    - _Requirements: 5.3, 5.4, 5.5, 5.6, 5.7_

  - [ ] 8.2 Implement ConnectivityObserver
    - Register NetworkCallback via ConnectivityManager
    - On network available (offline→online transition): schedule expedited one-time WorkManager task
    - Debounce: only one retry task per 30-second window
    - _Requirements: 9.3, 9.4_

  - [ ]* 8.3 Write property test: Connectivity event debounce (Property 11)
    - **Property 11: Connectivity event debounce**
    - Random sequences of timestamps within [0, 120]s window
    - Verify at most one retry task scheduled per 30-second window
    - **Validates: Requirements 9.3**

- [ ] 9. UI layer (ConfigActivity + ViewModel + Adapter)
  - [ ] 9.1 Implement ConfigViewModel
    - Expose: service state (Activa/Detenida), queue count, notification log (last 50), session state
    - Observe ForegroundService lifecycle for state updates
    - Format title for display (truncate at 40 chars + "…")
    - _Requirements: 7.1, 7.2, 7.5, 7.6_

  - [ ] 9.2 Implement ConfigActivity and layout
    - Create `activity_config.xml` layout: service status text, toggle switch, queue count, sign-in button/email display, RecyclerView for log
    - Wire toggle to start/stop ForegroundService
    - If toggle ON but notification permission not granted: open system notification access settings
    - Display sign-in button (NoSession) or user email (Authenticated)
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [ ] 9.3 Implement NotificationLogAdapter
    - RecyclerView.Adapter displaying: packageName, truncated title (40 chars + "…"), delivery status ("enviada", "fallida", "pendiente")
    - Ordered newest first
    - _Requirements: 7.2_

  - [ ]* 9.4 Write property test: Title truncation for display (Property 10)
    - **Property 10: Title truncation for display**
    - Random strings of length [0, 200]; verify ≤40 chars unchanged, >40 truncated with "…"
    - **Validates: Requirements 7.2**

- [ ] 10. Integration wiring and queue capacity enforcement
  - [ ] 10.1 Wire queue capacity enforcement in enqueue logic
    - Before insert: check count() — if ≥ 1000, call deleteOldest() before inserting
    - Ensure this is applied in all enqueue paths (delivery failure, no-session state)
    - _Requirements: 5.8_

  - [ ] 10.2 Wire all components in MaquinitaApp
    - Initialize Room database, OkHttp client with AuthInterceptor, SupabaseAuthManager
    - Register WorkManager periodic retry task on app start
    - Provide dependencies to services and activity via Application-level singletons
    - _Requirements: 8.3, 8.4_

  - [ ]* 10.3 Write unit tests for RetryWorker and BootReceiver
    - RetryWorker: verify success removes entry, permanent failure removes + logs, transient keeps
    - BootReceiver: verify respects service_enabled preference
    - _Requirements: 5.4, 5.5, 5.6, 3.6_

- [ ] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties using Kotest property-based testing
- Unit tests validate specific examples and edge cases using JUnit 5 + MockK
- The project is Kotlin-only, built with Gradle Kotlin DSL, independent from the Next.js parent project
- All code lives under `android/` in the monorepo

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "3.1", "3.2", "3.3"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.4", "3.4", "3.5", "3.6", "4.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "4.4"] },
    { "id": 5, "tasks": ["4.5", "6.1"] },
    { "id": 6, "tasks": ["6.2", "7.1", "7.3"] },
    { "id": 7, "tasks": ["7.2", "8.1", "8.2"] },
    { "id": 8, "tasks": ["8.3", "9.1"] },
    { "id": 9, "tasks": ["9.2", "9.3", "9.4"] },
    { "id": 10, "tasks": ["10.1", "10.2"] },
    { "id": 11, "tasks": ["10.3"] }
  ]
}
```
