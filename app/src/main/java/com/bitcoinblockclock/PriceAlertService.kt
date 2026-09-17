package com.bitcoinblockclock

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class PriceAlertService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var started = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_PAUSE) {
            PriceAlertStore.setEnabled(this, false)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        if (!PriceAlertStore.enabled(this) || !notificationsAllowed(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        createChannels(this)
        val pause = PendingIntent.getService(this, 2, Intent(this, PriceAlertService::class.java).setAction(ACTION_PAUSE), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        startForeground(STATUS_ID, NotificationCompat.Builder(this, STATUS_CHANNEL)
            .setSmallIcon(R.drawable.ic_price_alert)
            .setContentTitle("Bitcoin alerts active")
            .setContentText("Watching for ±2% moves and $5,000 crossings.")
            .setContentIntent(openApp(this))
            .setOngoing(true).setSilent(true).setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(0, "Pause", pause).build())
        PriceAlertStore.running = true
        BitcoinBlockClockWidgetProvider.refreshAll(this)
        if (!started) {
            started = true
            scope.launch {
                while (isActive && PriceAlertStore.enabled(this@PriceAlertService)) {
                    val wakeLock = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "BitcoinBlockClock:quote")
                    val previousStatus = JSONObject(PriceAlertStore.status(this@PriceAlertService)).optString("status")
                    try {
                        check(notificationsAllowed(this@PriceAlertService)) { "Notifications disabled" }
                        wakeLock.acquire(25_000)
                        PriceAlertStore.deliverPending(this@PriceAlertService)
                        val price = fetchPrice()
                        PriceAlertStore.accept(this@PriceAlertService, price)
                    } catch (_: Exception) {
                        PriceAlertStore.error = "Monitoring interrupted. Retrying when connection and notifications are available."
                    } finally {
                        if (wakeLock.isHeld) wakeLock.release()
                        if (previousStatus != JSONObject(PriceAlertStore.status(this@PriceAlertService)).optString("status")) BitcoinBlockClockWidgetProvider.refreshAll(this@PriceAlertService)
                    }
                    delay(30_000)
                }
                stopSelf()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        PriceAlertStore.running = false
        scope.cancel()
        BitcoinBlockClockWidgetProvider.refreshAll(this)
        super.onDestroy()
    }

    private fun fetchPrice(): Double {
        val connection = URL("https://api.kraken.com/0/public/Ticker?pair=XBTUSD").openConnection() as HttpURLConnection
        connection.connectTimeout = 12_000
        connection.readTimeout = 12_000
        connection.useCaches = false
        try {
            check(connection.responseCode in 200..299) { "Quote unavailable" }
            val data = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
            check(data.getJSONArray("error").length() == 0) { "Invalid quote" }
            val result = data.getJSONObject("result")
            return result.getJSONObject(result.keys().next()).getJSONArray("c").getString(0).toDouble().also {
                check(PriceAlertEngine.validPrice(it)) { "Invalid price" }
            }
        } finally { connection.disconnect() }
    }

    companion object {
        const val ALERT_CHANNEL = "bitcoin-price-movements"
        private const val STATUS_CHANNEL = "bitcoin-price-monitor"
        private const val STATUS_ID = 7100
        private const val ACTION_PAUSE = "com.bitcoinblockclock.PAUSE_ALERTS"

        fun createChannels(context: Context) {
            val manager = context.getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(ALERT_CHANNEL, "Bitcoin price movements", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Meaningful price movements only: ±2% and $5,000 crossings."
            })
            manager.createNotificationChannel(NotificationChannel(STATUS_CHANNEL, "Monitoring status", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Silent status for background monitoring. No price updates."
                setSound(null, null)
                enableVibration(false)
                setShowBadge(false)
            })
        }

        fun notificationsAllowed(context: Context): Boolean {
            val manager = context.getSystemService(NotificationManager::class.java)
            return (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
                manager.areNotificationsEnabled() && manager.getNotificationChannel(ALERT_CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE
        }

        fun start(context: Context) {
            createChannels(context)
            if (PriceAlertStore.enabled(context) && notificationsAllowed(context)) {
                try { ContextCompat.startForegroundService(context, Intent(context, PriceAlertService::class.java)) }
                catch (_: Exception) { PriceAlertStore.error = "Open the app to resume monitoring." }
            }
        }

        private fun openApp(context: Context) = PendingIntent.getActivity(context, 1, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        internal fun deliver(context: Context, alert: JSONObject) {
            check(notificationsAllowed(context)) { "Notifications disabled" }
            context.getSystemService(NotificationManager::class.java).notify(alert.getString("id"), 7101,
                NotificationCompat.Builder(context, ALERT_CHANNEL)
                    .setSmallIcon(R.drawable.ic_price_alert)
                    .setContentTitle(alert.getString("title"))
                    .setContentText(alert.getString("body"))
                    .setStyle(NotificationCompat.BigTextStyle().bigText(alert.getString("body")))
                    .setContentIntent(openApp(context)).setAutoCancel(true).setOnlyAlertOnce(true)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setCategory(NotificationCompat.CATEGORY_EVENT)
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build())
        }
    }
}

class PriceAlertBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) PriceAlertService.start(context)
    }
}
