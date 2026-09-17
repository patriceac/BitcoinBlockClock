package com.bitcoinblockclock

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.net.Network
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.coroutines.coroutineContext

/** Short, OS-scheduled checks. No foreground service or routine notification. */
class PriceAlertService : JobService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var task: Job? = null

    override fun onStartJob(params: JobParameters): Boolean {
        task = scope.launch {
            checkPrice(applicationContext, if (Build.VERSION.SDK_INT >= 28) params.network else null)
            jobFinished(params, false)
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        task?.cancel()
        return true
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val ALERT_CHANNEL = "bitcoin-price-movements"
        const val ACTION_OPEN_DASHBOARD = "com.bitcoinblockclock.OPEN_DASHBOARD"
        const val JOB_ID = 7100
        const val CHECK_INTERVAL_MS = PriceAlertSchedule.INTERVAL_MS
        private val checkMutex = Mutex()

        fun createChannels(context: Context) {
            val manager = context.getSystemService(NotificationManager::class.java)
            // Remove the standing status notification/channel created by v1.1.0.
            manager.cancel(7100)
            manager.deleteNotificationChannel("bitcoin-price-monitor")
            manager.createNotificationChannel(NotificationChannel(ALERT_CHANNEL, "Bitcoin price movements", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Meaningful price movements only: ±2% and $5,000 crossings."
            })
        }

        fun notificationsAllowed(context: Context): Boolean {
            val manager = context.getSystemService(NotificationManager::class.java)
            return (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
                manager.areNotificationsEnabled() && manager.getNotificationChannel(ALERT_CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE
        }

        fun start(context: Context) {
            createChannels(context)
            val scheduler = context.getSystemService(JobScheduler::class.java)
            if (!PriceAlertStore.enabled(context) || !notificationsAllowed(context)) {
                scheduler.cancel(JOB_ID)
                return
            }
            // Preserve hourly jobs on reopen, but migrate an older polling interval.
            if (scheduler.getPendingJob(JOB_ID)?.intervalMillis != CHECK_INTERVAL_MS) {
                val job = JobInfo.Builder(JOB_ID, ComponentName(context, PriceAlertService::class.java))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPeriodic(CHECK_INTERVAL_MS)
                    .setPersisted(true)
                    .build()
                if (scheduler.schedule(job) != JobScheduler.RESULT_SUCCESS) PriceAlertStore.error = "Background checks could not be scheduled."
            }
        }

        fun stop(context: Context) { context.getSystemService(JobScheduler::class.java).cancel(JOB_ID) }

        suspend fun checkPrice(context: Context, network: Network? = null) = withContext(Dispatchers.IO) {
            checkMutex.withLock {
                if (!PriceAlertStore.enabled(context) || !notificationsAllowed(context)) return@withLock
                try {
                    // The activity and background job share one hourly cadence.
                    if (!PriceAlertStore.claimCheck(context)) return@withLock
                    PriceAlertStore.deliverPending(context)
                    val price = fetchPrice(network)
                    coroutineContext.ensureActive()
                    PriceAlertStore.accept(context, price)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    PriceAlertStore.error = "Monitoring interrupted. The next scheduled check will retry."
                }
            }
        }

        private fun fetchPrice(network: Network?): Double {
            val url = URL("https://api.kraken.com/0/public/Ticker?pair=XBTUSD")
            val connection = (network?.openConnection(url) ?: url.openConnection()) as HttpURLConnection
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

        private fun openApp(context: Context) = PendingIntent.getActivity(context, 1,
            Intent(context, MainActivity::class.java).setAction(ACTION_OPEN_DASHBOARD)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

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
