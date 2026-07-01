package com.bitcoinblockclock

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationText
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.MonochromaticImage
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.RangedValueComplicationData
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService

class BitcoinBlockComplicationService : SuspendingComplicationDataSourceService() {
    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? {
        val snapshot = BitcoinClockDataSource.loadSnapshot(applicationContext, timeoutMs = 8_000L)
        return buildComplicationData(request.complicationType, snapshot)
    }

    override fun getPreviewData(type: ComplicationType): ComplicationData? {
        val preview = BitcoinClockSnapshot(
            priceUsd = "\$62,458",
            priceEur = "EUR 57,120",
            priceChange = "+2.43%",
            blockHeight = "852,314",
            blockHeightCompact = "852k",
            blockAge = "~ 8 min",
            nextHalving = "652 days",
            halvingPercent = "55.3%",
            halvingProgress = 0.553f,
            feeRate = "1 sat/vB",
            feeNumber = "1",
            feeUnit = "sat/vB",
            hashRate = "--",
            updatedAt = "10:24",
            freshness = BitcoinClockFreshness.Fresh
        )
        return buildComplicationData(type, preview)
    }

    private fun buildComplicationData(
        type: ComplicationType,
        snapshot: BitcoinClockSnapshot
    ): ComplicationData? {
        val image = MonochromaticImage.Builder(
            Icon.createWithResource(this, R.drawable.ic_bitcoin_complication)
        ).build()
        val tapAction = openAppIntent(this)

        return when (type) {
            ComplicationType.SHORT_TEXT -> ShortTextComplicationData.Builder(
                plain(snapshot.priceUsd),
                plain("Bitcoin price ${snapshot.priceUsd}, ${snapshot.priceChange}")
            )
                .setTitle(plain("BTC"))
                .setMonochromaticImage(image)
                .setTapAction(tapAction)
                .build()

            ComplicationType.RANGED_VALUE -> RangedValueComplicationData.Builder(
                100f,
                0f,
                100f,
                plain("Bitcoin price ${snapshot.priceUsd}, ${snapshot.priceChange}")
            )
                .setTitle(plain("BTC"))
                .setText(plain(snapshot.priceUsd))
                .setMonochromaticImage(image)
                .setTapAction(tapAction)
                .build()

            else -> null
        }
    }

    private fun plain(text: CharSequence): ComplicationText {
        return PlainComplicationText.Builder(text).build()
    }

    private fun openAppIntent(context: Context): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
        return PendingIntent.getActivity(
            context,
            2,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}
