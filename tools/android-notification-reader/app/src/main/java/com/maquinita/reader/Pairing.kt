package com.maquinita.reader

import android.content.Context
import android.net.Uri
import android.os.Build
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Pairing: how the phone gets an ingest token without anyone typing one.
 *
 * The phone generates the token and a one-time code, and enrols by sending only
 * their SHA-256 digests. That row authenticates nothing yet. Then the browser —
 * where the session already lives — opens the pairing URL with the code in the
 * fragment and approves it, which is what binds the token to the account.
 *
 * The point of doing it in this order: the token itself never crosses the network
 * except as a bearer header, and the code, which does travel, is single-use and
 * worthless without the token it approves.
 */
object Pairing {

    /**
     * Enrols the device and returns the URL the browser has to open.
     *
     * Blocking: call it off the main thread. Throws IOException when the server
     * cannot be reached, which the caller surfaces instead of retrying — pairing
     * is interactive, so there is a person right there to press the button again.
     */
    @Throws(IOException::class)
    fun enroll(context: Context, settings: Settings): Uri {
        val token = settings.token.ifEmpty { randomHex().also { settings.token = it } }
        val code = randomHex()

        val body = JSONObject()
            .put("token_hash", sha256Hex(token))
            .put("pairing_code_hash", sha256Hex(code))
            .put("label", "${Build.MANUFACTURER} ${Build.MODEL}")

        val site = context.getString(R.string.twa_url)
        val status = post(URL(site + ENROLL_PATH), body.toString())
        if (status !in 200..299) throw IOException("HTTP $status")

        // Fragment, not query: it is never sent to the server, so the code cannot
        // end up in an access log or a referrer. The page reads it and posts it back
        // over the authenticated session.
        return Uri.parse("$site$PAIR_PATH#$code")
    }

    private fun post(url: URL, body: String): Int {
        var connection: HttpURLConnection? = null
        return try {
            connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10_000
                readTimeout = 15_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
            connection.outputStream.use { it.write(body.toByteArray()) }
            connection.responseCode
        } finally {
            connection?.disconnect()
        }
    }

    /** 32 bytes: the token is a bearer credential, so guessing has to be hopeless. */
    private fun randomHex(): String {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        return bytes.toHex()
    }

    private fun sha256Hex(value: String): String =
        MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).toHex()

    private fun ByteArray.toHex(): String =
        joinToString("") { "%02x".format(it) }

    private const val ENROLL_PATH = "/api/push-ingest/devices/enroll"
    private const val PAIR_PATH = "/pair"
}
