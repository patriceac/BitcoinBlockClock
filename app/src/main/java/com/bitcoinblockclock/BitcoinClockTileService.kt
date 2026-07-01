package com.bitcoinblockclock

import androidx.wear.protolayout.ColorBuilders
import androidx.wear.protolayout.DimensionBuilders
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileService
import androidx.wear.tiles.TileBuilders
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.runBlocking
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit

class BitcoinClockTileService : TileService() {
    override fun onTileRequest(
        requestParams: RequestBuilders.TileRequest
    ): ListenableFuture<TileBuilders.Tile> {
        val snapshot = runBlocking {
            BitcoinClockDataSource.loadSnapshot(applicationContext, timeoutMs = 10_000L)
        }
        return ImmediateListenableFuture(
            TileBuilders.Tile.Builder()
                .setResourcesVersion(RESOURCES_VERSION)
                .setFreshnessIntervalMillis(5 * 60 * 1000L)
                .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(buildTileLayout(snapshot)))
                .build()
        )
    }

    override fun onTileResourcesRequest(
        requestParams: RequestBuilders.ResourcesRequest
    ): ListenableFuture<ResourceBuilders.Resources> {
        return ImmediateListenableFuture(
            ResourceBuilders.Resources.Builder()
                .setVersion(RESOURCES_VERSION)
                .build()
        )
    }

    private fun buildTileLayout(snapshot: BitcoinClockSnapshot): LayoutElementBuilders.LayoutElement {
        return LayoutElementBuilders.Box.Builder()
            .setWidth(DimensionBuilders.expand())
            .setHeight(DimensionBuilders.expand())
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .setVerticalAlignment(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
            .setModifiers(
                ModifiersBuilders.Modifiers.Builder()
                    .setBackground(background(WearTileBlack))
                    .build()
            )
            .addContent(frameRing())
            .addContent(tileContent(snapshot))
            .build()
    }

    private fun frameRing(): LayoutElementBuilders.LayoutElement {
        return LayoutElementBuilders.Arc.Builder()
            .setAnchorAngle(DimensionBuilders.degrees(-90f))
            .setAnchorType(LayoutElementBuilders.ARC_ANCHOR_START)
            .setVerticalAlign(LayoutElementBuilders.VERTICAL_ALIGN_CENTER)
            .addContent(
                LayoutElementBuilders.ArcLine.Builder()
                    .setLength(DimensionBuilders.degrees(360f))
                    .setThickness(DimensionBuilders.dp(2f))
                    .setColor(color(WearTileFrame))
                    .setStrokeCap(LayoutElementBuilders.STROKE_CAP_ROUND)
                    .build()
            )
            .build()
    }

    private fun tileContent(snapshot: BitcoinClockSnapshot): LayoutElementBuilders.LayoutElement {
        return LayoutElementBuilders.Column.Builder()
            .setWidth(DimensionBuilders.expand())
            .setHeight(DimensionBuilders.wrap())
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .addContent(tileText("\u20BF", WearTileOrange, 34f, LayoutElementBuilders.FONT_WEIGHT_BOLD))
            .addContent(spacer(5f))
            .addContent(tileText("BTC", WearTileOrange, 21f, LayoutElementBuilders.FONT_WEIGHT_BOLD))
            .addContent(spacer(9f))
            .addContent(tileText(snapshot.priceUsd, WearTileWhite, 40f, LayoutElementBuilders.FONT_WEIGHT_BOLD))
            .addContent(spacer(9f))
            .addContent(tileText(snapshot.priceChange, priceChangeColor(snapshot), 24f, LayoutElementBuilders.FONT_WEIGHT_BOLD))
            .build()
    }

    private fun priceChangeColor(snapshot: BitcoinClockSnapshot): Int {
        return when {
            snapshot.isPositiveChange -> WearTileGreen
            snapshot.isNegativeChange -> WearTileRed
            else -> WearTileMuted
        }
    }

    private fun tileText(
        text: String,
        argb: Int,
        sizeSp: Float,
        weight: Int
    ): LayoutElementBuilders.Text {
        return LayoutElementBuilders.Text.Builder()
            .setText(text)
            .setMaxLines(1)
            .setMultilineAlignment(LayoutElementBuilders.TEXT_ALIGN_CENTER)
            .setFontStyle(
                LayoutElementBuilders.FontStyle.Builder()
                    .setColor(color(argb))
                    .setSize(DimensionBuilders.sp(sizeSp))
                    .setWeight(weight)
                    .build()
            )
            .build()
    }

    private fun spacer(height: Float = 0f, width: Float = 0f): LayoutElementBuilders.Spacer {
        return LayoutElementBuilders.Spacer.Builder()
            .setHeight(DimensionBuilders.dp(height))
            .setWidth(DimensionBuilders.dp(width))
            .build()
    }

    private fun background(argb: Int): ModifiersBuilders.Background {
        return ModifiersBuilders.Background.Builder()
            .setColor(color(argb))
            .build()
    }

    private fun color(argb: Int): ColorBuilders.ColorProp {
        return ColorBuilders.ColorProp.Builder(argb).build()
    }

    companion object {
        private const val RESOURCES_VERSION = "bitcoin-clock-tile-v3"
        private const val WearTileBlack = -0x1000000
        private const val WearTileWhite = -0x70504
        private val WearTileMuted = 0x99EEF2F6.toInt()
        private val WearTileOrange = 0xFFF6A21F.toInt()
        private val WearTileGreen = 0xFF7EFF80.toInt()
        private val WearTileRed = 0xFFFF6464.toInt()
        private const val WearTileFrame = 0x26FFFFFF
    }

    private class ImmediateListenableFuture<T>(
        private val value: T
    ) : ListenableFuture<T> {
        override fun addListener(listener: Runnable, executor: Executor) {
            executor.execute(listener)
        }

        override fun cancel(mayInterruptIfRunning: Boolean): Boolean = false
        override fun isCancelled(): Boolean = false
        override fun isDone(): Boolean = true
        override fun get(): T = value
        override fun get(timeout: Long, unit: TimeUnit): T = value
    }
}
