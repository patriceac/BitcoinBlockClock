package com.bitcoinblockclock

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.compose.setContent
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

class MainActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.BLACK
        window.navigationBarColor = Color.BLACK

        if (isWearDevice()) {
            setContent {
                WearClockApp()
            }
            return
        }

        val isAutomotive = isAutomotiveDevice()
        setContentView(R.layout.activity_main)
        if (isAutomotive) {
            enterImmersiveCarMode()
        }

        val myWebView: WebView = findViewById(R.id.webview)

        myWebView.addJavascriptInterface(WebAppInterface(this), "Android")
        myWebView.setBackgroundColor(Color.BLACK)
        configureClockWebView(myWebView, isAutomotive)
    }
}

private fun Context.isWearDevice(): Boolean {
    val uiMode = resources.configuration.uiMode and Configuration.UI_MODE_TYPE_MASK
    return uiMode == Configuration.UI_MODE_TYPE_WATCH
        || packageManager.hasSystemFeature(PackageManager.FEATURE_WATCH)
}

private fun Context.isAutomotiveDevice(): Boolean {
    val uiMode = resources.configuration.uiMode and Configuration.UI_MODE_TYPE_MASK
    return uiMode == Configuration.UI_MODE_TYPE_CAR
        || packageManager.hasSystemFeature(PackageManager.FEATURE_AUTOMOTIVE)
}

private fun AppCompatActivity.enterImmersiveCarMode() {
    window.statusBarColor = Color.BLACK
    window.navigationBarColor = Color.BLACK

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        window.setDecorFitsSystemWindows(false)
        window.decorView.post {
            window.decorView.windowInsetsController?.apply {
                hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        }
    } else {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            )
    }
}

private enum class WearLoadState {
    Loading,
    Fresh,
    Stale,
    Offline
}

private data class WearClockMetrics(
    val priceUsd: String = "Loading...",
    val priceEur: String = "EUR loading...",
    val priceChange: String = "Live",
    val blockHeight: String = "Loading...",
    val nextHalving: String = "Loading...",
    val halvingPercent: String = "Loading...",
    val halvingProgress: Float = 0f,
    val feeRate: String = "Loading...",
    val hashRate: String = "Loading...",
    val updatedAt: String = "--:--",
    val loadState: WearLoadState = WearLoadState.Loading
)

@Composable
private fun WearClockApp() {
    var metrics by remember { mutableStateOf(WearClockMetrics()) }
    var pageIndex by remember { mutableIntStateOf(0) }
    var dragAmount by remember { mutableFloatStateOf(0f) }
    val refreshScope = rememberCoroutineScope()
    val context = LocalContext.current

    fun refreshMetrics() {
        refreshScope.launch {
            metrics = metrics.copy(loadState = WearLoadState.Loading)
            metrics = loadWearMetrics(context, metrics)
        }
    }

    LaunchedEffect(Unit) {
        while (isActive) {
            metrics = metrics.copy(loadState = WearLoadState.Loading)
            metrics = loadWearMetrics(context, metrics)
            delay(60_000)
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(WearBlack)
            .pointerInput(Unit) {
                detectVerticalDragGestures(
                    onVerticalDrag = { _, drag ->
                        dragAmount += drag
                    },
                    onDragEnd = {
                        if (dragAmount < -34f) {
                            pageIndex = min(2, pageIndex + 1)
                        } else if (dragAmount > 34f) {
                            pageIndex = max(0, pageIndex - 1)
                        }
                        dragAmount = 0f
                    },
                    onDragCancel = {
                        dragAmount = 0f
                    }
                )
            }
    ) {
        when (pageIndex) {
            0 -> WearPriceFace(metrics)
            1 -> WearBlockFace(metrics)
            else -> WearNetworkFace(metrics)
        }
    }
}

@Composable
private fun WearPriceFace(metrics: WearClockMetrics) {
    WearFaceShell {
        PriceTickRing()
        WearCenteredStack(offsetY = (-6).dp) {
            WearBrand()
            WearLabel("BTC")
            WearValue(metrics.priceUsd, fontSize = 31.sp)
            WearTonePill(metrics.priceChange)
            WearFooter(metrics.footerText())
        }
    }
}

@Composable
private fun WearBlockFace(metrics: WearClockMetrics) {
    WearFaceShell {
        OuterSoftRing()
        WearCenteredStack(offsetY = (-10).dp) {
            WearBrand()
            WearLabel("BLOCK")
            WearValue(metrics.blockHeight, fontSize = 36.sp)
            Spacer(modifier = Modifier.height(12.dp))
            WearMutedLabel("NEXT")
            MiniRing()
        }
    }
}

@Composable
private fun WearNetworkFace(metrics: WearClockMetrics) {
    WearFaceShell {
        ProgressRing(progress = metrics.halvingProgress)
        WearCenteredStack(offsetY = (-5).dp) {
            WearBrand()
            WearLabel("HALVING")
            WearValue(metrics.halvingPercent, fontSize = 42.sp)
            WearDivider()
            WearLabel("FEES")
            WearFeeValue(metrics.feeRate)
        }
    }
}

@Composable
private fun WearFaceShell(content: @Composable () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(WearBlack)
            .padding(16.dp),
        contentAlignment = Alignment.Center
    ) {
        content()
    }
}

@Composable
private fun WearCenteredStack(
    offsetY: androidx.compose.ui.unit.Dp = 0.dp,
    content: @Composable ColumnScope.() -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth(0.76f)
            .offset(y = offsetY),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
        content = content
    )
}

@Composable
private fun WearBrand() {
    BasicText(
        text = "\u20BF",
        style = TextStyle(
            color = WearOrange,
            fontSize = 27.sp,
            fontWeight = FontWeight.Black,
            textAlign = TextAlign.Center
        )
    )
}

@Composable
private fun WearLabel(text: String) {
    BasicText(
        text = text,
        style = TextStyle(
            color = WearOrange,
            fontSize = 16.sp,
            fontWeight = FontWeight.ExtraBold,
            textAlign = TextAlign.Center
        )
    )
}

@Composable
private fun WearMutedLabel(text: String) {
    BasicText(
        text = text,
        maxLines = 1,
        style = TextStyle(
            color = WearMuted,
            fontSize = 15.sp,
            fontWeight = FontWeight.Black,
            textAlign = TextAlign.Center
        )
    )
}

@Composable
private fun WearValue(text: String, fontSize: androidx.compose.ui.unit.TextUnit) {
    BasicText(
        text = text,
        maxLines = 1,
        overflow = TextOverflow.Clip,
        style = TextStyle(
            color = WearWhite,
            fontFamily = FontFamily.SansSerif,
            fontSize = fontSize,
            fontWeight = FontWeight.Black,
            textAlign = TextAlign.Center
        )
    )
}

@Composable
private fun WearFooter(text: String) {
    Spacer(modifier = Modifier.height(7.dp))
    BasicText(
        text = text,
        maxLines = 1,
        overflow = TextOverflow.Clip,
        style = TextStyle(
            color = WearMuted,
            fontSize = 18.sp,
            fontWeight = FontWeight.ExtraBold,
            textAlign = TextAlign.Center
        )
    )
}

@Composable
private fun WearTonePill(text: String) {
    val isNegative = text.startsWith("-")
    val isNeutral = !text.contains("+") && !text.startsWith("-")
    val foreground = when {
        isNegative -> WearRed
        isNeutral -> WearMuted
        else -> WearGreen
    }
    val background = when {
        isNegative -> WearRed.copy(alpha = 0.18f)
        isNeutral -> WearWhite.copy(alpha = 0.12f)
        else -> WearGreen.copy(alpha = 0.16f)
    }

    Spacer(modifier = Modifier.height(7.dp))
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(background)
            .padding(horizontal = 15.dp, vertical = 7.dp),
        contentAlignment = Alignment.Center
    ) {
        BasicText(
            text = text,
            maxLines = 1,
            style = TextStyle(
                color = foreground,
                fontSize = 17.sp,
                fontWeight = FontWeight.ExtraBold,
                textAlign = TextAlign.Center
            )
        )
    }
    Spacer(modifier = Modifier.height(8.dp))
}

@Composable
private fun WearDivider() {
    Box(
        modifier = Modifier
            .padding(vertical = 6.dp)
            .fillMaxWidth(0.72f)
            .height(1.dp)
            .background(WearWhite.copy(alpha = 0.16f))
    )
}

@Composable
private fun WearFeeValue(text: String) {
    val number = text.substringBefore(" ").takeIf { it.isNotBlank() } ?: text
    val unit = text.removePrefix(number).trim()

    Row(
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.Bottom
    ) {
        BasicText(
            text = number,
            maxLines = 1,
            style = TextStyle(
                color = WearRed,
                fontSize = 20.sp,
                fontWeight = FontWeight.Black,
                textAlign = TextAlign.Center
            )
        )
        if (unit.isNotBlank()) {
            BasicText(
                text = " $unit",
                maxLines = 1,
                style = TextStyle(
                    color = WearMuted,
                    fontSize = 19.sp,
                    fontWeight = FontWeight.Black,
                    textAlign = TextAlign.Center
                )
            )
        }
    }
}

@Composable
private fun WearSecondary(label: String, value: String? = null, accent: androidx.compose.ui.graphics.Color = WearWhite) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        BasicText(
            text = label,
            maxLines = 1,
            style = TextStyle(
                color = WearMuted,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center
            )
        )
        if (value != null) {
            BasicText(
                text = value,
                maxLines = 1,
                overflow = TextOverflow.Clip,
                style = TextStyle(
                    color = accent,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.ExtraBold,
                    textAlign = TextAlign.Center
                )
            )
        }
    }
}

@Composable
private fun MiniRing() {
    Box(
        modifier = Modifier
            .padding(top = 2.dp)
            .size(62.dp),
        contentAlignment = Alignment.Center
    ) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val stroke = Stroke(width = 7.dp.toPx(), cap = StrokeCap.Round)
            drawArc(WearWhite.copy(alpha = 0.15f), 118f, 132f, false, style = stroke)
            drawArc(WearOrange, -42f, 250f, false, style = stroke)

            val center = Offset(size.width / 2f, size.height / 2f)
            val iconRadius = size.minDimension * 0.16f
            drawCircle(
                color = WearOrange,
                radius = iconRadius,
                style = Stroke(width = 3.dp.toPx())
            )
            drawLine(
                color = WearOrange,
                start = center,
                end = Offset(center.x, center.y - iconRadius * 0.62f),
                strokeWidth = 2.4.dp.toPx(),
                cap = StrokeCap.Round
            )
            drawLine(
                color = WearOrange,
                start = center,
                end = Offset(center.x + iconRadius * 0.52f, center.y + iconRadius * 0.36f),
                strokeWidth = 2.4.dp.toPx(),
                cap = StrokeCap.Round
            )
        }
    }
}

@Composable
private fun WearStatusPill(
    metrics: WearClockMetrics,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val label = when (metrics.loadState) {
        WearLoadState.Loading -> if (metrics.priceUsd == "Loading...") "Loading" else "Syncing"
        WearLoadState.Fresh -> "Fresh"
        WearLoadState.Stale -> "Stale"
        WearLoadState.Offline -> "Offline"
    }
    val color = when (metrics.loadState) {
        WearLoadState.Fresh -> WearGreen
        WearLoadState.Stale,
        WearLoadState.Offline -> WearRed
        WearLoadState.Loading -> WearWhite.copy(alpha = 0.78f)
    }

    Box(
        modifier = modifier
            .clip(RoundedCornerShape(999.dp))
            .background(WearBlack.copy(alpha = 0.76f))
            .clickable(onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center
    ) {
        BasicText(
            text = label,
            style = TextStyle(
                color = color,
                fontSize = 13.sp,
                fontWeight = FontWeight.ExtraBold,
                textAlign = TextAlign.Center
            )
        )
    }
}

@Composable
private fun WearPageDots(currentPage: Int, modifier: Modifier = Modifier) {
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(5.dp)) {
        repeat(3) { index ->
            Box(
                modifier = Modifier
                    .size(if (index == currentPage) 6.dp else 4.dp)
                    .clip(CircleShape)
                    .background(if (index == currentPage) WearOrange else WearWhite.copy(alpha = 0.22f))
            )
        }
    }
}

@Composable
private fun PriceTickRing() {
    Canvas(modifier = Modifier.fillMaxSize()) {
        val center = Offset(size.width / 2f, size.height / 2f)
        val radius = size.minDimension * 0.42f
        repeat(36) { index ->
            if (index % 9 == 0) return@repeat
            val angle = ((index * 10f) - 90f) * (PI.toFloat() / 180f)
            val inner = radius - 8.dp.toPx()
            val outer = radius
            val start = Offset(center.x + cos(angle) * inner, center.y + sin(angle) * inner)
            val end = Offset(center.x + cos(angle) * outer, center.y + sin(angle) * outer)
            drawLine(
                color = WearWhite.copy(alpha = 0.22f),
                start = start,
                end = end,
                strokeWidth = 1.3.dp.toPx(),
                cap = StrokeCap.Round
            )
        }
    }
}

@Composable
private fun OuterSoftRing() {
    Canvas(modifier = Modifier.fillMaxSize()) {
        drawCircle(
            color = WearOrange.copy(alpha = 0.13f),
            radius = size.minDimension * 0.43f,
            style = Stroke(width = 1.dp.toPx())
        )
    }
}

@Composable
private fun ProgressRing(progress: Float) {
    Canvas(modifier = Modifier.fillMaxSize()) {
        val stroke = Stroke(width = 8.dp.toPx(), cap = StrokeCap.Round)
        val diameter = size.minDimension * 0.9f
        val left = (size.width - diameter) / 2f
        val top = (size.height - diameter) / 2f
        drawArc(
            color = WearWhite.copy(alpha = 0.18f),
            startAngle = -90f,
            sweepAngle = 360f,
            useCenter = false,
            topLeft = Offset(left, top),
            size = androidx.compose.ui.geometry.Size(diameter, diameter),
            style = stroke
        )
        drawArc(
            brush = Brush.sweepGradient(listOf(WearOrange, WearOrange.copy(alpha = 0.75f), WearOrange)),
            startAngle = -90f,
            sweepAngle = progress.coerceIn(0f, 1f) * 360f,
            useCenter = false,
            topLeft = Offset(left, top),
            size = androidx.compose.ui.geometry.Size(diameter, diameter),
            style = stroke
        )
    }
}

private suspend fun loadWearMetrics(context: Context, previous: WearClockMetrics): WearClockMetrics {
    val snapshot = BitcoinClockDataSource.loadSnapshot(context)
    return snapshot.toWearClockMetrics(previous)
}

private fun BitcoinClockSnapshot.toWearClockMetrics(previous: WearClockMetrics): WearClockMetrics {
    val loadState = when (freshness) {
        BitcoinClockFreshness.Fresh -> WearLoadState.Fresh
        BitcoinClockFreshness.Stale -> WearLoadState.Stale
        BitcoinClockFreshness.Offline -> if (previous.priceUsd == "Loading...") {
            WearLoadState.Offline
        } else {
            WearLoadState.Stale
        }
    }

    if (freshness == BitcoinClockFreshness.Offline && previous.priceUsd != "Loading...") {
        return previous.copy(loadState = loadState)
    }

    return WearClockMetrics(
        priceUsd = priceUsd,
        priceEur = priceEur,
        priceChange = priceChange,
        blockHeight = blockHeight,
        nextHalving = nextHalving,
        halvingPercent = halvingPercent,
        halvingProgress = halvingProgress,
        feeRate = feeRate,
        hashRate = hashRate,
        updatedAt = updatedAt,
        loadState = loadState
    )
}

private fun WearClockMetrics.footerText(): String {
    return when (loadState) {
        WearLoadState.Loading -> if (updatedAt == "--:--") "Loading" else updatedAt
        WearLoadState.Fresh -> updatedAt
        WearLoadState.Stale -> "Stale"
        WearLoadState.Offline -> "Offline"
    }
}

private val WearBlack = androidx.compose.ui.graphics.Color(0xFF000000)
private val WearWhite = androidx.compose.ui.graphics.Color(0xFFF8FAFC)
private val WearMuted = androidx.compose.ui.graphics.Color(0x99EEF2F6)
private val WearOrange = androidx.compose.ui.graphics.Color(0xFFF6A21F)
private val WearGreen = androidx.compose.ui.graphics.Color(0xFF7EFF80)
private val WearRed = androidx.compose.ui.graphics.Color(0xFFFF6464)

internal fun configureClockWebView(webView: WebView, carMode: Boolean = false) {
    with(webView.settings) {
        javaScriptEnabled = true
        domStorageEnabled = true
        allowFileAccess = true
        allowFileAccessFromFileURLs = true
        allowUniversalAccessFromFileURLs = true
    }

    val surface = if (carMode) "?surface=car" else ""
    webView.loadUrl("file:///android_asset/clock.html$surface")
}

class WebAppInterface(private val mContext: Context) {
    @JavascriptInterface
    fun openScreensaverSettings() {
        val intent = Intent()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR2) {
            intent.action = "android.settings.DREAM_SETTINGS"
        } else {
            intent.action = Settings.ACTION_DISPLAY_SETTINGS
        }
        if (intent.resolveActivity(mContext.packageManager) != null) {
            mContext.startActivity(intent)
        } else {
            Toast.makeText(mContext, "Screensaver settings not found.", Toast.LENGTH_SHORT).show()
        }
    }
}
