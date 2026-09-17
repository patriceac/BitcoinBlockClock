package com.bitcoinblockclock

internal object PriceAlertSchedule {
    const val INTERVAL_MS = 60 * 60 * 1000L

    fun remainingDelayMs(lastAttemptAt: Long?, now: Long): Long {
        if (lastAttemptAt == null || lastAttemptAt <= 0 || lastAttemptAt > now) return 0
        return (INTERVAL_MS - (now - lastAttemptAt)).coerceAtLeast(0)
    }
}
