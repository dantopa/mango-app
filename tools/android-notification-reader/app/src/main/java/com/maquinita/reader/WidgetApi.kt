package com.maquinita.reader

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** GET /api/widget with the phone's own token. */
object WidgetApi {

    sealed interface Result {
        /** A summary that parsed; [body] is the raw text, which is what gets cached. */
        data class Ok(val body: String, val data: WidgetData) : Result

        /** The token is unknown, revoked or never approved. */
        data object Unauthorized : Result

        /** Offline, a server error, or an answer that is not a summary. */
        data class Failed(val reason: String) : Result
    }

    /** A summary is a few hundred bytes; anything much larger is not one. */
    private const val MAX_BODY_BYTES = 16 * 1024

    fun fetch(settings: Settings): Result {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(settings.widgetEndpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 10_000
                readTimeout = 15_000
                setRequestProperty("Authorization", "Bearer ${settings.token}")
                setRequestProperty("Accept", "application/json")
            }
            when (val code = connection.responseCode) {
                200 -> {
                    val body = connection.inputStream.use { it.readNBytesCapped(MAX_BODY_BYTES) }
                    WidgetData.parse(body)?.let { Result.Ok(body, it) } ?: Result.Failed("respuesta inválida")
                }
                401 -> Result.Unauthorized
                else -> Result.Failed("HTTP $code")
            }
        } catch (err: IOException) {
            Result.Failed(err.message ?: "sin conexión")
        } finally {
            connection?.disconnect()
        }
    }

    private fun java.io.InputStream.readNBytesCapped(max: Int): String {
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(2048)
        while (true) {
            val read = read(buffer)
            if (read < 0) break
            out.write(buffer, 0, read)
            if (out.size() > max) throw IOException("respuesta demasiado grande")
        }
        return out.toString(Charsets.UTF_8.name())
    }
}
