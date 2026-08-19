package com.maquinita.reader

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * Drains the queue into POST /api/push-ingest, oldest first.
 *
 * A retryable failure (offline, 401 while the token is wrong, 429, 5xx) leaves
 * the payload queued and lets WorkManager back off, so nothing is lost while the
 * problem is fixed. A payload the server can never accept is dropped instead:
 * keeping it would block every notification behind it forever.
 */
class UploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    private enum class Outcome { SENT, REJECTED, RETRY }

    override fun doWork(): Result {
        val settings = Settings(applicationContext)
        if (!settings.isConfigured) {
            settings.recordResult("sin configurar")
            // The queue is kept; the next notification enqueues another attempt.
            return Result.failure()
        }

        while (true) {
            val payload = IngestQueue.peek(applicationContext) ?: return Result.success()
            when (post(settings, payload)) {
                Outcome.SENT, Outcome.REJECTED -> IngestQueue.removeFirst(applicationContext)
                Outcome.RETRY -> return Result.retry()
            }
        }
    }

    private fun post(settings: Settings, payload: String): Outcome {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(settings.endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10_000
                readTimeout = 15_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Authorization", "Bearer ${settings.token}")
            }
            connection.outputStream.use { it.write(payload.toByteArray()) }

            val code = connection.responseCode
            settings.recordResult("HTTP $code")
            when {
                code in 200..299 -> Outcome.SENT
                // Malformed or oversized: retrying cannot change the answer.
                code == 400 || code == 413 || code == 422 -> Outcome.REJECTED
                else -> Outcome.RETRY
            }
        } catch (err: IOException) {
            settings.recordResult(err.message ?: "sin conexión")
            Outcome.RETRY
        } finally {
            connection?.disconnect()
        }
    }

    companion object {
        private const val WORK_NAME = "push-ingest-upload"

        /**
         * Unique work, appended: one uploader at a time, so peek/removeFirst has a
         * single consumer and cannot drop a payload it never sent.
         */
        fun enqueue(context: Context) {
            val request = OneTimeWorkRequestBuilder<UploadWorker>()
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()

            WorkManager.getInstance(context)
                .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
        }
    }
}
