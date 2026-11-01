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
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * Keeps the app list in step with the server, both ways.
 *
 * 1. Posts the answers given on the phone that the server has not seen.
 * 2. Downloads the list, which also carries changes made in Ajustes on the web.
 * 3. Settles held candidates the new list already decided: an app approved on the
 *    web releases what it had waiting, one blocked there deletes it.
 */
class AppsSyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val settings = Settings(applicationContext)
        if (!settings.isConfigured) return Result.success()

        val store = PolicyStore(applicationContext)

        for (answer in store.pending()) {
            val body = JSONObject()
                .put("packageName", answer.packageName)
                .put("label", answer.label.take(80))
                .put("decision", answer.decision)
                .toString()
            when (val code = request(settings, "POST", body).first) {
                in 200..299, 400, 422 -> store.confirm(answer) // 400/422: the server will never take it
                401 -> return Result.success() // pairing again fixes it, retrying does not
                else -> return if (code < 0 || code >= 500 || code == 429) Result.retry() else Result.success()
            }
        }

        val (code, body) = request(settings, "GET", null)
        if (code == 401) return Result.success()
        if (code !in 200..299 || body == null) return Result.retry()
        val policy = PackagePolicy.parse(body) ?: return Result.success()
        store.saveServer(policy)

        val current = store.current()
        val candidates = CandidateStore(applicationContext)
        var released = false
        for (candidate in candidates.all()) {
            when {
                candidate.packageName in current.allowed -> {
                    candidates.take(candidate.packageName).forEach { IngestQueue.add(applicationContext, it) }
                    AppPrompt.cancel(applicationContext, candidate.packageName)
                    released = true
                }
                candidate.packageName in current.blocked -> {
                    candidates.drop(candidate.packageName)
                    AppPrompt.cancel(applicationContext, candidate.packageName)
                }
            }
        }
        if (released) UploadWorker.enqueue(applicationContext)

        return Result.success()
    }

    /** Status code (-1 offline) and body for a 2xx. */
    private fun request(settings: Settings, method: String, body: String?): Pair<Int, String?> {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(settings.appsEndpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 10_000
                readTimeout = 15_000
                setRequestProperty("Authorization", "Bearer ${settings.token}")
                setRequestProperty("Accept", "application/json")
                if (body != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                }
            }
            if (body != null) connection.outputStream.use { it.write(body.toByteArray()) }
            val code = connection.responseCode
            val text = if (code in 200..299) connection.inputStream.use { it.readCapped() } else null
            code to text
        } catch (_: IOException) {
            -1 to null
        } finally {
            connection?.disconnect()
        }
    }

    private fun java.io.InputStream.readCapped(): String {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (true) {
            val read = read(buffer)
            if (read < 0) break
            out.write(buffer, 0, read)
            if (out.size() > MAX_BODY_BYTES) throw IOException("respuesta demasiado grande")
        }
        return out.toString(Charsets.UTF_8.name())
    }

    private companion object {
        const val MAX_BODY_BYTES = 64 * 1024
    }
}

object AppsSync {
    private const val PERIODIC = "apps-sync-periodic"
    private const val NOW = "apps-sync-now"

    private val online: Constraints
        get() = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /** Hourly is plenty: a change made on the phone syncs right away through requestNow. */
    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<AppsSyncWorker>(60, TimeUnit.MINUTES)
            .setConstraints(online)
            .build()
        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    fun requestNow(context: Context) {
        val request = OneTimeWorkRequestBuilder<AppsSyncWorker>()
            .setConstraints(online)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, request)
    }
}
