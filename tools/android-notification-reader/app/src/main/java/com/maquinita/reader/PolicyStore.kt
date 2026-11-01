package com.maquinita.reader

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * The phone's copy of the app list, plus the answers the user gave here that the
 * server has not confirmed yet.
 *
 * The server's list is the truth, but the phone must not wait for it: after a
 * "Sí" the very next notification from that app has to go through even when the
 * phone is offline. So an answer applies locally at once and stays pending until
 * AppsSyncWorker has posted it.
 */
class PolicyStore(context: Context) {

    data class Pending(val packageName: String, val label: String, val decision: String)

    private val prefs = context.applicationContext.getSharedPreferences("apps", Context.MODE_PRIVATE)

    /** Server list (or the defaults before the first sync) with pending answers on top. */
    fun current(): PackagePolicy {
        synchronized(LOCK) {
            var policy = prefs.getString(KEY_SERVER, null)?.let(PackagePolicy::parse) ?: PackagePolicy.DEFAULT
            for (answer in readPending().values) policy = policy.with(answer.packageName, answer.decision)
            return policy
        }
    }

    fun saveServer(policy: PackagePolicy) {
        synchronized(LOCK) {
            prefs.edit()
                .putString(KEY_SERVER, policy.toJson())
                .putLong(KEY_SYNCED_AT, System.currentTimeMillis())
                .commit()
        }
    }

    val lastSyncedAt: Long
        get() = prefs.getLong(KEY_SYNCED_AT, 0L)

    /** The user's answer, effective immediately. A later answer replaces an earlier one. */
    fun record(packageName: String, label: String, decision: String) {
        synchronized(LOCK) {
            val all = readPending().filterKeys { it != packageName }.toMutableMap()
            all[packageName] = Pending(packageName, label, decision)
            writePending(all)
        }
    }

    fun pending(): List<Pending> {
        synchronized(LOCK) {
            return readPending().values.toList()
        }
    }

    /** Only if it is still the same answer: the user may have changed their mind meanwhile. */
    fun confirm(answer: Pending) {
        synchronized(LOCK) {
            val all = readPending().toMutableMap()
            if (all[answer.packageName] == answer) {
                all.remove(answer.packageName)
                writePending(all)
            }
        }
    }

    private fun readPending(): Map<String, Pending> {
        val raw = prefs.getString(KEY_PENDING, "[]").orEmpty()
        val array = try { JSONArray(raw) } catch (_: Exception) { JSONArray() }
        return (0 until array.length()).mapNotNull { i ->
            val item = array.optJSONObject(i) ?: return@mapNotNull null
            val pkg = item.optString("packageName")
            val decision = item.optString("decision")
            if (pkg.isBlank() || decision.isBlank()) null
            else pkg to Pending(pkg, item.optString("label"), decision)
        }.toMap()
    }

    private fun writePending(all: Map<String, Pending>) {
        val array = JSONArray()
        for (p in all.values) {
            array.put(
                JSONObject().put("packageName", p.packageName).put("label", p.label).put("decision", p.decision),
            )
        }
        prefs.edit().putString(KEY_PENDING, array.toString()).commit()
    }

    private companion object {
        /**
         * One lock for every instance: the listener service, the Sí/No receiver and
         * the sync worker each make their own PolicyStore.
         */
        val LOCK = Any()
        const val KEY_SERVER = "server_policy"
        const val KEY_SYNCED_AT = "synced_at"
        const val KEY_PENDING = "pending_decisions"
    }
}
