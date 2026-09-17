package com.bitcoinblockclock

import java.text.NumberFormat
import java.util.Locale
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

internal data class PriceAlertState(
    val reference: Double? = null,
    val previous: Double? = null,
    val blocked: Set<Long> = emptySet()
)

internal data class PriceAlert(
    val price: Double,
    val reference: Double,
    val changePercent: Double,
    val direction: String,
    val levels: List<Long>,
    val percentageTriggered: Boolean
) {
    private val arrow get() = if (direction == "up") "↑" else "↓"
    val title: String get() = "Bitcoin $arrow · ${usd(price, 2)}"
    val body: String get() = (if (levels.isEmpty()) "" else "Crossed ${levels.joinToString(", ") { usd(it.toDouble(), 0) }} $arrow · ") +
        String.format(Locale.US, "%+.2f%% since last reference", changePercent)

    private fun usd(value: Double, decimals: Int): String = NumberFormat.getCurrencyInstance(Locale.US).apply {
        minimumFractionDigits = decimals
        maximumFractionDigits = decimals
    }.format(value)
}

internal object PriceAlertEngine {
    private const val STEP = 5_000L
    private const val EPSILON = 1e-10
    fun validPrice(value: Double?) = value != null && value.isFinite() && value > 0

    fun evaluate(state: PriceAlertState, price: Double): Pair<PriceAlertState, PriceAlert?> {
        if (!validPrice(price)) return state to null
        val reference = state.reference
        val previous = state.previous
        if (!validPrice(reference) || !validPrice(previous)) return PriceAlertState(price, price) to null
        reference!!
        previous!!
        val blocked = state.blocked.toMutableSet()
        val levels = mutableListOf<Long>()
        var level = (ceil(min(price, previous) / STEP) * STEP).toLong()
        while (level <= max(price, previous)) {
            if (level > 0 && level !in blocked && ((previous < level && price >= level) || (previous > level && price <= level))) levels.add(level)
            level += STEP
        }
        if (price < previous) levels.reverse()
        // Rearming affects subsequent samples, never the crossing that establishes
        // the distance. A crossing that overshoots 1% is already clear to rearm.
        (blocked.toList() + levels).forEach {
            if (abs(price - it) / it + EPSILON >= 0.01) blocked.remove(it) else blocked.add(it)
        }
        val change = (price / reference - 1) * 100
        val percentage = abs(price - reference) / reference + EPSILON >= 0.02
        val alert = if (percentage || levels.isNotEmpty()) PriceAlert(
            price, reference, change,
            if (levels.isNotEmpty()) { if (price > previous) "up" else "down" } else if (change >= 0) "up" else "down",
            levels, percentage
        ) else null
        return PriceAlertState(if (alert != null) price else reference, price, blocked) to alert
    }
}
