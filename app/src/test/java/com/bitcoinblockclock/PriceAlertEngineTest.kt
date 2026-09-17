package com.bitcoinblockclock

import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test

class PriceAlertEngineTest {
    @Test fun sharedDesktopAndAndroidVectors() {
        val vectors = JSONArray(javaClass.getResource("/price-alert-vectors.json")!!.readText())
        for (v in 0 until vectors.length()) {
            val vector = vectors.getJSONObject(v)
            val name = vector.getString("name")
            val prices = vector.getJSONArray("prices")
            val expected = vector.getJSONArray("alerts")
            var state = PriceAlertState()
            var alertIndex = 0
            for (i in 0 until prices.length()) {
                val (next, alert) = PriceAlertEngine.evaluate(state, prices.getDouble(i))
                state = next
                if (alert != null) {
                    assertTrue("$name: unexpected alert at $i", alertIndex < expected.length())
                    val e = expected.getJSONObject(alertIndex++)
                    assertEquals(name, e.getInt("index"), i)
                    assertEquals(name, e.getBoolean("percentage"), alert.percentageTriggered)
                    assertEquals(name, e.getString("direction"), alert.direction)
                    val levels = e.getJSONArray("levels")
                    assertEquals(name, (0 until levels.length()).map { levels.getLong(it) }, alert.levels)
                }
            }
            assertEquals(name, expected.length(), alertIndex)
            assertEquals(name, vector.getDouble("reference"), state.reference!!, 0.00001)
        }
    }

    @Test fun invalidSamplesStaySilent() {
        val state = PriceAlertState(80000.0, 80000.0)
        for (price in listOf(Double.NaN, Double.POSITIVE_INFINITY, 0.0, -1.0)) {
            val (next, alert) = PriceAlertEngine.evaluate(state, price)
            assertEquals(state, next)
            assertNull(alert)
        }
    }

    @Test fun notificationContentMatchesDesktop() {
        val (_, alert) = PriceAlertEngine.evaluate(PriceAlertState(78400.0, 78400.0), 80050.0)
        assertEquals("Bitcoin ↑ · $80,050.00", alert!!.title)
        assertEquals("Crossed $80,000 ↑ · +2.10% since last reference", alert.body)
    }
}
