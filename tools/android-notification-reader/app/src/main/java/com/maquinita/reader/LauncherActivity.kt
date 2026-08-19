package com.maquinita.reader

import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import androidx.core.app.NotificationManagerCompat
import com.google.androidbrowserhelper.trusted.LauncherActivity as TwaLauncherActivity

/**
 * Opens the dashboard, but not before saying something if the sensor is off.
 *
 * The warning has to live here rather than in the web app: notification-listener
 * access and the paired token are Android state, and Chrome exposes neither to
 * the page it renders. This is the only code in the product that can see both,
 * and it runs on every launch, which is exactly when it matters — a dashboard
 * that silently stopped receiving expenses looks identical to one with no
 * expenses to show.
 */
class LauncherActivity : TwaLauncherActivity() {

    /** Checked by the parent's onCreate: false keeps the TWA from starting. */
    override fun shouldLaunchImmediately(): Boolean = sensorProblem() == null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Opening the dashboard is the most frequent thing that happens to this app,
        // so it is also the cheapest place to make sure the watchdog is running.
        SensorService.start(this)
        val problem = sensorProblem() ?: return
        warn(problem)
    }

    /** The first thing that is missing, or null when the sensor is ready. */
    private fun sensorProblem(): String? = when {
        !Settings(this).isConfigured -> getString(R.string.sensor_not_paired)
        packageName !in NotificationManagerCompat.getEnabledListenerPackages(this) ->
            getString(R.string.sensor_no_access)
        else -> null
    }

    private fun warn(problem: String) {
        AlertDialog.Builder(this)
            .setTitle(R.string.sensor_warning_title)
            .setMessage(problem)
            .setPositiveButton(R.string.sensor_fix) { _, _ ->
                // Finishing instead of returning here: the parent decides when to
                // launch the TWA, and re-entering it from a resumed launcher is not
                // something it supports. Tapping the icon again opens the dashboard.
                startActivity(Intent(this, MainActivity::class.java))
                finish()
            }
            .setNegativeButton(R.string.sensor_ignore) { _, _ -> launchTwa() }
            // Dismissing is a third answer — neither fix nor continue — so it closes.
            .setOnCancelListener { finish() }
            .show()
    }
}
