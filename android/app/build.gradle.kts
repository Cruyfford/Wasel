plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val serverUrl = (project.findProperty("serverUrl") as String?) ?: ""
val nativeRev = (project.findProperty("nativeRev") as String?) ?: ""

android {
    namespace = "com.cruyfford.wasel"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.cruyfford.wasel"
        minSdk = 24
        targetSdk = 34
        versionCode = 4
        versionName = "4.0"
        buildConfigField("String", "SERVER_URL", "\"$serverUrl\"")
        buildConfigField("String", "NATIVE_REV", "\"$nativeRev\"")
    }
    signingConfigs {
        create("release") {
            storeFile = file("wasel.jks")
            storePassword = "wasel123"
            keyAlias = "wasel"
            keyPassword = "wasel123"
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
