package com.maquinita.reader

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.service.notification.NotificationListenerService
import android.util.Log
import androidx.core.app.NotificationManagerCompat

/**
 * Keeps the sensor resident, visible and re-bindable.
 *
 * A foreground service does not bind the notification listener — the system does
 * that. What it fixes is the silent failure: when the listener loses its binding
 * (a battery manager killing the process is the usual cause) nothing notices, and
 * the dashboard just stops receiving expenses with no error anywhere. So this
 * service keeps the process alive, re-checks the binding on a timer and calls the
 * documented recovery when it is gone, and puts the sensor's real state in the
 * notification shade — where a broken sensor is visible instead of silent.
 */
class SensorService : Service() {

    private val handler = Handler(Looper.getMainLooper())

    private val watchdog = object : Runnable {
        override fun run() {
            post(listenerStatus())
            handler.postDelayed(this, CHECK_INTERVAL_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification(listenerStatus()))
        // Starting an already-running service lands here again, so drop the pending
        // tick instead of accumulating one watchdog per start.
        handler.removeCallbacks(watchdog)
        handler.postDelayed(watchdog, CHECK_INTERVAL_MS)
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(watchdog)
        super.onDestroy()
    }

    /**
     * Three states worth telling apart, because only one is fixable without the
     * user: no access at all (they have to grant it), granted but not bound (ask
     * the system to bind again), and listening.
     */
    private fun listenerStatus(): String {
        val granted = packageName in NotificationManagerCompat.getEnabledListenerPackages(this)
        return when {
            !granted -> getString(R.string.sensor_status_no_access)
            !NotificationReaderService.isConnected -> {
                NotificationListenerService.requestRebind(
                    ComponentName(this, NotificationReaderService::class.java)
                )
                getString(R.string.sensor_status_rebinding)
            }
            else -> getString(R.string.sensor_status_active)
        }
    }

    private fun post(status: String) {
        NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, buildNotification(status))
    }

    private fun buildNotification(status: String): Notification {
        val tap = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(getString(R.string.sensor_notification_title))
            .setContentText(status)
            .setContentIntent(tap)
            .setOngoing(true)
            .setShowWhen(false)
            .build()
    }

    /** Low importance on purpose: this is a status line, not an alert. */
    private fun createChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.sensor_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply { setShowBadge(false) }

        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    companion object {
        private const val CHANNEL_ID = "sensor"
        private const val NOTIFICATION_ID = 1
        private const val CHECK_INTERVAL_MS = 15 * 60 * 1000L
        private const val TAG = "SensorService"

        /**
         * Safe to call from anywhere and as often as you like: starting a service
         * that is already running just re-runs onStartCommand, which re-checks the
         * binding. Failures are logged rather than thrown — an Android version that
         * refuses the start from the background must not take the app down with it.
         */
        fun start(context: Context) {
            runCatching {
                context.startForegroundService(Intent(context, SensorService::class.java))
            }.onFailure { Log.w(TAG, "no se pudo iniciar el sensor", it) }
        }
    }
}
