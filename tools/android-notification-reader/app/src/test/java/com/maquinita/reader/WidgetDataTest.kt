package com.maquinita.reader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class WidgetDataTest {

    private val full = """
        {"month":"2026-10","month_label":"Octubre","day":12,"days_in_month":31,
         "spent_usd":1184,"ceiling_usd":3100,"state":"verde","pct":0.3819,"expected_pct":0.3871,
         "daily_available_usd":95.8,
         "last":{"merchant":"RAPPI","amount_usd":12.4,"when_label":"hoy 14:32"},
         "generated_at":"2026-10-12T20:30:00.000Z"}
    """.trimIndent()

    @Test
    fun `parses what the server sends`() {
        val data = WidgetData.parse(full)!!
        assertEquals("Octubre", data.monthLabel)
        assertEquals(12, data.day)
        assertEquals(31, data.daysInMonth)
        assertEquals(1184.0, data.spentUsd, 0.0)
        assertEquals(3100.0, data.ceilingUsd!!, 0.0)
        assertEquals(BudgetState.VERDE, data.state)
        assertEquals(0.3819, data.pct!!, 1e-9)
        assertEquals(95.8, data.dailyAvailableUsd!!, 1e-9)
        assertEquals(WidgetLast("RAPPI", 12.4, "hoy 14:32"), data.last)
    }

    @Test
    fun `a month without a ceiling has no semaphore, bar or daily budget`() {
        val data = WidgetData.parse(
            """{"month_label":"Octubre","day":3,"days_in_month":31,"spent_usd":50.5,
               "ceiling_usd":null,"state":null,"pct":null,"expected_pct":null,
               "daily_available_usd":null,"last":null}""",
        )!!
        assertNull(data.ceilingUsd)
        assertNull(data.state)
        assertNull(data.pct)
        assertNull(data.dailyAvailableUsd)
        assertNull(data.last)
    }

    @Test
    fun `an unknown state is no state rather than a crash`() {
        assertNull(WidgetData.parse(full.replace("\"verde\"", "\"morado\""))!!.state)
    }

    @Test
    fun `a last purchase without a merchant keeps its amount`() {
        val data = WidgetData.parse(full.replace("\"RAPPI\"", "null"))!!
        assertNull(data.last!!.merchant)
        assertEquals(12.4, data.last!!.amountUsd, 0.0)
    }

    @Test
    fun `anything that is not a usable summary parses to null, never to a half-filled one`() {
        val broken = listOf(
            "",
            "not json",
            "{}",
            """{"error":"unauthorized"}""",
            full.replace("\"day\":12", "\"day\":0"),
            full.replace("\"day\":12", "\"day\":40"),
            full.replace("\"days_in_month\":31", "\"days_in_month\":12"),
            full.replace("\"day\":12", "\"day\":31").replace("\"days_in_month\":31", "\"days_in_month\":30"),
            full.replace("\"spent_usd\":1184", "\"spent_usd\":-5"),
            full.replace("\"spent_usd\":1184,", ""),
            full.substring(0, full.length / 2),
        )
        broken.forEach { assertNull("should not parse: $it", WidgetData.parse(it)) }
        assertNotNull(WidgetData.parse(full))
    }
}
