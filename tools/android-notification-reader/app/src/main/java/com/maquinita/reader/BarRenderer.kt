package com.maquinita.reader

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader

/**
 * Paints the budget bar as a bitmap.
 *
 * RemoteViews cannot place a marker at 38.7% of a view's width, and the tick
 * showing where an even pace would be is what makes the bar worth more than the
 * number next to it. Drawing at the widget's real pixel size keeps the rounded
 * ends round, which stretching a fixed image would not.
 */
object BarRenderer {

    private const val TRACK = 0xFF2A2A31.toInt()
    private const val DOTS = 0xFF4A4A53.toInt()
    private const val TICK = 0xF2FFFFFF.toInt()

    fun render(widthPx: Int, heightPx: Int, density: Float, style: BarStyle, color: Int): Bitmap {
        val bitmap = Bitmap.createBitmap(widthPx.coerceAtLeast(1), heightPx.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
        if (style is BarStyle.None) return bitmap // fully transparent: the view is also hidden

        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        val fraction = (style as? BarStyle.Fill)?.fraction
        val expected = (style as? BarStyle.Fill)?.expected
        val g = BarGeometry.layout(widthPx.toFloat(), heightPx.toFloat(), density, fraction, expected)

        paint.color = TRACK
        canvas.drawRoundRect(RectF(0f, g.trackTop, widthPx.toFloat(), g.trackBottom), g.radius, g.radius, paint)

        if (style is BarStyle.Hidden) {
            // Dots instead of a fill: the bar is still there, the amount is not.
            paint.color = DOTS
            val step = 10f * density
            val y = (g.trackTop + g.trackBottom) / 2f
            var x = step
            while (x < widthPx - step / 2f) {
                canvas.drawCircle(x, y, 1.5f * density, paint)
                x += step
            }
            return bitmap
        }

        if (g.fillRight > 0f) {
            // Fades in from the left, so a long fill reads as progress, not a block.
            paint.shader = LinearGradient(
                0f, 0f, g.fillRight, 0f,
                (color and 0x00FFFFFF) or 0x8C000000.toInt(), color,
                Shader.TileMode.CLAMP,
            )
            canvas.drawRoundRect(RectF(0f, g.trackTop, g.fillRight, g.trackBottom), g.radius, g.radius, paint)
            paint.shader = null
        }

        g.tickX?.let { x ->
            paint.color = TICK
            val r = g.tickHalfWidth
            canvas.drawRoundRect(RectF(x - r, 0f, x + r, heightPx.toFloat()), r, r, paint)
        }
        return bitmap
    }
}
