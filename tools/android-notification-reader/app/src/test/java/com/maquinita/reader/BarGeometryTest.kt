package com.maquinita.reader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class BarGeometryTest {

    // A 300px-wide bar at 2x density: 12dp tall view = 24px, 8dp track = 16px.
    private fun layout(fraction: Float?, expected: Float?) =
        BarGeometry.layout(widthPx = 300f, heightPx = 24f, density = 2f, fraction = fraction, expected = expected)

    @Test
    fun `the track is centred and fully rounded`() {
        val g = layout(0.5f, null)
        assertEquals(4f, g.trackTop, 0f)
        assertEquals(20f, g.trackBottom, 0f)
        assertEquals(8f, g.radius, 0f)
    }

    @Test
    fun `the fill is a share of the width`() {
        assertEquals(114f, layout(0.38f, null).fillRight, 0.01f)
        assertEquals(300f, layout(1f, null).fillRight, 0f)
    }

    @Test
    fun `a fill past the ceiling stops at the end of the bar`() {
        assertEquals(300f, layout(2.5f, null).fillRight, 0f)
    }

    @Test
    fun `the smallest visible fill is a full circle, not a smudge`() {
        assertEquals(16f, layout(0.01f, null).fillRight, 0f)
    }

    @Test
    fun `no spend, or no ceiling, means no fill`() {
        assertEquals(0f, layout(0f, null).fillRight, 0f)
        assertEquals(0f, layout(null, null).fillRight, 0f)
        assertEquals(0f, layout(-0.3f, null).fillRight, 0f)
    }

    @Test
    fun `the pace tick sits where an even pace would be`() {
        assertEquals(150f, layout(0.2f, 0.5f).tickX!!, 0.01f)
    }

    @Test
    fun `the tick is never cut off at either end`() {
        // 2dp wide at 2x density: half of it is 2px.
        assertEquals(2f, layout(0.2f, 0f).tickX!!, 0f)
        assertEquals(298f, layout(0.2f, 1f).tickX!!, 0f)
        assertEquals(298f, layout(0.2f, 7f).tickX!!, 0f)
    }

    @Test
    fun `no pace means no tick`() {
        assertNull(layout(0.2f, null).tickX)
        assertNotNull(layout(0.2f, 0.4f).tickX)
    }
}
