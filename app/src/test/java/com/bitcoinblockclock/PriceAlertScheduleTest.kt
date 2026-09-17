package com.bitcoinblockclock

import org.junit.Assert.assertEquals
import org.junit.Test

class PriceAlertScheduleTest {
    private val startedAt = 1_700_000_000_000L

    @Test fun firstCheckIsImmediate() {
        assertEquals(0L, PriceAlertSchedule.remainingDelayMs(null, startedAt))
        assertEquals(0L, PriceAlertSchedule.remainingDelayMs(0L, startedAt))
    }

    @Test fun reopeningOrBackgroundWorkWaitsForTheSameHourlyDeadline() {
        assertEquals(3_600_000L, PriceAlertSchedule.remainingDelayMs(startedAt, startedAt))
        assertEquals(2_700_000L, PriceAlertSchedule.remainingDelayMs(startedAt, startedAt + 15 * 60_000L))
        assertEquals(1L, PriceAlertSchedule.remainingDelayMs(startedAt, startedAt + 3_599_999L))
        assertEquals(0L, PriceAlertSchedule.remainingDelayMs(startedAt, startedAt + 3_600_000L))
        assertEquals(0L, PriceAlertSchedule.remainingDelayMs(startedAt, startedAt + 7_200_000L))
    }

    @Test fun aClockChangeDoesNotBlockChecksIndefinitely() {
        assertEquals(0L, PriceAlertSchedule.remainingDelayMs(startedAt, startedAt - 60_000L))
    }
}
