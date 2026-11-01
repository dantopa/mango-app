package com.maquinita.reader

import org.json.JSONArray
import org.json.JSONObject

/**
 * Decides what happens to a notification, from the app that posted it and what it
 * says. No Android in here on purpose: it is the whole privacy story of the reader,
 * so it is checked by plain unit tests.
 *
 * - FORWARD: an app on the user's list. Goes to the ingest queue.
 * - CANDIDATE: an app nobody decided about yet whose notification looks like money
 *   moving. It is held on the phone and the user is asked; nothing is uploaded
 *   until they say yes.
 * - IGNORE: everything else. Never stored, never sent.
 *
 * The list comes from GET /api/push-ingest/apps (see PolicyStore), so a new bank
 * is a row on the server, not a new APK. DEFAULT_ALLOWED is only what the phone
 * uses before its first sync.
 */
class PackagePolicy(
    val allowed: Set<String>,
    val blocked: Set<String>,
) {

    enum class Verdict { FORWARD, CANDIDATE, IGNORE }

    fun decide(packageName: String, title: String, text: String): Verdict {
        if (packageName in NEVER_ALLOWED || packageName in SYSTEM_PACKAGES) return Verdict.IGNORE
        if (packageName == OWN_PACKAGE) return Verdict.IGNORE
        if (packageName in blocked) return Verdict.IGNORE

        if (packageName in allowed) {
            // An SMS app carries everything: personal messages and one-time codes as
            // well as bank alerts. The package alone is not a good enough filter, so
            // its content has to earn the upload.
            if (packageName in SMS_PACKAGES && !isFinancialSms(title, text)) return Verdict.IGNORE
            return Verdict.FORWARD
        }

        // A messaging app the user never approved is never a candidate: its content
        // is people, and the SMS path above is the only way bank texts get in.
        if (packageName in SMS_PACKAGES) return Verdict.IGNORE

        return if (looksLikeMoneyMoving(title, text)) Verdict.CANDIDATE else Verdict.IGNORE
    }

    fun toJson(): String = JSONObject()
        .put("allowed", JSONArray(allowed.sorted()))
        .put("blocked", JSONArray(blocked.sorted()))
        .toString()

    /** A copy with one more decision on top, for answers not yet synced. */
    fun with(packageName: String, decision: String): PackagePolicy = when (decision) {
        ALLOWED -> PackagePolicy(allowed + packageName, blocked - packageName)
        BLOCKED -> PackagePolicy(allowed - packageName, blocked + packageName)
        else -> this
    }

    companion object {
        const val ALLOWED = "allowed"
        const val BLOCKED = "blocked"

        private const val OWN_PACKAGE = "com.maquinita.reader"

        /** What the phone listens to before it ever reached the server. */
        val DEFAULT_ALLOWED = setOf(
            "com.todo1.mobile",                     // Bancolombia
            "com.bbva.nxt_argentina",               // BBVA Argentina
            "com.nequi.MobileApp",                  // Nequi
            "com.brubank",                          // Brubank
            "com.grability.rappi",                  // Rappi / RappiCard
            "com.google.android.apps.walletnfcrel", // Google Wallet
            "com.nexowallet",                       // Nexo
            "com.google.android.apps.messaging",    // Google Messages
            "com.samsung.android.messaging",        // Samsung Messages
            "com.android.mms",                      // AOSP SMS
        )

        val DEFAULT = PackagePolicy(DEFAULT_ALLOWED, emptySet())

        /**
         * People talking, not money moving. Never forwarded and never a candidate,
         * whatever the server list says. Same list as NEVER_ALLOWED in
         * src/lib/push-ingest/package-policy.ts.
         */
        val NEVER_ALLOWED = setOf(
            "com.whatsapp",
            "com.whatsapp.w4b",
            "org.telegram.messenger",
            "org.thoughtcrime.securesms",
            "com.facebook.orca",
            "com.instagram.android",
            "com.discord",
            "com.slack",
            "com.google.android.gm",
            "com.microsoft.office.outlook",
            "com.google.android.apps.dynamite",
            "com.microsoft.teams",
            "com.snapchat.android",
            "com.twitter.android",
            "com.zhiliaoapp.musically",
        )

        /** The OS itself: battery, downloads, USB… never a bank. */
        private val SYSTEM_PACKAGES = setOf(
            "android",
            "com.android.systemui",
            "com.android.providers.downloads",
            "com.google.android.gms",
            "com.android.vending",
        )

        val SMS_PACKAGES = setOf(
            "com.google.android.apps.messaging",
            "com.samsung.android.messaging",
            "com.android.mms",
        )

        // Nexo and other foreign services write in English, so both languages are
        // matched. A brand name alone counts as a signal for SMS, which is why the
        // one-time code list below has to cover both languages too.
        private val FINANCIAL_SIGNAL = Regex(
            "bancolombia|nequi|bbva|brubank|rappi|nexo|davivienda|" +
                "compra|transacci[oó]n|d[eé]bito|cr[eé]dito|retiro|pago|transferencia|consumo|" +
                "purchase|transaction|debit|credit card|withdraw|payment|transfer|charged",
            RegexOption.IGNORE_CASE,
        )

        /**
         * Words that describe money that moved, without brand names: a candidate
         * has to say what happened, not just who it is from.
         */
        private val MONEY_VERB = Regex(
            "\\b(?:pagaste|pag[oó]|compraste|compra|consumo|d[eé]bito|debitamos|cargo|" +
                "transferiste|transferencia|enviaste|retiraste|retiro|cobro|cobramos|" +
                "aprobad[ao]|rechazad[ao]|" +
                "paid|purchase|spent|charged|payment|debited|withdrawal|transfer(?:red)?|declined)\\b",
            RegexOption.IGNORE_CASE,
        )

        /** An amount with a currency next to it: "$ 35.350", "US$100", "100,00 USD", "€12". */
        private val AMOUNT = Regex(
            "(?:US\\$|U\\\$S|R\\$|\\$|€|£|\\b(?:USD|COP|ARS|EUR|MXN|BRL|CLP|PEN|UYU|USDT)\\b)\\s?\\d[\\d.,]*" +
                "|\\d[\\d.,]*\\s?(?:US\\$|€|\\b(?:USD|COP|ARS|EUR|MXN|BRL|CLP|PEN|UYU|USDT)\\b)",
            RegexOption.IGNORE_CASE,
        )

        private val ONE_TIME_CODE = Regex(
            "c[oó]digo|clave (?:temporal|din[aá]mica|segura)|token|\\botp\\b|" +
                "verificaci[oó]n|no la compartas|no lo compartas|" +
                "\\bcode\\b|verification|passcode|one[- ]time|do(?:n't| not) share",
            RegexOption.IGNORE_CASE,
        )

        /**
         * The sender is as good a signal as the body — bank alerts arrive from a
         * short code or a brand name — so both are matched. A one-time code is
         * dropped even when it names the bank: it never describes an expense, and
         * it is the most sensitive text on the phone.
         */
        fun isFinancialSms(title: String, text: String): Boolean {
            val message = "$title $text"
            return FINANCIAL_SIGNAL.containsMatchIn(message) && !ONE_TIME_CODE.containsMatchIn(message)
        }

        /**
         * Worth asking about: an amount, a verb saying it moved, and no one-time
         * code. A promo ("hasta 50% OFF") has no currency amount; a login alert has
         * no amount at all; "Tu pedido llegó" has neither.
         */
        fun looksLikeMoneyMoving(title: String, text: String): Boolean {
            val message = "$title $text"
            return AMOUNT.containsMatchIn(message) &&
                MONEY_VERB.containsMatchIn(message) &&
                !ONE_TIME_CODE.containsMatchIn(message)
        }

        /** The server's answer, or null when it is not one. */
        fun parse(json: String): PackagePolicy? = try {
            val root = JSONObject(json)
            val allowed = root.getJSONArray("allowed").toStringSet()
            val blocked = root.optJSONArray("blocked")?.toStringSet() ?: emptySet()
            PackagePolicy(allowed, blocked)
        } catch (_: Exception) {
            null
        }

        private fun JSONArray.toStringSet(): Set<String> =
            (0 until length()).mapNotNull { optString(it).takeIf(String::isNotBlank) }.toSet()

        /**
         * "com.mercadopago.wallet" → "Mercadopago". Only for when the system will
         * not tell us the app's real name (package visibility hides most apps).
         */
        fun fallbackLabel(packageName: String): String {
            val generic = setOf("com", "org", "net", "ar", "co", "br", "mx", "app", "android", "mobile", "wallet", "bank")
            val part = packageName.split('.').firstOrNull { it.length > 2 && it.lowercase() !in generic }
                ?: packageName.substringAfterLast('.')
            return part.replaceFirstChar { it.uppercase() }
        }
    }
}
