package com.maquinita.reader

import org.json.JSONException
import org.json.JSONObject

/** The budget semaphore the app and the push alerts use. */
enum class BudgetState { VERDE, AMARILLO, ROJO }

/** The last counted purchase, as much as /api/widget says about it. */
data class WidgetLast(val merchant: String?, val amountUsd: Double, val whenLabel: String)

/**
 * What GET /api/widget answers: the month so far and nothing else.
 *
 * Parsed defensively. The same text is also what gets cached on the phone, so a
 * truncated write or a server that changes shape must come out as "no data",
 * never as a half-filled widget showing a wrong number.
 */
data class WidgetData(
    val monthLabel: String,
    val day: Int,
    val daysInMonth: Int,
    val spentUsd: Double,
    val ceilingUsd: Double?,
    val state: BudgetState?,
    val pct: Double?,
    val expectedPct: Double?,
    val dailyAvailableUsd: Double?,
    val last: WidgetLast?,
) {
    companion object {
        fun parse(json: String): WidgetData? = try {
            val o = JSONObject(json)
            val day = o.getInt("day")
            val daysInMonth = o.getInt("days_in_month")
            val spent = o.getDouble("spent_usd")
            val valid = day in 1..31 && daysInMonth in 28..31 && day <= daysInMonth &&
                spent.isFinite() && spent >= 0
            if (!valid) null else WidgetData(
                monthLabel = o.getString("month_label"),
                day = day,
                daysInMonth = daysInMonth,
                spentUsd = spent,
                ceilingUsd = o.number("ceiling_usd"),
                state = when (o.optString("state")) {
                    "verde" -> BudgetState.VERDE
                    "amarillo" -> BudgetState.AMARILLO
                    "rojo" -> BudgetState.ROJO
                    else -> null
                },
                pct = o.number("pct"),
                expectedPct = o.number("expected_pct"),
                dailyAvailableUsd = o.number("daily_available_usd"),
                last = o.optJSONObject("last")?.let { last ->
                    WidgetLast(
                        merchant = if (last.isNull("merchant")) null else last.optString("merchant").ifBlank { null },
                        amountUsd = last.getDouble("amount_usd"),
                        whenLabel = last.optString("when_label"),
                    )
                },
            )
        } catch (_: JSONException) {
            null
        }

        /** A number that may be absent or null, but never NaN. */
        private fun JSONObject.number(name: String): Double? =
            if (isNull(name)) null else optDouble(name).takeIf { it.isFinite() }
    }
}
