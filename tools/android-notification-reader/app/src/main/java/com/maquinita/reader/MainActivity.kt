package com.maquinita.reader

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings as AndroidSettings
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Sensor setup: pair the phone, grant notification access, check the status. */
class MainActivity : Activity() {

    private lateinit var settings: Settings
    private lateinit var statusView: TextView
    private lateinit var pairButton: Button
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        settings = Settings(this)
        statusView = findViewById(R.id.status)
        pairButton = findViewById(R.id.pair)

        pairButton.setOnClickListener { pair() }
        findViewById<Button>(R.id.grantAccess).setOnClickListener {
            startActivity(Intent(AndroidSettings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        findViewById<Button>(R.id.sendTest).setOnClickListener { sendTest() }
        findViewById<Button>(R.id.refresh).setOnClickListener { refreshStatus() }

        askForNotifications()
    }

    override fun onResume() {
        super.onResume()
        // Every visit to this screen is also a chance to restore the watchdog, in
        // case the system dropped its schedule while the app was away.
        SensorWatchdog.schedule(this)
        refreshStatus()
    }

    /**
     * The watchdog runs either way, but on API 33+ its warning — the only thing that
     * says the sensor lost its access — is dropped without this permission.
     */
    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        ) return

        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
    }

    /**
     * Enrols off the main thread, then hands the pairing URL to the browser, which
     * is where the session lives. Nothing is typed and nothing secret is shown.
     */
    private fun pair() {
        pairButton.isEnabled = false
        toast(getString(R.string.pairing_started))

        Thread {
            val result = runCatching { Pairing.enroll(this, settings) }
            mainHandler.post {
                pairButton.isEnabled = true
                result.fold(
                    onSuccess = { startActivity(Intent(Intent.ACTION_VIEW, it)) },
                    onFailure = { error ->
                        val reason = (error as? IOException)?.message ?: error.toString()
                        toast(getString(R.string.pairing_failed, reason))
                    },
                )
                refreshStatus()
            }
        }.start()
    }

    /**
     * Uses a package the server does not whitelist, so a successful round trip
     * proves the token was approved without inventing a transaction: the server
     * answers 200 {"status":"ignored"} after the auth check passes. An unapproved
     * token answers 401, which is what distinguishes "enrolled" from "paired".
     */
    private fun sendTest() {
        if (!settings.isConfigured) {
            toast(getString(R.string.not_paired))
            return
        }
        val payload = JSONObject()
            .put("packageName", "com.maquinita.reader.test")
            .put("title", "Maquinita Reader")
            .put("text", "prueba de conexión")
            .put("timestamp", System.currentTimeMillis())

        IngestQueue.add(applicationContext, payload.toString())
        UploadWorker.enqueue(applicationContext)
        toast(getString(R.string.test_queued))
        mainHandler.postDelayed({ refreshStatus() }, 2000)
    }

    private fun refreshStatus() {
        val listenerEnabled = packageName in NotificationManagerCompat.getEnabledListenerPackages(this)
        val lastAt = settings.lastResultAt
        val lastResult = if (settings.lastResult.isEmpty()) {
            "todavía no se envió nada"
        } else {
            "${settings.lastResult} · ${TIME_FORMAT.format(Date(lastAt))}"
        }

        statusView.text = listOf(
            "servidor: ${settings.endpoint}",
            "acceso a notificaciones: " + if (listenerEnabled) "activo" else "NO ACTIVO",
            // Access granted is not the same as bound: this is the one that decides
            // whether a purchase notification actually reaches the app.
            "lector conectado: " + if (NotificationReaderService.isConnected) "sí" else "NO",
            "teléfono vinculado: " + if (settings.isConfigured) "sí" else "NO",
            "pendientes en cola: ${IngestQueue.size(applicationContext)}",
            "último envío: $lastResult",
        ).joinToString("\n")
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    private companion object {
        const val REQUEST_NOTIFICATIONS = 1
        val TIME_FORMAT = SimpleDateFormat("dd/MM HH:mm", Locale.getDefault())
    }
}
