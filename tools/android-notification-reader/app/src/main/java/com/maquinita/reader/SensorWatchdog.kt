package com.maquinita.reader

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.service.notification.NotificationListenerService
import androidx.core.app.NotificationManagerCompat
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Re-checks that the notification listener is still bound, and asks the system to
 * bind it again when it is not.
 *
 * This used to be a foreground service, which meant a notification sitting in the
 * shade forever. It bought nothing: the system is what binds the listener, and the
 * upload goes out through WorkManager with its own network access — measured
 * end-to-end, a purchase reaches the server in under a second either way. So all
 * that is left is the periodic check, and periodic work is what WorkManager is for.
 * It also survives reboots on its own, which is why there is no boot receiver.
 *
 * Something still has to be visible when the sensor is actually broken, otherwise a
 * dashboard that stopped receiving expenses looks identical to one with no expenses.
 * That is now a notification only in the one case the user has to act on — the
 * access being gone — and it is cancelled as soon as the sensor is listening again.
 */
class SensorWatchdog(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val notifications = NotificationManagerCompat.from(applicationContext)

        if (applicationContext.packageName !in
            NotificationManagerCompat.getEnabledListenerPackages(applicationContext)
        ) {
            notifications.notify(NOTIFICATION_ID, buildNoAccessNotification())
            return Result.success()
        }

        notifications.cancel(NOTIFICATION_ID)

        // The flag is a static in this process, so a process that was just started
        // for this check reports "not connected" even when the system would bind on
        // demand. Asking anyway is the right answer to both cases: requestRebind is
        // idempotent, and a fresh process is precisely when a bind may be missing.
        if (!NotificationReaderService.isConnected) {
            NotificationListenerService.requestRebind(
                ComponentName(applicationContext, NotificationReaderService::class.java)
            )
        }

        return Result.success()
    }

    /** Actionable, so it alerts — unlike the status line this replaced. */
    private fun buildNoAccessNotification(): Notification {
        val manager = applicationContext.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                applicationContext.getString(R.string.sensor_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT,
            )
        )

        val tap = PendingIntent.getActivity(
            applicationContext,
            0,
            Intent(applicationContext, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return Notification.Builder(applicationContext, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(applicationContext.getColor(R.color.brand_green))
            .setContentTitle(applicationContext.getString(R.string.sensor_warning_title))
            .setContentText(applicationContext.getString(R.string.sensor_status_no_access))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .build()
    }

    companion object {
        private const val WORK_NAME = "sensor-watchdog"
        private const val CHANNEL_ID = "sensor"
        private const val NOTIFICATION_ID = 1

        /**
         * Safe to call on every launch: `KEEP` leaves an already-scheduled watchdog
         * alone instead of restarting its interval.
         */
        fun schedule(context: Context) {
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                // 15 minutes is also WorkManager's floor for periodic work.
                PeriodicWorkRequestBuilder<SensorWatchdog>(15, TimeUnit.MINUTES).build(),
            )
        }
    }
}
