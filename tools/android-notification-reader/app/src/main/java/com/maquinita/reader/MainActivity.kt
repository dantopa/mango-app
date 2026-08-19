package com.maquinita.reader

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings as AndroidSettings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Single screen: configure the endpoint, grant notification access, check status. */
class MainActivity : Activity() {

    private lateinit var settings: Settings
    private lateinit var endpointField: EditText
    private lateinit var tokenField: EditText
    private lateinit var statusView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        settings = Settings(this)
        endpointField = findViewById(R.id.endpoint)
        tokenField = findViewById(R.id.token)
        statusView = findViewById(R.id.status)

        endpointField.setText(settings.endpoint)
        tokenField.setText(settings.token)

        findViewById<Button>(R.id.save).setOnClickListener { save() }
        findViewById<Button>(R.id.grantAccess).setOnClickListener {
            startActivity(Intent(AndroidSettings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        findViewById<Button>(R.id.sendTest).setOnClickListener { sendTest() }
        findViewById<Button>(R.id.refresh).setOnClickListener { refreshStatus() }
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
    }

    private fun save() {
        val endpoint = endpointField.text.toString().trim()
        val token = tokenField.text.toString().trim()

        if (!endpoint.startsWith("https://")) {
            toast(getString(R.string.invalid_endpoint))
            return
        }
        if (token.isEmpty()) {
            toast(getString(R.string.missing_token))
            return
        }

        settings.endpoint = endpoint
        settings.token = token
        toast(getString(R.string.saved))

        // Anything queued while the app was misconfigured can go out now.
        UploadWorker.enqueue(applicationContext)
        refreshStatus()
    }

    /**
     * Uses a package the server does not whitelist, so a successful round trip
     * proves the URL and the token without inventing a transaction: the server
     * answers 200 {"status":"ignored"} after the auth check passes.
     */
    private fun sendTest() {
        if (!settings.isConfigured) {
            toast(getString(R.string.invalid_endpoint))
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
        Handler(Looper.getMainLooper()).postDelayed({ refreshStatus() }, 2000)
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
            "acceso a notificaciones: " + if (listenerEnabled) "activo" else "NO ACTIVO",
            "configuración: " + if (settings.isConfigured) "ok" else "incompleta",
            "pendientes en cola: ${IngestQueue.size(applicationContext)}",
            "último envío: $lastResult",
        ).joinToString("\n")
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    private companion object {
        val TIME_FORMAT = SimpleDateFormat("dd/MM HH:mm", Locale.getDefault())
    }
}
