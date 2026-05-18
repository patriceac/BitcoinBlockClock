package com.example.bitcoinblockclock

import android.service.dreams.DreamService
import android.webkit.WebView

class ClockDreamService : DreamService() {

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()

        setContentView(R.layout.dream_layout)

        val myWebView: WebView = findViewById(R.id.dream_webview)
        myWebView.addJavascriptInterface(WebAppInterface(this), "Android")
        configureClockWebView(myWebView)

        isInteractive = false

        isFullscreen = true
    }
}
