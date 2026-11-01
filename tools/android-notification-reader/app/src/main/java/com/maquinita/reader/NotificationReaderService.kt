package com.maquinita.reader

import android.app.Notification
import android.content.ComponentName
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONObject

/**
 * Reads notifications and decides, through PackagePolicy, what happens to each.
 *
 * Apps on the user's list go to the ingest queue. An app nobody decided about,
 * whose notification looks like money moving, is held on the phone and the user is
 * asked "¿Registrar los pagos de esta app?". Everything else is dropped right here:
 * the service can see every notification on the phone, and nothing outside the
 * list ever leaves the device.
 *
 * The list itself comes from the server (PolicyStore / AppsSyncWorker), so adding
 * a bank no longer needs a new APK.
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
        val extras = sbn.notification.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()

        // Banks truncate the interesting part into EXTRA_TEXT and put the full
        // sentence in EXTRA_BIG_TEXT, so take whichever is longer.
        val text = listOfNotNull(
            extras.getCharSequence(Notification.EXTRA_TEXT)?.toString(),
            extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString(),
        ).maxByOrNull { it.length }.orEmpty()

        if (title.isBlank() && text.isBlank()) return

        val verdict = PolicyStore(applicationContext).current().decide(sbn.packageName, title, text)
        if (verdict == PackagePolicy.Verdict.IGNORE) return

        val payload = JSONObject()
            .put("packageName", sbn.packageName)
            .put("title", title)
            .put("text", text)
            // Epoch ms. The server's dedup key is derived from this, so posting the
            // same notification twice collapses server-side instead of duplicating.
            .put("timestamp", sbn.postTime)
            .put("key", sbn.key)
            .toString()

        if (verdict == PackagePolicy.Verdict.FORWARD) {
            IngestQueue.add(applicationContext, payload)
            UploadWorker.enqueue(applicationContext)
            return
        }

        // CANDIDATE: kept on the phone until the user answers. An ongoing notification
        // (player, navigation, an upload) is never a payment worth asking about.
        if (sbn.isOngoing) return
        val label = appLabel(sbn.packageName)
        val waiting = CandidateStore(applicationContext).hold(sbn.packageName, label, payload)
        val sample = listOf(title, text).filter { it.isNotBlank() }.joinToString(": ").take(160)
        AppPrompt.show(applicationContext, sbn.packageName, label, sample, waiting)
    }

    /**
     * The name the user knows the app by. Package visibility hides most apps from
     * us on Android 11+, so a readable guess from the package name is the fallback.
     */
    private fun appLabel(packageName: String): String = try {
        val info = packageManager.getApplicationInfo(packageName, 0)
        packageManager.getApplicationLabel(info).toString().ifBlank { PackagePolicy.fallbackLabel(packageName) }
    } catch (_: Exception) {
        PackagePolicy.fallbackLabel(packageName)
    }

    companion object {
        @Volatile
        private var connected = false

        /** Whether the system has this listener bound right now. */
        val isConnected: Boolean get() = connected
    }
}
