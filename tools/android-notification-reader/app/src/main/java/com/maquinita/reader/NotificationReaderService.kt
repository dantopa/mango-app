package com.maquinita.reader

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONObject

/**
 * Reads notifications from the financial apps and hands them to the ingest queue.
 *
 * Only whitelisted packages are read: the service can see every notification on
 * the phone, and nothing outside this list should ever leave the device. The
 * server enforces the same list — this copy is what keeps unrelated notification
 * text from being uploaded at all.
 *
 * Keep in sync with src/lib/push-ingest/package-whitelist.ts.
 */
class NotificationReaderService : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName !in WHITELIST) return

        val extras = sbn.notification.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()

        // Banks truncate the interesting part into EXTRA_TEXT and put the full
        // sentence in EXTRA_BIG_TEXT, so take whichever is longer.
        val text = listOfNotNull(
            extras.getCharSequence(Notification.EXTRA_TEXT)?.toString(),
            extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString(),
        ).maxByOrNull { it.length }.orEmpty()

        if (title.isBlank() && text.isBlank()) return

        val payload = JSONObject()
            .put("packageName", sbn.packageName)
            .put("title", title)
            .put("text", text)
            // Epoch ms. The server's dedup key is derived from this, so posting the
            // same notification twice collapses server-side instead of duplicating.
            .put("timestamp", sbn.postTime)
            .put("key", sbn.key)

        IngestQueue.add(applicationContext, payload.toString())
        UploadWorker.enqueue(applicationContext)
    }

    private companion object {
        val WHITELIST = setOf(
            // Banking apps
            "com.todo1.mobile",                     // Bancolombia
            "com.bbva.nxt_argentina",               // BBVA Argentina
            "com.nequi.MobileApp",                  // Nequi

            // Payment / card apps
            "com.grability.rappi",                  // Rappi / RappiCard
            "com.google.android.apps.walletnfcrel", // Google Wallet (tap-to-pay)

            // Crypto / broker
            "com.nexowallet",                       // Nexo

            // SMS / messaging (bank alerts come via SMS too)
            "com.google.android.apps.messaging",    // Google Messages
            "com.samsung.android.messaging",        // Samsung Messages
            "com.android.mms",                      // AOSP SMS
        )
    }
}
