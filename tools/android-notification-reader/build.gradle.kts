plugins {
    // 8.7.x is the first line tested against compileSdk 35; 8.5.2 warned that the
    // combination was unsupported. Needs Gradle 8.9+, pinned in the wrapper.
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
