package com.maquinita.reader

import java.math.RoundingMode
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import kotlin.math.roundToInt

/** Number and time formatting for the widget, in the same es-AR style as the app. */
object WidgetFormat {

    /** What replaces a figure when values are hidden. */
    const val MASK = "••••"

    /** Past this age the "updated" time is shown as a warning, not as a clock. */
    private const val STALE_AFTER_MS = 2 * 60 * 60 * 1000L

    private const val HOUR_MS = 60 * 60 * 1000L

    private val ES_AR = Locale("es", "AR")

    /** "US$ 1.184", or "US$ 12,40" when [decimals] — es-AR separators like the app. */
    fun usd(value: Double, decimals: Boolean = false): String {
        val pattern = if (decimals) "#,##0.00" else "#,##0"
        // DecimalFormat is not thread-safe, and WorkManager and the main thread both render.
        val format = DecimalFormat(pattern, DecimalFormatSymbols(ES_AR))
        // The default is banker's rounding (2.5 -> 2), which is not what anyone expects of money.
        format.roundingMode = RoundingMode.HALF_UP
        val text = format.format(value)
        return "US$ $text"
    }

    /** 0.382 -> "38%". */
    fun percent(fraction: Double): String = "${(fraction * 100).roundToInt()}%"

    /** The clock time of the last refresh, or how long ago once it is stale. */
    data class Updated(val label: String, val stale: Boolean)

    fun updated(fetchedAt: Long, now: Long, zone: TimeZone = TimeZone.getDefault()): Updated {
        val age = (now - fetchedAt).coerceAtLeast(0)
        if (age < STALE_AFTER_MS) {
            val clock = SimpleDateFormat("HH:mm", Locale.US).apply { timeZone = zone }
            return Updated(clock.format(fetchedAt), stale = false)
        }
        val hours = age / HOUR_MS
        return Updated(if (hours < 48) "hace $hours h" else "hace ${hours / 24} d", stale = true)
    }
}
