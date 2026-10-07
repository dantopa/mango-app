package com.maquinita.reader

import kotlin.math.max
import kotlin.math.min

/**
 * Where everything in the progress bar goes, in pixels. Pure arithmetic, apart
 * from [BarRenderer] which only paints what this says.
 */
object BarGeometry {

    /** Track thickness. The view is taller so the pace tick can stick out of it. */
    const val TRACK_DP = 8f

    const val TICK_WIDTH_DP = 2f

    data class Layout(
        val trackTop: Float,
        val trackBottom: Float,
        val radius: Float,
        /** Right edge of the fill; 0 when there is none. */
        val fillRight: Float,
        /** Centre of the pace tick, or null when there is no pace to show. */
        val tickX: Float?,
        val tickHalfWidth: Float,
    )

    fun layout(widthPx: Float, heightPx: Float, density: Float, fraction: Float?, expected: Float?): Layout {
        val track = TRACK_DP * density
        val top = (heightPx - track) / 2f
        val tickHalf = TICK_WIDTH_DP * density / 2f

        // A fill thinner than the track is taller than it is wide, which reads as
        // a smudge: the smallest visible fill is a full circle.
        val fill = when {
            fraction == null || fraction <= 0f -> 0f
            else -> min(widthPx, max(fraction.coerceAtMost(1f) * widthPx, track))
        }

        return Layout(
            trackTop = top,
            trackBottom = top + track,
            radius = track / 2f,
            fillRight = fill,
            // Kept inside the bar so the tick is never half cut off at either end.
            tickX = expected?.let { (it.coerceIn(0f, 1f) * widthPx).coerceIn(tickHalf, widthPx - tickHalf) },
            tickHalfWidth = tickHalf,
        )
    }
}
