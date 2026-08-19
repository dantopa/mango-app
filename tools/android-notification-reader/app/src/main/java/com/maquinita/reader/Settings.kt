package com.maquinita.reader

import android.content.Context

/**
 * Endpoint and bearer token, typed once in the app and kept on the device. The
 * token is the same PUSH_INGEST_SECRET the server checks, so it is never written
 * into the repo and never backed up (see allowBackup in the manifest).
 */
class Settings(context: Context) {

    private val prefs = context.getSharedPreferences("config", Context.MODE_PRIVATE)

    var endpoint: String
        get() = prefs.getString(KEY_ENDPOINT, "").orEmpty()
        set(value) {
            prefs.edit().putString(KEY_ENDPOINT, value.trim()).commit()
        }

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

    /** https only: a plaintext endpoint would put the bearer token on the wire. */
    val isConfigured: Boolean
        get() = endpoint.startsWith("https://") && token.isNotEmpty()

    private companion object {
        const val KEY_ENDPOINT = "endpoint"
        const val KEY_TOKEN = "token"
        const val KEY_LAST_RESULT = "last_result"
        const val KEY_LAST_RESULT_AT = "last_result_at"
    }
}
