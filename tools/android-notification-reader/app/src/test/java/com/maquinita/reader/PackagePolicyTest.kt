package com.maquinita.reader

import com.maquinita.reader.PackagePolicy.Verdict
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PackagePolicyTest {

    private val policy = PackagePolicy.DEFAULT

    @Test
    fun forwardsAnAppOnTheList() {
        assertEquals(Verdict.FORWARD, policy.decide("com.grability.rappi", "RappiCard | Compra exitosa", "Tu compra en RAPPI por $ 35.350 fue exitosa."))
    }

    @Test
    fun forwardsEverythingFromAListedAppNotJustPayments() {
        // The server decides what a listed app's notification is; the phone does not filter it.
        assertEquals(Verdict.FORWARD, policy.decide("com.nexowallet", "Today's AI pick", "Bitcoin ETF flows"))
    }

    @Test
    fun smsStillHasToEarnTheUpload() {
        assertEquals(Verdict.IGNORE, policy.decide("com.google.android.apps.messaging", "Mamá", "Llegaste bien?"))
        assertEquals(
            Verdict.FORWARD,
            policy.decide("com.google.android.apps.messaging", "85540", "Bancolombia: Compraste COP35.000 en EXITO"),
        )
        assertEquals(
            Verdict.IGNORE,
            policy.decide("com.google.android.apps.messaging", "85540", "Bancolombia: tu clave dinamica es 123456"),
        )
    }

    @Test
    fun anUnknownAppWithAPaymentBecomesACandidate() {
        assertEquals(Verdict.CANDIDATE, policy.decide("com.mercadopago.wallet", "Pagaste", "Pagaste $ 12.500 a Kiosco Pepe"))
        assertEquals(Verdict.CANDIDATE, policy.decide("com.lemoncash.app", "Compra aprobada", "Compra de US$100,00 en ANTHROPIC"))
        assertEquals(Verdict.CANDIDATE, policy.decide("com.revolut.revolut", "Paid", "You paid €12.40 at Starbucks"))
    }

    @Test
    fun anUnknownAppWithoutMoneyMovingIsIgnored() {
        // A promo has no currency amount next to a payment verb.
        assertEquals(Verdict.IGNORE, policy.decide("com.mercadopago.wallet", "Hot Sale", "Hasta 50% OFF en tecnología"))
        // An amount alone is not a movement: a price alert, a balance.
        assertEquals(Verdict.IGNORE, policy.decide("com.binance.dev", "BTC", "BTC is now $68,000"))
        // A delivery update.
        assertEquals(Verdict.IGNORE, policy.decide("com.ubercab.eats", "Tu pedido", "Tu pedido llegó"))
    }

    @Test
    fun aOneTimeCodeIsNeverACandidate() {
        assertEquals(
            Verdict.IGNORE,
            policy.decide("com.mercadopago.wallet", "Código", "Tu código para confirmar el pago de $ 5.000 es 482913"),
        )
    }

    @Test
    fun chatAppsAreNeverCandidatesEvenTalkingAboutMoney() {
        assertEquals(Verdict.IGNORE, policy.decide("com.whatsapp", "Juan", "Te transferí $ 50.000, pagaste vos la cena?"))
        assertEquals(Verdict.IGNORE, policy.decide("org.telegram.messenger", "Juan", "Pagaste $ 10.000?"))
    }

    @Test
    fun chatAppsCannotBeAllowedEvenIfTheServerSaysSo() {
        val bad = PackagePolicy(setOf("com.whatsapp"), emptySet())
        assertEquals(Verdict.IGNORE, bad.decide("com.whatsapp", "Banco", "Pagaste $ 1.000"))
    }

    @Test
    fun anUnapprovedSmsAppIsNotACandidate() {
        val noSms = PackagePolicy(setOf("com.grability.rappi"), emptySet())
        assertEquals(Verdict.IGNORE, noSms.decide("com.google.android.apps.messaging", "Juan", "Pagaste $ 1.000"))
    }

    @Test
    fun aBlockedAppIsIgnoredEvenWhenItLooksLikeMoney() {
        val blocked = PackagePolicy.DEFAULT.with("com.mercadopago.wallet", PackagePolicy.BLOCKED)
        assertEquals(Verdict.IGNORE, blocked.decide("com.mercadopago.wallet", "Pagaste", "Pagaste $ 12.500"))
    }

    @Test
    fun aBlockedDefaultStopsForwarding() {
        val blocked = PackagePolicy.DEFAULT.with("com.grability.rappi", PackagePolicy.BLOCKED)
        assertEquals(Verdict.IGNORE, blocked.decide("com.grability.rappi", "RappiCard | Compra exitosa", "$ 35.350"))
    }

    @Test
    fun anApprovedAppIsForwarded() {
        val approved = PackagePolicy.DEFAULT.with("com.mercadopago.wallet", PackagePolicy.ALLOWED)
        assertEquals(Verdict.FORWARD, approved.decide("com.mercadopago.wallet", "Hot Sale", "Hasta 50% OFF"))
    }

    @Test
    fun ignoresItselfAndTheSystem() {
        assertEquals(Verdict.IGNORE, policy.decide("com.maquinita.reader", "Pagaste", "Pagaste $ 1.000"))
        assertEquals(Verdict.IGNORE, policy.decide("android", "Pagaste", "Pagaste $ 1.000"))
    }

    @Test
    fun parsesTheServerAnswer() {
        val parsed = PackagePolicy.parse("""{"allowed":["com.brubank","com.mercadopago.wallet"],"blocked":["com.grability.rappi"],"never":[],"decisions":[]}""")!!
        assertTrue("com.mercadopago.wallet" in parsed.allowed)
        assertTrue("com.grability.rappi" in parsed.blocked)
        assertFalse("com.grability.rappi" in parsed.allowed)
    }

    @Test
    fun rejectsSomethingThatIsNotAPolicy() {
        assertNull(PackagePolicy.parse("<html>"))
        assertNull(PackagePolicy.parse("""{"error":"unauthorized"}"""))
    }

    @Test
    fun roundTripsThroughJson() {
        val original = PackagePolicy(setOf("a.b", "c.d"), setOf("e.f"))
        val copy = PackagePolicy.parse(original.toJson())!!
        assertEquals(original.allowed, copy.allowed)
        assertEquals(original.blocked, copy.blocked)
    }

    @Test
    fun guessesAReadableLabel() {
        assertEquals("Brubank", PackagePolicy.fallbackLabel("com.brubank"))
        assertEquals("Mercadopago", PackagePolicy.fallbackLabel("com.mercadopago.wallet"))
        assertEquals("Lemoncash", PackagePolicy.fallbackLabel("com.lemoncash.app"))
    }
}
