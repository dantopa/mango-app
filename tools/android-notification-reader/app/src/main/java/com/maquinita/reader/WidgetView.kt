package com.maquinita.reader

import java.util.Locale
import java.util.TimeZone

/** The colour a state is shown in; the renderer maps it to a resource. */
enum class Tone { POSITIVE, WARNING, DANGER, NEUTRAL }

/** How the progress bar is drawn. */
sealed interface BarStyle {
    /** No budget ceiling, so there is nothing to measure against. */
    data object None : BarStyle

    /** Values are hidden: an empty track, so the bar does not give the amount away. */
    data object Hidden : BarStyle

    /** [fraction] of the ceiling spent, with a tick where an even pace would be. */
    data class Fill(val fraction: Float, val expected: Float?) : BarStyle
}

/**
 * Every string and decision the widget shows, with no Android in it — so what the
 * widget says, and above all what it refuses to say when values are hidden, is
 * covered by plain unit tests instead of being checked by eye on a phone.
 */
data class WidgetView(
    val tone: Tone,
    val title: String,
    val subtitle: String,
    val updated: String,
    val updatedStale: Boolean,
    val spent: String,
    val ofCeiling: String,
    val pct: String,
    val bar: BarStyle,
    val dailyLabel: String,
    val dailyValue: String,
    val lastLabel: String,
    /** Separate from the amount: a long name is cut, the amount never is. */
    val lastMerchant: String,
    val lastAmount: String,
    /** One-line version for when the widget is too short to show the label. */
    val dailyCompact: String,
    val hidden: Boolean,
    /** What TalkBack reads. Hidden values must not be read aloud either. */
    val description: String,
)

object WidgetPresenter {

    fun present(
        data: WidgetData,
        hidden: Boolean,
        fetchedAt: Long,
        now: Long,
        zone: TimeZone = TimeZone.getDefault(),
    ): WidgetView {
        val tone = when (data.state) {
            BudgetState.VERDE -> Tone.POSITIVE
            BudgetState.AMARILLO -> Tone.WARNING
            BudgetState.ROJO -> Tone.DANGER
            null -> Tone.NEUTRAL
        }
        val ceiling = data.ceilingUsd
        val over = ceiling != null && data.spentUsd >= ceiling
        val updated = WidgetFormat.updated(fetchedAt, now, zone)

        fun money(value: Double, decimals: Boolean = false) =
            if (hidden) "US$ ${WidgetFormat.MASK}" else WidgetFormat.usd(value, decimals)

        val spent = money(data.spentUsd)
        val ofCeiling = if (ceiling == null) "este mes" else "de ${money(ceiling)}"
        val pct = when {
            data.pct == null -> ""
            hidden -> "••%"
            else -> WidgetFormat.percent(data.pct)
        }

        val bar = when {
            ceiling == null || data.pct == null -> BarStyle.None
            hidden -> BarStyle.Hidden
            else -> BarStyle.Fill(
                fraction = data.pct.toFloat().coerceIn(0f, 1f),
                expected = data.expectedPct?.toFloat()?.coerceIn(0f, 1f),
            )
        }

        val (dailyLabel, dailyValue) = when {
            ceiling == null -> "TECHO" to "Sin configurar"
            over -> "SOBRE EL TECHO" to "+${money(data.spentUsd - ceiling)}"
            else -> "HOY PODÉS GASTAR" to money(data.dailyAvailableUsd ?: 0.0)
        }

        val last = data.last
        val lastMerchant = when {
            last == null -> "—"
            hidden -> "••••••"
            else -> last.merchant ?: "Gasto"
        }
        val lastAmount = if (last == null) "" else money(last.amountUsd, last.amountUsd < 100)
        val lastLabel = when {
            last == null -> "ÚLTIMO GASTO"
            last.whenLabel.isBlank() -> "ÚLTIMO"
            else -> "ÚLTIMO · ${last.whenLabel.uppercase(Locale("es"))}"
        }

        val description = if (hidden) {
            "${data.monthLabel}. Valores ocultos."
        } else buildString {
            append("${data.monthLabel}. Gastaste $spent")
            if (ceiling != null) append(" de ${money(ceiling)}, $pct")
            // Sentence case for the label only: lowercasing the whole line would turn "US$" into "us$".
            val label = dailyLabel.lowercase(Locale("es")).replaceFirstChar { it.uppercase() }
            append(". $label: $dailyValue.")
        }

        return WidgetView(
            tone = tone,
            title = data.monthLabel,
            subtitle = "día ${data.day} de ${data.daysInMonth}",
            updated = updated.label,
            updatedStale = updated.stale,
            spent = spent,
            ofCeiling = ofCeiling,
            pct = pct,
            bar = bar,
            dailyLabel = dailyLabel,
            dailyValue = dailyValue,
            lastLabel = lastLabel,
            lastMerchant = lastMerchant,
            lastAmount = lastAmount,
            dailyCompact = if (ceiling == null) "Sin techo" else "${if (over) "Sobre" else "Hoy"} $dailyValue",
            hidden = hidden,
            description = description,
        )
    }
}
