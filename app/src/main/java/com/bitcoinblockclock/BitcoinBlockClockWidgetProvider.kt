package com.bitcoinblockclock

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.widget.RemoteViews
import kotlinx.coroutines.runBlocking
import kotlin.concurrent.thread
import kotlin.math.roundToInt

class BitcoinBlockClockWidgetProvider : AppWidgetProvider() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action == ACTION_REFRESH || action == AppWidgetManager.ACTION_APPWIDGET_UPDATE) {
            val appWidgetManager = AppWidgetManager.getInstance(context)
            val appWidgetIds = intent.getIntArrayExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS)
                ?: appWidgetManager.getAppWidgetIds(ComponentName(context, BitcoinBlockClockWidgetProvider::class.java))

            val cachedSnapshot = BitcoinClockDataSource.readCachedSnapshot(context)
                ?: BitcoinClockDataSource.placeholderSnapshot()
            updateWidgets(context, appWidgetManager, appWidgetIds, cachedSnapshot, isSyncing = action == ACTION_REFRESH)

            val pendingResult = goAsync()
            refreshWidgets(context.applicationContext, appWidgetManager, appWidgetIds) {
                pendingResult.finish()
            }
            return
        }

        super.onReceive(context, intent)
    }

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        val cachedSnapshot = BitcoinClockDataSource.readCachedSnapshot(context)
            ?: BitcoinClockDataSource.placeholderSnapshot()
        updateWidgets(context, appWidgetManager, appWidgetIds, cachedSnapshot, isSyncing = false)
        refreshWidgets(context.applicationContext, appWidgetManager, appWidgetIds)
    }

    override fun onAppWidgetOptionsChanged(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetId: Int,
        newOptions: Bundle
    ) {
        val snapshot = BitcoinClockDataSource.readCachedSnapshot(context)
            ?: BitcoinClockDataSource.placeholderSnapshot()
        updateWidget(context, appWidgetManager, appWidgetId, snapshot, isSyncing = false)
        refreshWidgets(context.applicationContext, appWidgetManager, intArrayOf(appWidgetId))
    }

    companion object {
        private const val ACTION_REFRESH = "com.bitcoinblockclock.action.REFRESH_WIDGET"

        private fun refreshWidgets(
            context: Context,
            appWidgetManager: AppWidgetManager,
            appWidgetIds: IntArray,
            onComplete: (() -> Unit)? = null
        ) {
            thread(name = "BitcoinWidgetRefresh") {
                try {
                    val snapshot = runBlocking { BitcoinClockDataSource.loadSnapshot(context) }
                    updateWidgets(context, appWidgetManager, appWidgetIds, snapshot, isSyncing = false)
                } finally {
                    onComplete?.invoke()
                }
            }
        }

        private fun updateWidgets(
            context: Context,
            appWidgetManager: AppWidgetManager,
            appWidgetIds: IntArray,
            snapshot: BitcoinClockSnapshot,
            isSyncing: Boolean
        ) {
            appWidgetIds.forEach { appWidgetId ->
                updateWidget(context, appWidgetManager, appWidgetId, snapshot, isSyncing)
            }
        }

        private fun updateWidget(
            context: Context,
            appWidgetManager: AppWidgetManager,
            appWidgetId: Int,
            snapshot: BitcoinClockSnapshot,
            isSyncing: Boolean
        ) {
            val isCompact = isCompactWidget(appWidgetManager.getAppWidgetOptions(appWidgetId))
            val views = RemoteViews(
                context.packageName,
                if (isCompact) {
                    R.layout.bitcoin_block_clock_widget_compact
                } else {
                    R.layout.bitcoin_block_clock_widget
                }
            )

            val statusText = when {
                isSyncing -> "Sync"
                snapshot.freshness == BitcoinClockFreshness.Offline -> "Offline"
                snapshot.freshness == BitcoinClockFreshness.Stale -> "Stale"
                else -> snapshot.updatedAt
            }

            views.setTextViewText(R.id.widget_price, snapshot.priceUsd)
            views.setTextViewText(R.id.widget_change, snapshot.priceChange)
            views.setTextViewText(R.id.widget_updated_at, statusText)
            views.setTextViewText(
                R.id.widget_block,
                if (isCompact) {
                    "BLOCK ${snapshot.blockHeightCompact}"
                } else {
                    snapshot.blockHeight
                }
            )
            views.setTextViewText(R.id.widget_block_age, snapshot.blockAge)
            views.setTextViewText(
                R.id.widget_halving,
                if (isCompact) {
                    "HALVING ${snapshot.halvingPercent}"
                } else {
                    snapshot.halvingPercent
                }
            )
            views.setProgressBar(
                R.id.widget_halving_progress,
                1000,
                (snapshot.halvingProgress.coerceIn(0f, 1f) * 1000f).roundToInt(),
                false
            )
            views.setTextViewText(
                R.id.widget_fees,
                if (isCompact) {
                    "FEES ${snapshot.feeRate}"
                } else {
                    snapshot.feeRate
                }
            )

            val changeBackground = when {
                snapshot.isPositiveChange -> R.drawable.widget_pill_green
                snapshot.isNegativeChange -> R.drawable.widget_pill_red
                else -> R.drawable.widget_pill_neutral
            }
            val changeColor = when {
                snapshot.isPositiveChange -> Color.rgb(30, 215, 96)
                snapshot.isNegativeChange -> Color.rgb(255, 100, 100)
                else -> Color.rgb(238, 242, 246)
            }
            views.setInt(R.id.widget_change, "setBackgroundResource", changeBackground)
            views.setTextColor(R.id.widget_change, changeColor)

            views.setOnClickPendingIntent(R.id.widget_root, openAppIntent(context))
            views.setOnClickPendingIntent(R.id.widget_refresh, refreshIntent(context))
            appWidgetManager.updateAppWidget(appWidgetId, views)
        }

        private fun isCompactWidget(options: Bundle): Boolean {
            val minWidth = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250)
            val minHeight = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 110)
            return minWidth < 220 || minHeight < 96
        }

        private fun openAppIntent(context: Context): PendingIntent {
            val intent = Intent(context, MainActivity::class.java)
            return PendingIntent.getActivity(
                context,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        private fun refreshIntent(context: Context): PendingIntent {
            val intent = Intent(context, BitcoinBlockClockWidgetProvider::class.java).apply {
                action = ACTION_REFRESH
            }
            return PendingIntent.getBroadcast(
                context,
                1,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
    }
}
