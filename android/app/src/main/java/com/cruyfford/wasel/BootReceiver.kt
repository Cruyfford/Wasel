package com.cruyfford.wasel

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val p = WaselService.prefs(ctx)
        if (p.getBoolean("msgN", true) || p.getBoolean("callN", true)) WaselService.start(ctx)
    }
}
