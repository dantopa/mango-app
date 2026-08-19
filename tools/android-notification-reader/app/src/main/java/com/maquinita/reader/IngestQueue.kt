package com.maquinita.reader

import android.content.Context
import org.json.JSONArray
import org.json.JSONException

/**
 * FIFO queue of pending payloads, persisted before any upload is attempted.
 *
 * A purchase notification often arrives with the phone offline or the server
 * restarting, and Android never redelivers it: a dropped notification is an
 * expense that no longer exists anywhere. So the service only writes here, and
 * uploading is the worker's problem.
 */
object IngestQueue {

    /** Bounded so a long outage cannot grow the preferences file without limit. */
    private const val MAX_ITEMS = 500

    @Synchronized
    fun add(context: Context, payload: String) {
        val items = read(context)
        items.add(payload)
        // Oldest first: a notification from two weeks ago is the least useful one.
        while (items.size > MAX_ITEMS) items.removeAt(0)
        write(context, items)
    }

    @Synchronized
    fun peek(context: Context): String? = read(context).firstOrNull()

    @Synchronized
    fun removeFirst(context: Context) {
        val items = read(context)
        if (items.isEmpty()) return
        items.removeAt(0)
        write(context, items)
    }

    @Synchronized
    fun size(context: Context): Int = read(context).size

    private fun read(context: Context): MutableList<String> {
        val raw = prefs(context).getString(KEY, "[]").orEmpty()
        val array = try {
            JSONArray(raw)
        } catch (_: JSONException) {
            JSONArray()
        }
        return MutableList(array.length()) { array.getString(it) }
    }

    /** commit(), not apply(): the queue has to survive the process dying right after. */
    private fun write(context: Context, items: List<String>) {
        prefs(context).edit().putString(KEY, JSONArray(items).toString()).commit()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences("queue", Context.MODE_PRIVATE)

    private const val KEY = "pending"
}
