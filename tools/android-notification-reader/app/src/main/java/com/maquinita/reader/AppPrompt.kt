package com.maquinita.reader

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat

/**
 * "¿Registrar los pagos de Brubank?" with Sí / No, asked once per app.
 *
 * Posted when an app nobody decided about sends something that looks like money
 * moving. While it is unanswered, more notifications from that app update the
 * same prompt (with a count) instead of buzzing again.
 */
object AppPrompt {

    private const val CHANNEL_ID = "new_apps"
    private const val EXTRA_PACKAGE = "package"
    private const val EXTRA_LABEL = "label"
    private const val EXTRA_DECISION = "decision"

    fun show(context: Context, packageName: String, label: String, sample: String, waiting: Int) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.apps_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { description = context.getString(R.string.apps_channel_description) },
        )

        val body = if (waiting > 1) {
            context.getString(R.string.apps_prompt_body_many, sample, waiting)
        } else {
            context.getString(R.string.apps_prompt_body_one, sample)
        }

        val notification = Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(context.getColor(R.color.brand_green))
            .setContentTitle(context.getString(R.string.apps_prompt_title, label))
            .setContentText(sample)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setOnlyAlertOnce(true)
            .setAutoCancel(false)
            .addAction(action(context, packageName, label, PackagePolicy.ALLOWED, R.string.apps_prompt_yes))
            .addAction(action(context, packageName, label, PackagePolicy.BLOCKED, R.string.apps_prompt_no))
            .build()

        // Without the permission the prompt cannot show; the app stays a candidate and
        // can still be approved from Ajustes in the web app.
        try {
            NotificationManagerCompat.from(context).notify(notificationId(packageName), notification)
        } catch (_: SecurityException) {
        }
    }

    fun cancel(context: Context, packageName: String) {
        NotificationManagerCompat.from(context).cancel(notificationId(packageName))
    }

    /** Stable per app, and clear of the watchdog's id 1. */
    private fun notificationId(packageName: String): Int = 1000 + (packageName.hashCode() and 0x3fffffff) % 100_000

    private fun action(
        context: Context,
        packageName: String,
        label: String,
        decision: String,
        title: Int,
    ): Notification.Action {
        val intent = Intent(context, AppDecisionReceiver::class.java)
            .putExtra(EXTRA_PACKAGE, packageName)
            .putExtra(EXTRA_LABEL, label)
            .putExtra(EXTRA_DECISION, decision)
        // Distinct request codes, or the "No" PendingIntent would reuse the "Sí" extras.
        val requestCode = (packageName + decision).hashCode()
        val pending = PendingIntent.getBroadcast(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Action.Builder(null, context.getString(title), pending).build()
    }

    /**
     * Applies an answer: effective on the phone at once, posted to the server by
     * AppsSyncWorker. A "Sí" also releases what the app had waiting, so the payment
     * that triggered the question is not lost.
     */
    fun apply(context: Context, packageName: String, label: String, decision: String) {
        PolicyStore(context).record(packageName, label, decision)
        val held = CandidateStore(context).take(packageName)
        if (decision == PackagePolicy.ALLOWED && held.isNotEmpty()) {
            held.forEach { IngestQueue.add(context, it) }
            UploadWorker.enqueue(context)
        }
        cancel(context, packageName)
        AppsSync.requestNow(context)
    }

    internal fun fromIntent(intent: Intent): Triple<String, String, String>? {
        val pkg = intent.getStringExtra(EXTRA_PACKAGE) ?: return null
        val decision = intent.getStringExtra(EXTRA_DECISION) ?: return null
        if (decision != PackagePolicy.ALLOWED && decision != PackagePolicy.BLOCKED) return null
        return Triple(pkg, intent.getStringExtra(EXTRA_LABEL).orEmpty(), decision)
    }
}

/**
 * The Sí / No buttons. Not exported: only our own PendingIntents reach it, so no
 * other app can approve itself.
 */
class AppDecisionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val (pkg, label, decision) = AppPrompt.fromIntent(intent) ?: return
        AppPrompt.apply(context.applicationContext, pkg, label, decision)
    }
}
