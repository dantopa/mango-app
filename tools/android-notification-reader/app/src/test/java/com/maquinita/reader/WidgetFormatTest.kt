package com.maquinita.reader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.util.TimeZone

class WidgetFormatTest {

    private val bogota = TimeZone.getTimeZone("America/Bogota")

    @Test
    fun `money uses es-AR separators like the app`() {
        assertEquals("US$ 1.184", WidgetFormat.usd(1184.0))
        assertEquals("US$ 1.234.567", WidgetFormat.usd(1_234_567.0))
        assertEquals("US$ 12,40", WidgetFormat.usd(12.4, decimals = true))
        assertEquals("US$ 0", WidgetFormat.usd(0.0))
    }

    @Test
    fun `money rounds half up, not to even`() {
        assertEquals("US$ 96", WidgetFormat.usd(95.8))
        assertEquals("US$ 3", WidgetFormat.usd(2.5))
        assertEquals("US$ 1", WidgetFormat.usd(0.5))
        assertEquals("US$ 0,13", WidgetFormat.usd(0.125, decimals = true))
    }

    @Test
    fun `percent is a whole number`() {
        assertEquals("38%", WidgetFormat.percent(0.3819))
        assertEquals("120%", WidgetFormat.percent(1.2))
        assertEquals("0%", WidgetFormat.percent(0.0))
    }

    @Test
    fun `a fresh refresh shows the clock in the given zone`() {
        val fetched = Instant.parse("2026-10-12T19:35:00Z").toEpochMilli()
        val updated = WidgetFormat.updated(fetched, fetched + 10 * 60_000, bogota)
        assertEquals("14:35", updated.label)
        assertFalse(updated.stale)
    }

    @Test
    fun `an old refresh says how old, as a warning`() {
        val fetched = Instant.parse("2026-10-12T19:35:00Z").toEpochMilli()
        val hour = 3_600_000L

        assertFalse(WidgetFormat.updated(fetched, fetched + 2 * hour - 1, bogota).stale)
        assertEquals(WidgetFormat.Updated("hace 2 h", true), WidgetFormat.updated(fetched, fetched + 2 * hour, bogota))
        assertEquals("hace 47 h", WidgetFormat.updated(fetched, fetched + 47 * hour, bogota).label)
        assertEquals("hace 2 d", WidgetFormat.updated(fetched, fetched + 49 * hour, bogota).label)
    }

    @Test
    fun `a clock running behind the server does not make the data look stale`() {
        val fetched = Instant.parse("2026-10-12T19:35:00Z").toEpochMilli()
        val updated = WidgetFormat.updated(fetched, fetched - 5 * 60_000, bogota)
        assertTrue(updated.label.matches(Regex("\\d\\d:\\d\\d")))
        assertFalse(updated.stale)
    }
}
