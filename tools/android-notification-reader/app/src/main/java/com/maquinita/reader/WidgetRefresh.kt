package com.maquinita.reader

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/** Keeps the widget's cached summary fresh, and nothing else. */
class WidgetRefreshWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        // The periodic job is cancelled with the last widget, but a run can still
        // be in flight: do not spend a request nobody will see.
        if (MaquinitaWidget.ids(applicationContext).isEmpty()) return Result.success()

        val settings = Settings(applicationContext)
        if (!settings.isConfigured) {
            MaquinitaWidget.redrawAll(applicationContext)
            return Result.success()
        }

        val store = WidgetStore(applicationContext)
        return when (val result = WidgetApi.fetch(settings)) {
            is WidgetApi.Result.Ok -> {
                store.save(result.body, System.currentTimeMillis())
                MaquinitaWidget.redrawAll(applicationContext)
                Result.success()
            }
            WidgetApi.Result.Unauthorized -> {
                store.markUnauthorized()
                MaquinitaWidget.redrawAll(applicationContext)
                // Retrying cannot change the answer: pairing again does.
                Result.success()
            }
            is WidgetApi.Result.Failed -> {
                // Still draw: the age shown beside the figures keeps counting.
                MaquinitaWidget.redrawAll(applicationContext)
                if (runAttemptCount < MAX_RETRIES) Result.retry() else Result.success()
            }
        }
    }

    private companion object {
        const val MAX_RETRIES = 3
    }
}

object WidgetRefresh {

    private const val PERIODIC = "widget-refresh-periodic"
    private const val NOW = "widget-refresh-now"

    /** WorkManager will not go below 15 minutes; half an hour is plenty for a monthly total. */
    private const val PERIOD_MINUTES = 30L

    private val online: Constraints
        get() = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /** While at least one widget is on a home screen. */
    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<WidgetRefreshWorker>(PERIOD_MINUTES, TimeUnit.MINUTES)
            .setConstraints(online)
            .build()
        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
        WorkManager.getInstance(context).cancelUniqueWork(NOW)
    }

    /**
     * A refresh as soon as there is a connection: after an expense was uploaded,
     * when the app is opened, when a widget is added. A no-op without a widget.
     */
    fun requestNow(context: Context) {
        if (MaquinitaWidget.ids(context).isEmpty()) return
        val request = OneTimeWorkRequestBuilder<WidgetRefreshWorker>()
            .setConstraints(online)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, request)
    }
}
