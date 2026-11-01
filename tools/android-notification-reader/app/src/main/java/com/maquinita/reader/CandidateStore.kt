package com.maquinita.reader

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Notifications from apps the user has not decided about yet, kept on the phone.
 *
 * This is what makes "¿Registrar los pagos de esta app?" lossless: the payment
 * that triggered the question is held here, and a "Sí" sends it along with the
 * app's future ones. A "No", or a week without an answer, deletes it. Nothing in
 * here has left the phone.
 */
class CandidateStore(context: Context) {

    data class Candidate(val packageName: String, val label: String, val items: List<String>)

    private val prefs = context.applicationContext.getSharedPreferences("candidates", Context.MODE_PRIVATE)

    /** Holds one payload; returns how many this app has waiting now. */
    fun hold(packageName: String, label: String, payload: String, now: Long = System.currentTimeMillis()): Int {
        synchronized(LOCK) {
            val all = read(now).toMutableMap()
            val previous = all[packageName]
            val items = ((previous?.items ?: emptyList()) + Item(payload, now)).takeLast(MAX_ITEMS_PER_APP)
            all[packageName] = Entry(label, items)

            // Bounded: an app nobody ever answers about must not grow this forever.
            while (all.size > MAX_APPS) {
                val oldest = all.minByOrNull { (_, e) -> e.items.minOf { it.at } }?.key ?: break
                all.remove(oldest)
            }
            write(all)
            return items.size
        }
    }

    /** Removes and returns what an app had waiting. */
    fun take(packageName: String): List<String> {
        synchronized(LOCK) {
            val all = read(System.currentTimeMillis()).toMutableMap()
            val entry = all.remove(packageName) ?: return emptyList()
            write(all)
            return entry.items.map { it.payload }
        }
    }

    fun drop(packageName: String) {
        take(packageName)
    }

    fun all(): List<Candidate> {
        synchronized(LOCK) {
            return read(System.currentTimeMillis()).map { (pkg, e) -> Candidate(pkg, e.label, e.items.map { it.payload }) }
        }
    }

    private data class Item(val payload: String, val at: Long)
    private data class Entry(val label: String, val items: List<Item>)

    /** Expired items are dropped on every read, so nothing outlives MAX_AGE_MS. */
    private fun read(now: Long): Map<String, Entry> {
        val raw = prefs.getString(KEY, "{}").orEmpty()
        val root = try { JSONObject(raw) } catch (_: Exception) { JSONObject() }
        val result = mutableMapOf<String, Entry>()
        for (pkg in root.keys()) {
            val obj = root.optJSONObject(pkg) ?: continue
            val array = obj.optJSONArray("items") ?: JSONArray()
            val items = (0 until array.length()).mapNotNull { i ->
                val item = array.optJSONObject(i) ?: return@mapNotNull null
                val at = item.optLong("at")
                if (now - at > MAX_AGE_MS) null else Item(item.optString("payload"), at)
            }
            if (items.isNotEmpty()) result[pkg] = Entry(obj.optString("label"), items)
        }
        return result
    }

    private fun write(all: Map<String, Entry>) {
        val root = JSONObject()
        for ((pkg, entry) in all) {
            val items = JSONArray()
            entry.items.forEach { items.put(JSONObject().put("payload", it.payload).put("at", it.at)) }
            root.put(pkg, JSONObject().put("label", entry.label).put("items", items))
        }
        prefs.edit().putString(KEY, root.toString()).commit()
    }

    private companion object {
        /**
         * One lock for every instance: the listener service, the Sí/No receiver and
         * the sync worker each make their own CandidateStore.
         */
        val LOCK = Any()
        const val KEY = "held"
        const val MAX_ITEMS_PER_APP = 20
        const val MAX_APPS = 15
        const val MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000
    }
}
