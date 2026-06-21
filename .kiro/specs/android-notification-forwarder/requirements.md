# Requirements Document

## Introduction

Native Android companion app (Kotlin) for **Maquinita** that captures financial notifications from the phone and forwards them to the backend endpoint `POST /api/push-ingest`. Replaces the current Tasker + Autonotification setup which loses notifications when the process dies in the background. The app lives in `android/` inside the existing mango-app monorepo and is distributed via sideload (no Play Store).

## Glossary

- **Forwarder**: The Android notification-forwarding application described in this document
- **NotificationListenerService**: Android system service that receives callbacks when notifications are posted or removed
- **ForegroundService**: An Android service that shows a persistent notification and is protected from being killed by the OS
- **Retry_Queue**: A local SQLite database (Room) that stores notifications which failed to send, for later retry
- **Backend**: The Next.js Route Handler at `POST /api/push-ingest` hosted on Vercel
- **Whitelist**: The set of package names whose notifications the Forwarder captures
- **Financial_Keywords**: A set of substrings (e.g., "Bancolombia", "compra", "transferencia") used to filter SMS notifications
- **WorkManager**: Android Jetpack library for scheduling deferrable background work
- **Bearer_Token**: The authentication secret sent in the `Authorization: Bearer <token>` header to the Backend
- **Config_Activity**: The single minimal Activity providing service status, logs, and on/off toggle

## Requirements

### Requirement 1: Notification Capture

**User Story:** As a user, I want the app to capture all notifications from whitelisted financial packages, so that no transaction notification is missed.

#### Acceptance Criteria

1. WHEN a notification is posted by a whitelisted package, THE Forwarder SHALL capture the notification and extract packageName (from StatusBarNotification.getPackageName()), title (from Notification.extras EXTRA_TITLE), text (from Notification.extras EXTRA_TEXT), and timestamp (from StatusBarNotification.getPostTime(), epoch milliseconds)
2. THE Forwarder SHALL maintain a Whitelist containing these package names: com.google.android.apps.messaging, com.google.android.apps.walletnfcrel, com.grability.rappi, com.todo1.mobile, com.bbva.nxt_argentina, com.nequi.MobileApp, com.nexowallet
3. WHEN a notification is posted by a non-whitelisted package, THE Forwarder SHALL ignore the notification without processing
4. WHEN a notification is posted by com.google.android.apps.messaging, THE Forwarder SHALL forward it only if the text field contains at least one Financial_Keyword
5. WHEN a notification is posted by a whitelisted package other than com.google.android.apps.messaging, THE Forwarder SHALL forward the notification without additional text filtering
6. IF a notification's title or text field is null or empty, THE Forwarder SHALL use an empty string ("") for that field and proceed with normal filtering and delivery
7. WHEN a group summary notification is posted (where Notification.extras contains FLAG_GROUP_SUMMARY), THE Forwarder SHALL ignore the group summary and only process individual child notifications
8. WHEN a notification with the same key (StatusBarNotification.getKey()) is posted within 2 seconds of a previously captured notification, THE Forwarder SHALL treat it as a duplicate and discard the second occurrence

#### Correctness Properties

- **Completeness**: For every notification posted by a whitelisted package that passes filtering, a corresponding payload SHALL exist either in the delivery pipeline or the Retry_Queue within 5 seconds of capture
- **No False Positives**: No notification from a non-whitelisted package SHALL ever be enqueued or delivered to the Backend

### Requirement 2: SMS Keyword Filtering

**User Story:** As a user, I want SMS notifications filtered by financial keywords, so that only bank-related messages are forwarded and personal SMS is excluded.

#### Acceptance Criteria

1. THE Forwarder SHALL maintain a Financial_Keywords list containing at minimum: "bancolombia", "compra", "transferencia", "retiro", "recibiste", "pago", "nequi", "rappi", "bold"
2. WHEN evaluating an SMS notification, THE Forwarder SHALL perform a case-insensitive substring match of each Financial_Keyword against the notification text field
3. WHEN at least one Financial_Keyword matches the notification text, THE Forwarder SHALL proceed with enqueueing or delivering the notification
4. WHEN no Financial_Keyword matches the notification text, THE Forwarder SHALL discard the notification without enqueueing or sending it
5. IF the notification text field is null or empty, THE Forwarder SHALL discard the notification without enqueueing or sending it

#### Correctness Properties

- **Keyword Match Determinism**: Given the same notification text, the keyword filter SHALL always produce the same accept/reject decision
- **Case Insensitivity**: A notification containing "BANCOLOMBIA" SHALL be accepted identically to one containing "bancolombia"

### Requirement 3: Background Persistence

**User Story:** As a user, I want the app to stay alive in the background permanently, so that notifications are captured even when the phone is idle or battery-optimized.

#### Acceptance Criteria

1. THE Forwarder SHALL run a ForegroundService with a persistent notification displaying the text "Maquinita activa"
2. THE ForegroundService notification SHALL be configured as silent (no sound, no vibration, PRIORITY_MIN) in a dedicated notification channel with importance IMPORTANCE_MIN
3. WHILE the ForegroundService is running, THE Forwarder SHALL maintain an active NotificationListenerService binding to the Android notification system, verified by calling getActiveNotifications() periodically
4. IF the NotificationListenerService is disconnected by the OS, THEN THE Forwarder SHALL attempt to rebind the service within 30 seconds using requestRebind()
5. IF rebinding fails 3 consecutive times, THEN THE Forwarder SHALL post a user-visible notification prompting the user to re-enable notification access in system settings
6. WHEN the device reboots, THE Forwarder SHALL automatically restart the ForegroundService via a BOOT_COMPLETED BroadcastReceiver, provided the service toggle was ON before reboot
7. THE ForegroundService SHALL declare foregroundServiceType="specialUse" in the manifest for compatibility with Android 14+ (targetSdk 34)

#### Correctness Properties

- **Liveness**: While the toggle is ON, the ForegroundService SHALL be running within 60 seconds of any system event (boot, task kill, battery optimization)
- **Notification Access**: While the ForegroundService is running, the NotificationListenerService SHALL be connected and receiving callbacks

### Requirement 4: Payload Delivery

**User Story:** As a user, I want captured notifications sent to the backend immediately, so that transactions appear in real-time in the Maquinita dashboard.

#### Acceptance Criteria

1. WHEN a notification passes filtering, THE Forwarder SHALL send an HTTP POST request to the Backend within 3 seconds of capture, with a JSON body containing packageName (string), title (string), text (string), and timestamp (integer, epoch milliseconds)
2. THE Forwarder SHALL include an `Authorization: Bearer <Bearer_Token>` header and `Content-Type: application/json` header in every request to the Backend
3. THE Forwarder SHALL use a connection timeout of 10 seconds and a read timeout of 15 seconds for each delivery attempt
4. WHEN the Backend responds with HTTP 2xx, THE Forwarder SHALL consider the notification delivered successfully and remove it from any pending queue
5. WHEN the Backend responds with HTTP 4xx (except 429), THE Forwarder SHALL log the error locally with the HTTP status code and response body, and discard the notification without retry
6. WHEN the Backend responds with HTTP 429 or 5xx, THE Forwarder SHALL enqueue the notification in the Retry_Queue for later delivery
7. IF the HTTP request fails due to connection refused, DNS resolution failure, or timeout expiration, THEN THE Forwarder SHALL enqueue the notification in the Retry_Queue

#### Correctness Properties

- **At-Least-Once Delivery**: Every notification that passes filtering SHALL eventually be delivered to the Backend or discarded only after a permanent failure (4xx) or expiration (7 days)
- **Timeliness**: Under normal network conditions, delivery SHALL complete within 3 + 10 + 15 = 28 seconds of capture

### Requirement 5: Retry Queue with Local Persistence

**User Story:** As a user, I want failed notifications stored locally and retried automatically, so that no notification is lost due to transient network or server errors.

#### Acceptance Criteria

1. THE Retry_Queue SHALL persist pending notifications in a local Room (SQLite) database that survives app restarts, up to a maximum of 1000 entries
2. WHEN a notification is enqueued, THE Retry_Queue SHALL store the full payload (packageName, title, text, timestamp) and an enqueue_time field
3. THE Forwarder SHALL schedule a WorkManager periodic task that retries all pending notifications in the Retry_Queue at a minimum interval of 15 minutes, processing entries in FIFO order (oldest enqueue_time first)
4. WHEN a retry succeeds (HTTP 2xx), THE Forwarder SHALL remove the notification from the Retry_Queue
5. WHEN a retry fails with HTTP 4xx (except 429), THE Forwarder SHALL remove the notification from the Retry_Queue and record the failure in the app's local log with the HTTP status code and notification enqueue_time
6. WHEN a retry fails with HTTP 429 or 5xx or network error, THE Forwarder SHALL keep the notification in the Retry_Queue for the next retry cycle without modifying its enqueue_time
7. THE Retry_Queue SHALL discard notifications whose enqueue_time is older than 7 days, evaluated at the start of each retry cycle
8. IF the Retry_Queue contains 1000 entries when a new notification is enqueued, THEN THE Retry_Queue SHALL discard the oldest entry by enqueue_time before inserting the new notification

#### Correctness Properties

- **Persistence**: A notification in the Retry_Queue SHALL survive process death, app restart, and device reboot
- **Bounded Growth**: The Retry_Queue size SHALL never exceed 1000 entries
- **Eventual Delivery**: Pending entries SHALL be retried at least once every 15 minutes while the device has network connectivity

### Requirement 6: Authentication

**User Story:** As a user, I want the app authenticated with the same account as the PWA, so that only I can send notifications to my backend.

#### Acceptance Criteria

1. THE Config_Activity SHALL provide a Google OAuth sign-in flow using Supabase Auth (same provider as the PWA)
2. WHEN the user signs in successfully, THE Forwarder SHALL store the Supabase session token and refresh token in Android EncryptedSharedPreferences, persisting across app restarts and device reboots
3. THE Forwarder SHALL use the Supabase JWT as the Bearer_Token in all requests to the Backend
4. WHEN the Forwarder attempts a request and the JWT has expired, THE Forwarder SHALL invoke the Supabase SDK token refresh using the stored refresh token before sending the request, within a timeout of 10 seconds
5. IF token refresh fails due to an invalid or revoked refresh token, THEN THE Forwarder SHALL enqueue notifications in the Retry_Queue, display a re-authentication prompt in the Config_Activity, and transition to the "no valid session" state
6. WHILE no valid session exists, THE Forwarder SHALL enqueue all captured notifications in the Retry_Queue without attempting delivery
7. WHEN the user signs in successfully and the Retry_Queue contains pending notifications, THE Forwarder SHALL attempt delivery of all queued notifications in FIFO order
8. WHEN the user signs out via Config_Activity, THE Forwarder SHALL clear the stored session and refresh token from EncryptedSharedPreferences, discard the Retry_Queue, and transition to the "no valid session" state

#### Correctness Properties

- **Token Freshness**: No request to the Backend SHALL use an expired JWT
- **Secure Storage**: Tokens SHALL only be stored in EncryptedSharedPreferences, never in plain SharedPreferences or logs
- **Session Continuity**: A valid session SHALL survive app restart and device reboot without requiring re-authentication

### Requirement 7: Configuration Activity

**User Story:** As a user, I want a minimal UI to see the service status and recent activity, so that I can verify the forwarder is working.

#### Acceptance Criteria

1. THE Config_Activity SHALL display the current state of the ForegroundService as either "Activa" (running) or "Detenida" (stopped), updated within 1 second of state change
2. THE Config_Activity SHALL display a scrollable log of the last 50 sent notifications showing packageName, title (truncated to 40 characters with ellipsis), and delivery status (one of: "enviada", "fallida", "pendiente"), ordered newest first
3. THE Config_Activity SHALL provide a toggle to start or stop the ForegroundService and NotificationListenerService
4. IF the toggle is activated but NotificationListenerService permission is not granted, THEN THE Config_Activity SHALL open the system notification access settings screen
5. THE Config_Activity SHALL display the current Retry_Queue size (number of pending notifications)
6. IF a valid session exists, THEN THE Config_Activity SHALL display the authenticated user email; OTHERWISE THE Config_Activity SHALL display a Google sign-in button

#### Correctness Properties

- **UI Consistency**: The displayed service state SHALL always match the actual ForegroundService state within 1 second
- **Log Accuracy**: Every notification processed by the Forwarder SHALL appear in the activity log with its correct delivery status

### Requirement 8: Build and Distribution

**User Story:** As a developer, I want the app built with modern Android tooling and distributed via APK, so that it can be installed without Play Store dependencies.

#### Acceptance Criteria

1. THE Forwarder project SHALL use Kotlin as the programming language with minSdk 26 (Android 8.0) and targetSdk 34
2. THE Forwarder project SHALL use Gradle with Kotlin DSL for build configuration and SHALL include the Gradle wrapper so that builds are reproducible without a pre-installed Gradle version
3. THE Forwarder project SHALL declare as its only explicit third-party dependencies: OkHttp for HTTP networking, Room for local persistence, WorkManager for background scheduling, and the Supabase Android Auth SDK for authentication (standard Android platform libraries, Kotlin stdlib, and their transitive dependencies are permitted)
4. THE Forwarder project SHALL reside in the `android/` directory of the mango-app monorepo and SHALL be buildable independently without requiring the parent Next.js project's tooling or node_modules
5. WHEN a release build is executed via `./gradlew assembleRelease`, THE Forwarder project SHALL produce an APK signed with a release keystore that is installable on any device running Android 8.0 or higher via `adb install` or file-transfer sideloading

#### Correctness Properties

- **Reproducibility**: Two consecutive builds from the same source SHALL produce functionally identical APKs
- **Independence**: The Android project SHALL build successfully in a clean checkout with only JDK 17+ and the Gradle wrapper present

### Requirement 9: Networking Constraints

**User Story:** As a user, I want the app to use minimal bandwidth and handle network transitions gracefully, so that it works reliably on mobile data.

#### Acceptance Criteria

1. THE Forwarder SHALL use OkHttp as the sole HTTP client library with no other networking dependencies
2. THE Forwarder SHALL set a connection timeout of 10 seconds and a read timeout of 15 seconds for all Backend requests; IF either timeout expires, THEN the request SHALL be treated as a network failure and the notification enqueued in the Retry_Queue
3. WHEN the device transitions from offline to online (detected via ConnectivityManager.NetworkCallback), THE Forwarder SHALL schedule an expedited WorkManager one-time task to retry the Retry_Queue within 60 seconds; IF multiple connectivity events occur within 30 seconds, THEN only one retry task SHALL be scheduled (debounce)
4. THE Forwarder SHALL send requests over both WiFi and mobile data without restriction and SHALL NOT declare any NetworkRequest constraints that would limit delivery to WiFi-only

#### Correctness Properties

- **Connectivity Responsiveness**: After a network transition from offline to online, pending notifications SHALL begin retrying within 60 seconds
- **No Silent Drops**: A timeout SHALL never silently discard a notification; it SHALL always result in Retry_Queue enqueue
