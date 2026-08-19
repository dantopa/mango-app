package com.maquinita.reader

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Brings the sensor back after a reboot.
 *
 * The system rebinds the notification listener on its own, but the watchdog and
 * its status notification would stay down until the app was next opened — which
 * is precisely when nobody would notice the sensor had been off since the reboot.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        SensorService.start(context)
    }
}
