package com.bitcoinblockclock

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.max

internal enum class BitcoinClockFreshness {
    Fresh,
    Stale,
    Offline
}

internal data class BitcoinClockSnapshot(
    val priceUsd: String,
    val priceEur: String,
    val priceChange: String,
    val blockHeight: String,
    val blockHeightCompact: String,
    val blockAge: String,
    val nextHalving: String,
    val halvingPercent: String,
    val halvingProgress: Float,
    val feeRate: String,
    val feeNumber: String,
    val feeUnit: String,
    val hashRate: String,
    val updatedAt: String,
    val freshness: BitcoinClockFreshness
) {
    val isPositiveChange: Boolean
        get() = priceChange.startsWith("+")

    val isNegativeChange: Boolean
        get() = priceChange.startsWith("-")
}

private data class BitcoinPriceResult(
    val usd: Double,
    val eur: Double,
    val usdChangePercent: Double?
)

private data class BitcoinBlockResult(
    val height: Long,
    val timestampSeconds: Long?
)

internal object BitcoinClockDataSource {
    private const val PREFS_NAME = "bitcoin_clock_snapshot"
    private const val REQUEST_TIMEOUT_MS = 18_000L

    suspend fun loadSnapshot(
        context: Context,
        timeoutMs: Long = REQUEST_TIMEOUT_MS
    ): BitcoinClockSnapshot {
        return try {
            val snapshot = fetchSnapshot(timeoutMs)
            saveSnapshot(context, snapshot)
            snapshot
        } catch (error: Exception) {
            readCachedSnapshot(context)?.copy(freshness = BitcoinClockFreshness.Stale)
                ?: placeholderSnapshot(BitcoinClockFreshness.Offline)
        }
    }

    fun readCachedSnapshot(context: Context): BitcoinClockSnapshot? {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val priceUsd = prefs.getString("priceUsd", null) ?: return null
        return BitcoinClockSnapshot(
            priceUsd = priceUsd,
            priceEur = prefs.getString("priceEur", "EUR --") ?: "EUR --",
            priceChange = prefs.getString("priceChange", "Live") ?: "Live",
            blockHeight = prefs.getString("blockHeight", "--") ?: "--",
            blockHeightCompact = prefs.getString("blockHeightCompact", "--") ?: "--",
            blockAge = prefs.getString("blockAge", "--") ?: "--",
            nextHalving = prefs.getString("nextHalving", "--") ?: "--",
            halvingPercent = prefs.getString("halvingPercent", "--") ?: "--",
            halvingProgress = prefs.getFloat("halvingProgress", 0f),
            feeRate = prefs.getString("feeRate", "--") ?: "--",
            feeNumber = prefs.getString("feeNumber", "--") ?: "--",
            feeUnit = prefs.getString("feeUnit", "sat/vB") ?: "sat/vB",
            hashRate = prefs.getString("hashRate", "--") ?: "--",
            updatedAt = prefs.getString("updatedAt", "--:--") ?: "--:--",
            freshness = BitcoinClockFreshness.Stale
        )
    }

    fun placeholderSnapshot(freshness: BitcoinClockFreshness = BitcoinClockFreshness.Offline): BitcoinClockSnapshot {
        return BitcoinClockSnapshot(
            priceUsd = "\$--",
            priceEur = "EUR --",
            priceChange = "Live",
            blockHeight = "--",
            blockHeightCompact = "--",
            blockAge = "--",
            nextHalving = "--",
            halvingPercent = "--",
            halvingProgress = 0f,
            feeRate = "--",
            feeNumber = "--",
            feeUnit = "sat/vB",
            hashRate = "--",
            updatedAt = "--:--",
            freshness = freshness
        )
    }

    private suspend fun fetchSnapshot(timeoutMs: Long): BitcoinClockSnapshot = withTimeout(timeoutMs) {
        coroutineScope {
            val price = async(Dispatchers.IO) { fetchPrice() }
            val block = async(Dispatchers.IO) { fetchLatestBlock() }
            val feeRate = async(Dispatchers.IO) { fetchFeeRate() }
            val hashRate = async(Dispatchers.IO) { fetchHashRate() }

            val priceValue = price.await()
            val blockValue = block.await()
            val halving = calculateHalving(blockValue.height)
            val fee = feeRate.await()
            val feeParts = splitFeeRate(fee)

            BitcoinClockSnapshot(
                priceUsd = "\$${formatNumber(priceValue.usd, 0)}",
                priceEur = "EUR ${formatNumber(priceValue.eur, 0)}",
                priceChange = formatChange(priceValue.usdChangePercent),
                blockHeight = NumberFormat.getIntegerInstance(Locale.US).format(blockValue.height),
                blockHeightCompact = formatCompactBlock(blockValue.height),
                blockAge = formatBlockAge(blockValue.timestampSeconds),
                nextHalving = halving.first,
                halvingPercent = "${formatNumber(halving.second * 100.0, 1)}%",
                halvingProgress = halving.second.toFloat(),
                feeRate = fee,
                feeNumber = feeParts.first,
                feeUnit = feeParts.second,
                hashRate = hashRate.await(),
                updatedAt = formatTime(),
                freshness = BitcoinClockFreshness.Fresh
            )
        }
    }

    private fun saveSnapshot(context: Context, snapshot: BitcoinClockSnapshot) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString("priceUsd", snapshot.priceUsd)
            .putString("priceEur", snapshot.priceEur)
            .putString("priceChange", snapshot.priceChange)
            .putString("blockHeight", snapshot.blockHeight)
            .putString("blockHeightCompact", snapshot.blockHeightCompact)
            .putString("blockAge", snapshot.blockAge)
            .putString("nextHalving", snapshot.nextHalving)
            .putString("halvingPercent", snapshot.halvingPercent)
            .putFloat("halvingProgress", snapshot.halvingProgress)
            .putString("feeRate", snapshot.feeRate)
            .putString("feeNumber", snapshot.feeNumber)
            .putString("feeUnit", snapshot.feeUnit)
            .putString("hashRate", snapshot.hashRate)
            .putString("updatedAt", snapshot.updatedAt)
            .apply()
    }

    private fun fetchPrice(): BitcoinPriceResult {
        val coingeckoUrl = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,eur&include_24hr_change=true"
        return try {
            val bitcoin = JSONObject(fetchText(coingeckoUrl)).getJSONObject("bitcoin")
            BitcoinPriceResult(
                usd = bitcoin.getDouble("usd"),
                eur = bitcoin.getDouble("eur"),
                usdChangePercent = bitcoin.optDouble("usd_24h_change").takeIf { it.isFinite() }
            )
        } catch (error: Exception) {
            val ticker = JSONObject(fetchText("https://blockchain.info/ticker"))
            BitcoinPriceResult(
                usd = ticker.getJSONObject("USD").getDouble("last"),
                eur = ticker.getJSONObject("EUR").getDouble("last"),
                usdChangePercent = null
            )
        }
    }

    private fun fetchLatestBlock(): BitcoinBlockResult {
        return try {
            val latestBlock = JSONObject(fetchText("https://blockchain.info/latestblock"))
            BitcoinBlockResult(
                height = latestBlock.getLong("height"),
                timestampSeconds = latestBlock.optLong("time").takeIf { it > 0L }
            )
        } catch (error: Exception) {
            BitcoinBlockResult(
                height = fetchText("https://blockchain.info/q/getblockcount").trim().toLong(),
                timestampSeconds = null
            )
        }
    }

    private fun fetchFeeRate(): String {
        return try {
            val data = JSONObject(fetchText("https://mempool.space/api/v1/fees/recommended"))
            val fee = sequenceOf("halfHourFee", "fastestFee", "hourFee", "economyFee")
                .mapNotNull { key -> data.optDouble(key).takeIf { it.isFinite() } }
                .firstOrNull()

            if (fee != null) {
                "${formatNumber(fee, if (fee < 10 && fee % 1.0 != 0.0) 1 else 0)} sat/vB"
            } else {
                "--"
            }
        } catch (error: Exception) {
            "--"
        }
    }

    private fun fetchHashRate(): String {
        return try {
            val data = JSONObject(fetchText("https://api.blockchain.info/charts/hash-rate?timespan=30days&format=json&cors=true"))
            val values = data.getJSONArray("values")
            for (index in values.length() - 1 downTo 0) {
                val y = values.getJSONObject(index).optDouble("y")
                if (y.isFinite()) {
                    return formatHashRate(y, "TH/s")
                }
            }
            "--"
        } catch (error: Exception) {
            "--"
        }
    }

    private fun splitFeeRate(feeRate: String): Pair<String, String> {
        val number = feeRate.substringBefore(" ").takeIf { it.isNotBlank() } ?: feeRate
        val unit = feeRate.removePrefix(number).trim().ifBlank { "sat/vB" }
        return number to unit
    }

    private fun fetchText(url: String): String {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 8_000
            readTimeout = 8_000
            requestMethod = "GET"
            setRequestProperty("User-Agent", "BitcoinBlockClock/1.0")
        }

        try {
            val code = connection.responseCode
            if (code !in 200..299) {
                throw IOException("Request failed with HTTP $code")
            }
            return connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    private suspend fun formatBlockAge(timestampSeconds: Long?): String = withContext(Dispatchers.Default) {
        if (timestampSeconds == null) {
            return@withContext "--"
        }
        val seconds = max(0L, Date().time / 1000L - timestampSeconds)
        val minutes = seconds / 60L
        when {
            minutes < 1L -> "< 1 min"
            minutes < 60L -> "~ $minutes min"
            else -> "~ ${minutes / 60L} h"
        }
    }

    private fun calculateHalving(blockHeight: Long): Pair<String, Double> {
        val blocksPerHalving = 210_000L
        val currentHalvingIndex = blockHeight / blocksPerHalving
        val nextHalvingBlock = (currentHalvingIndex + 1) * blocksPerHalving
        val blocksUntilNextHalving = nextHalvingBlock - blockHeight
        val days = (blocksUntilNextHalving * 10L) / (60L * 24L)
        val progress = 1.0 - (blocksUntilNextHalving.toDouble() / blocksPerHalving.toDouble())

        return "${days} days" to progress.coerceIn(0.0, 1.0)
    }

    private fun formatChange(value: Double?): String {
        if (value == null || !value.isFinite()) {
            return "Live"
        }
        val sign = if (value > 0) "+" else ""
        return "$sign${formatNumber(value, 2)}%"
    }

    private fun formatCompactBlock(value: Long): String {
        if (value < 1_000L) {
            return value.toString()
        }
        val compact = value / 1_000.0
        return "${formatNumber(compact, 1)}k"
    }

    private fun formatNumber(value: Double, maxFractionDigits: Int): String {
        return NumberFormat.getNumberInstance(Locale.US).apply {
            minimumFractionDigits = maxFractionDigits
            maximumFractionDigits = maxFractionDigits
        }.format(value)
    }

    private fun formatHashRate(hashRate: Double, startingUnit: String): String {
        val units = listOf("GH/s", "TH/s", "PH/s", "EH/s", "ZH/s", "YH/s")
        var index = max(units.indexOf(startingUnit), 0)
        var rate = hashRate

        while (rate >= 1000.0 && index < units.lastIndex) {
            rate /= 1000.0
            index += 1
        }

        return "${formatNumber(rate, 2)} ${units[index]}"
    }

    private fun formatTime(): String {
        return SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date())
    }
}
