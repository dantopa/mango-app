import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/**
 * Signing config lives outside the repo: keystore.properties is gitignored and
 * points at a keystore in ~/.android/. When it is absent (fresh clone, CI) the
 * release variant simply stays unsigned instead of failing the whole build.
 */
val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
val hasReleaseKeystore = keystoreProperties.getProperty("storeFile") != null

android {
    namespace = "com.maquinita.reader"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.maquinita.reader"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    // Retries the upload with backoff and network constraints, so a purchase made
    // offline is not lost.
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    // Trusted Web Activity host. This is what Bubblewrap generates under the hood:
    // Chrome renders the PWA full screen, so the web push and the session are the
    // browser's — a plain WebView supports neither.
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.5.0")
}
