package com.bitcoinblockclock

import android.webkit.JavascriptInterface

class PriceAlertBridge(private val activity: MainActivity) {
    @JavascriptInterface fun status() = PriceAlertStore.status(activity)
    @JavascriptInterface fun setEnabled(enabled: Boolean) {
        activity.runOnUiThread { activity.setPriceAlertsEnabled(enabled) }
    }
}
