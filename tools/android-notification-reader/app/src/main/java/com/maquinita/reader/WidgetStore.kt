package com.maquinita.reader

import android.content.Context

/**
 * What the widget remembers between refreshes: the last summary, whether values
 * are hidden, and whether the server turned the phone down.
 *
 * The cached summary is what makes the widget instant. A tap on the eye, a
 * resize or a reboot redraw from here without waiting for the network, and a
 * phone with no signal keeps showing the last known month instead of a blank.
 * Like the ingest token it lives in this app's private storage, which is never
 * backed up (allowBackup is off in the manifest).
 */
class WidgetStore(context: Context) {

    private val prefs = context.applicationContext.getSharedPreferences("widget", Context.MODE_PRIVATE)

    /** Hiding is a per-phone choice, not something the server knows about. */
    var hidden: Boolean
        get() = prefs.getBoolean(KEY_HIDDEN, false)
        set(value) = prefs.edit().putBoolean(KEY_HIDDEN, value).apply()

    /** The phone is paired locally but the server does not accept its token. */
    val unauthorized: Boolean
        get() = prefs.getBoolean(KEY_UNAUTHORIZED, false)

    val cachedJson: String?
        get() = prefs.getString(KEY_JSON, null)

    val fetchedAt: Long
        get() = prefs.getLong(KEY_FETCHED_AT, 0L)

    fun save(json: String, at: Long) {
        prefs.edit()
            .putString(KEY_JSON, json)
            .putLong(KEY_FETCHED_AT, at)
            .putBoolean(KEY_UNAUTHORIZED, false)
            .apply()
    }

    /**
     * The server turned this phone down — revoked, or never approved. Whatever it
     * fetched before is dropped along with the right to show it: a lost phone
     * whose token was revoked must stop showing the month's spending.
     */
    fun markUnauthorized() {
        prefs.edit().remove(KEY_JSON).remove(KEY_FETCHED_AT).putBoolean(KEY_UNAUTHORIZED, true).apply()
    }

    private companion object {
        const val KEY_HIDDEN = "hidden"
        const val KEY_UNAUTHORIZED = "unauthorized"
        const val KEY_JSON = "json"
        const val KEY_FETCHED_AT = "fetched_at"
    }
}
