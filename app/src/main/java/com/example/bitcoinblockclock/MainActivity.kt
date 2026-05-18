package com.example.bitcoinblockclock

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.content.Context

class MainActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val myWebView: WebView = findViewById(R.id.webview)

        myWebView.addJavascriptInterface(WebAppInterface(this), "Android")
        configureClockWebView(myWebView)
    }
}

internal fun configureClockWebView(webView: WebView) {
    with(webView.settings) {
        javaScriptEnabled = true
        domStorageEnabled = true
        allowFileAccess = true
        allowFileAccessFromFileURLs = true
        allowUniversalAccessFromFileURLs = true
    }

    webView.loadUrl("file:///android_asset/clock.html")
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
