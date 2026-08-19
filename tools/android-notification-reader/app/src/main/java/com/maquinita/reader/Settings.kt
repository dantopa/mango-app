package com.maquinita.reader

import android.content.Context

/**
 * Where to post and what to post it with.
 *
 * Neither is typed by hand any more. The endpoint is derived from the site the
 * TWA opens — there is only ever one server — and the token is generated on the
 * phone during pairing. So this holds a secret that exists nowhere else: it is
 * never backed up (see allowBackup in the manifest) and cannot be recovered from
 * the server, only replaced by pairing again.
 */
class Settings(context: Context) {

    private val app = context.applicationContext
    private val prefs = app.getSharedPreferences("config", Context.MODE_PRIVATE)

    /** https by construction: twa_url is the origin the Digital Asset Links verify. */
    val endpoint: String
        get() = app.getString(R.string.twa_url) + INGEST_PATH

    var token: String
        get() = prefs.getString(KEY_TOKEN, "").orEmpty()
        set(value) {
            prefs.edit().putString(KEY_TOKEN, value.trim()).commit()
        }

    val lastResult: String
        get() = prefs.getString(KEY_LAST_RESULT, "").orEmpty()

    val lastResultAt: Long
        get() = prefs.getLong(KEY_LAST_RESULT_AT, 0L)

    fun recordResult(result: String) {
        prefs.edit()
            .putString(KEY_LAST_RESULT, result)
            .putLong(KEY_LAST_RESULT_AT, System.currentTimeMillis())
            .commit()
    }

    /**
     * Having a token is not proof it was approved — pairing needs a second step in
     * the browser — so this only means there is something to send.
     */
    val isConfigured: Boolean
        get() = token.isNotEmpty()

    private companion object {
        const val INGEST_PATH = "/api/push-ingest"
        const val KEY_TOKEN = "token"
        const val KEY_LAST_RESULT = "last_result"
        const val KEY_LAST_RESULT_AT = "last_result_at"
    }
}
