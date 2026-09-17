package com.bitcoinblockclock

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

internal object PriceAlertStore {
    private fun prefs(context: Context) = context.getSharedPreferences("bitcoin_price_alerts", Context.MODE_PRIVATE)
    @Volatile var error: String? = null
    @Volatile var running = false

    @Synchronized fun read(context: Context): JSONObject {
        val saved = prefs(context).getString("state", null) ?: return JSONObject().put("version", 1).put("enabled", true)
        return JSONObject(saved).also { require(it.optInt("version") == 1) { "Unsupported alert state" } }
    }

    private fun save(context: Context, value: JSONObject) {
        if (!prefs(context).edit().putString("state", value.toString()).commit()) throw IOException("Cannot save monitoring state")
    }

    fun engine(value: JSONObject): PriceAlertState {
        val data = value.optJSONObject("engine") ?: return PriceAlertState()
        val reference = data.optDouble("reference").takeIf { PriceAlertEngine.validPrice(it) }
        val previous = data.optDouble("previous").takeIf { PriceAlertEngine.validPrice(it) }
        val blocked = data.optJSONArray("blocked") ?: JSONArray()
        return PriceAlertState(reference, previous, (0 until blocked.length()).map { blocked.optLong(it) }.filter { it > 0 && it % 5000L == 0L }.toSet())
    }

    @Synchronized fun setEnabled(context: Context, enabled: Boolean) {
        val data = read(context)
        if (data.optBoolean("enabled", true) != enabled) {
            data.remove("engine")
            data.remove("lastCheckAt")
            data.remove("pending")
        }
        data.put("enabled", enabled)
        save(context, data)
        error = null
        BitcoinBlockClockWidgetProvider.refreshAll(context)
    }

    @Synchronized fun enabled(context: Context) = read(context).optBoolean("enabled", true)

    @Synchronized fun deliverPending(context: Context) {
        val data = read(context)
        val pending = data.optJSONObject("pending") ?: return
        PriceAlertService.deliver(context, pending)
        data.put("lastAlert", pending).remove("pending")
        save(context, data)
    }

    @Synchronized fun accept(context: Context, price: Double) {
        val data = read(context)
        if (!data.optBoolean("enabled", true)) return
        check(!data.has("pending")) { "Previous notification still pending" }
        val (next, alert) = PriceAlertEngine.evaluate(engine(data), price)
        data.put("engine", JSONObject().put("reference", next.reference).put("previous", next.previous).put("blocked", JSONArray(next.blocked.sorted())))
        val now = System.currentTimeMillis()
        data.put("lastCheckAt", now)
        if (alert != null) data.put("pending", JSONObject()
            .put("id", "btc-$now").put("at", now).put("title", alert.title).put("body", alert.body)
            .put("price", alert.price).put("reference", alert.reference).put("changePercent", alert.changePercent)
            .put("direction", alert.direction).put("levels", JSONArray(alert.levels)).put("percentageTriggered", alert.percentageTriggered))
        save(context, data)
        deliverPending(context)
        error = null
    }

    @Synchronized fun status(context: Context): String {
        return try {
            val data = read(context)
            val enabled = data.optBoolean("enabled", true)
            val stale = data.has("lastCheckAt") && System.currentTimeMillis() - data.optLong("lastCheckAt") > 90_000
            val allowed = PriceAlertService.notificationsAllowed(context)
            val state = when {
                !enabled -> "paused"
                !allowed -> "permission"
                error != null || stale || !running -> "interrupted"
                engine(data).reference == null -> "connecting"
                else -> "monitoring"
            }
            JSONObject().put("enabled", enabled).put("status", state).put("platform", "android")
                .put("message", if (!allowed && enabled) "Allow Bitcoin price notifications to receive alerts." else error ?: if (enabled && (!running || stale)) "Waiting for monitoring to resume. Reopen the app if this persists." else JSONObject.NULL)
                .put("lastCheckAt", data.opt("lastCheckAt") ?: JSONObject.NULL)
                .put("lastAlert", data.optJSONObject("lastAlert") ?: JSONObject.NULL).toString()
        } catch (_: Exception) {
            JSONObject().put("enabled", false).put("status", "interrupted").put("platform", "android")
                .put("message", "Saved monitoring state could not be read.").toString()
        }
    }
}
