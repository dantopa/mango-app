package com.maquinita.reader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.util.TimeZone

class WidgetPresenterTest {

    private val bogota = TimeZone.getTimeZone("America/Bogota")
    private val fetchedAt = Instant.parse("2026-10-12T19:35:00Z").toEpochMilli()
    private val now = fetchedAt + 60_000

    private val data = WidgetData(
        monthLabel = "Octubre",
        day = 12,
        daysInMonth = 31,
        spentUsd = 1184.0,
        ceilingUsd = 3100.0,
        state = BudgetState.VERDE,
        pct = 1184.0 / 3100.0,
        expectedPct = 12.0 / 31.0,
        dailyAvailableUsd = 95.8,
        last = WidgetLast("RAPPI", 12.4, "hoy 14:32"),
    )

    private fun present(d: WidgetData = data, hidden: Boolean = false, at: Long = fetchedAt) =
        WidgetPresenter.present(d, hidden, at, now, bogota)

    @Test
    fun `shows the month against the ceiling`() {
        val v = present()
        assertEquals(Tone.POSITIVE, v.tone)
        assertEquals("Octubre", v.title)
        assertEquals("día 12 de 31", v.subtitle)
        assertEquals("US$ 1.184", v.spent)
        assertEquals("de US$ 3.100", v.ofCeiling)
        assertEquals("38%", v.pct)
        assertEquals("14:35", v.updated)
        assertFalse(v.hidden)
    }

    @Test
    fun `the bar carries the spend and the pace tick`() {
        val bar = present().bar as BarStyle.Fill
        assertEquals(0.382f, bar.fraction, 0.001f)
        assertEquals(0.387f, bar.expected!!, 0.001f)
    }

    @Test
    fun `shows the daily allowance and the last purchase`() {
        val v = present()
        assertEquals("HOY PODÉS GASTAR", v.dailyLabel)
        assertEquals("US$ 96", v.dailyValue)
        assertEquals("ÚLTIMO · HOY 14:32", v.lastLabel)
        assertEquals("RAPPI", v.lastMerchant)
        assertEquals("US$ 12,40", v.lastAmount)
        assertEquals("Hoy US$ 96", v.dailyCompact)
    }

    @Test
    fun `colours follow the semaphore`() {
        assertEquals(Tone.WARNING, present(data.copy(state = BudgetState.AMARILLO)).tone)
        assertEquals(Tone.DANGER, present(data.copy(state = BudgetState.ROJO)).tone)
        assertEquals(Tone.NEUTRAL, present(data.copy(state = null)).tone)
    }

    @Test
    fun `past the ceiling it says by how much instead of a zero allowance`() {
        val over = data.copy(spentUsd = 3220.0, state = BudgetState.ROJO, pct = 3220.0 / 3100.0, dailyAvailableUsd = 0.0)
        val v = present(over)
        assertEquals("SOBRE EL TECHO", v.dailyLabel)
        assertEquals("+US$ 120", v.dailyValue)
        assertEquals("Sobre +US$ 120", v.dailyCompact)
        assertEquals("104%", v.pct)
        assertEquals(1f, (v.bar as BarStyle.Fill).fraction, 0f)
    }

    @Test
    fun `without a ceiling there is no bar and no allowance`() {
        val v = present(data.copy(ceilingUsd = null, state = null, pct = null, expectedPct = null, dailyAvailableUsd = null))
        assertEquals(BarStyle.None, v.bar)
        assertEquals("este mes", v.ofCeiling)
        assertEquals("", v.pct)
        assertEquals("TECHO", v.dailyLabel)
        assertEquals("Sin configurar", v.dailyValue)
        assertEquals("Sin techo", v.dailyCompact)
        assertEquals("US$ 1.184", v.spent)
    }

    @Test
    fun `no purchases yet, or one without a name`() {
        val none = present(data.copy(last = null))
        assertEquals("ÚLTIMO GASTO", none.lastLabel)
        assertEquals("—", none.lastMerchant)
        assertEquals("", none.lastAmount)

        val unnamed = present(data.copy(last = WidgetLast(null, 355.5, "ayer")))
        assertEquals("Gasto", unnamed.lastMerchant)
        assertEquals("US$ 356", unnamed.lastAmount)
        assertEquals("ÚLTIMO · AYER", unnamed.lastLabel)
    }

    @Test
    fun `old data is flagged`() {
        val v = present(at = now - 5 * 3_600_000L)
        assertTrue(v.updatedStale)
        assertEquals("hace 5 h", v.updated)
    }

    @Test
    fun `hidden values never reach any text of the widget`() {
        val v = present(hidden = true)
        val everything = listOf(
            v.spent, v.ofCeiling, v.pct, v.dailyValue, v.dailyCompact,
            v.lastMerchant, v.lastAmount, v.description,
        ).joinToString(" | ")

        // Neither the figures nor the merchant: this is the whole point of the eye.
        listOf("1.184", "1184", "3.100", "3100", "38", "96", "12,40", "12.4", "RAPPI", "Rappi").forEach {
            assertFalse("'$it' leaked into: $everything", everything.contains(it))
        }
        assertTrue(v.hidden)
        assertEquals("Octubre. Valores ocultos.", v.description)
    }

    @Test
    fun `hidden values keep the status colour but not the bar's length`() {
        val v = present(data.copy(state = BudgetState.AMARILLO), hidden = true)
        assertEquals(Tone.WARNING, v.tone)
        assertEquals(BarStyle.Hidden, v.bar)
    }

    @Test
    fun `hidden values do not leak how far over the ceiling it is either`() {
        val over = data.copy(spentUsd = 3220.0, state = BudgetState.ROJO, pct = 3220.0 / 3100.0)
        val v = present(over, hidden = true)
        assertEquals("SOBRE EL TECHO", v.dailyLabel)
        assertFalse(v.dailyValue.contains("120"))
        assertEquals("+US$ ••••", v.dailyValue)
    }

    @Test
    fun `what is read aloud spells out the figures only when they are visible`() {
        val v = present()
        assertTrue(v.description.contains("US$ 1.184"))
        assertTrue(v.description.contains("US$ 3.100"))
        // Sentence case on the label must not turn the currency into "us$".
        assertFalse(v.description.contains("us$"))
        assertEquals("Octubre. Gastaste US$ 1.184 de US$ 3.100, 38%. Hoy podés gastar: US$ 96.", v.description)
    }
}
