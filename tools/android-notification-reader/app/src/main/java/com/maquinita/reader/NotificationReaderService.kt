package com.maquinita.reader

import android.app.Notification
import android.content.ComponentName
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

    /**
     * The system decides when this service is bound, and these two callbacks are
     * the only honest answer to whether it is listening right now. The flag lives
     * in a static because SensorWatchdog runs in the same process — if that process
     * was killed the flag is gone with it, which is the correct answer.
     */
    override fun onListenerConnected() {
        connected = true
    }

    override fun onListenerDisconnected() {
        connected = false
        // The documented recovery. Without it a lost binding stays lost until the
        // user toggles the permission by hand, and nothing on screen says so.
        requestRebind(ComponentName(this, NotificationReaderService::class.java))
    }

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

        // An SMS app carries everything: personal messages and one-time codes as
        // well as bank alerts. The package alone is not a good enough filter, so
        // its content has to earn the upload.
        if (sbn.packageName in SMS_PACKAGES && !isFinancialSms(title, text)) return

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

    /**
     * The sender is as good a signal as the body — bank alerts arrive from a short
     * code or a brand name — so both are matched. A one-time code is dropped even
     * when it names the bank: it never describes an expense, and it is the most
     * sensitive text on the phone.
     */
    private fun isFinancialSms(title: String, text: String): Boolean {
        val message = "$title $text"
        return FINANCIAL_SIGNAL.containsMatchIn(message) && !ONE_TIME_CODE.containsMatchIn(message)
    }

    companion object {
        @Volatile
        private var connected = false

        /** Whether the system has this listener bound right now. */
        val isConnected: Boolean get() = connected

        private val SMS_PACKAGES = setOf(
            "com.google.android.apps.messaging",
            "com.samsung.android.messaging",
            "com.android.mms",
        )

        // Nexo and other foreign services write in English, so both languages are
        // matched. A brand name alone counts as a signal, which is why the one-time
        // code list below has to cover both languages too.
        private val FINANCIAL_SIGNAL = Regex(
            "bancolombia|nequi|bbva|rappi|nexo|davivienda|" +
                "compra|transacci[oó]n|d[eé]bito|cr[eé]dito|retiro|pago|transferencia|consumo|" +
                "purchase|transaction|debit|credit card|withdraw|payment|transfer|charged",
            RegexOption.IGNORE_CASE,
        )

        private val ONE_TIME_CODE = Regex(
            "c[oó]digo|clave (?:temporal|din[aá]mica|segura)|token|\\botp\\b|" +
                "verificaci[oó]n|no la compartas|no lo compartas|" +
                "\\bcode\\b|verification|passcode|one[- ]time|do(?:n't| not) share",
            RegexOption.IGNORE_CASE,
        )

        private val WHITELIST = setOf(
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
