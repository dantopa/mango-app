plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

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

    buildTypes {
        release {
            isMinifyEnabled = false
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
}
