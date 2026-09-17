package com.bitcoinblockclock

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.RemoteViews
import org.json.JSONObject

/** The phone widget reports alert status; it never fetches or displays a quote. */
class BitcoinBlockClockWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = update(context, manager, ids)

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) = update(context, manager, intArrayOf(id))

    companion object {
        fun refreshAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, BitcoinBlockClockWidgetProvider::class.java))
            if (ids.isNotEmpty()) update(context, manager, ids)
        }

        private fun update(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val status = JSONObject(PriceAlertStore.status(context))
            val text = when (status.optString("status")) {
                "monitoring" -> "Monitoring quietly"
                "paused" -> "Monitoring paused"
                "permission" -> "Enable notifications"
                "connecting" -> "Connecting…"
                else -> "Monitoring interrupted"
            }
            val intent = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            for (id in ids) {
                val views = RemoteViews(context.packageName, R.layout.price_alert_widget)
                views.setTextViewText(R.id.alert_widget_status, text)
                views.setOnClickPendingIntent(R.id.alert_widget_root, intent)
                manager.updateAppWidget(id, views)
            }
        }
    }
}
