plugins {
    id("com.android.application")
}

// Firebase Analytics is switched on only when the project's google-services.json is present (added by CI from a secret)
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

android {
    namespace = "com.ddsabag.pratirechev"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.ddsabag.pratirechev"
        minSdk = 26
        targetSdk = 36
        versionCode = (project.findProperty("versionCode") as String?)?.toInt() ?: 1
        versionName = (project.findProperty("versionName") as String?) ?: "1.0"
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

    // The web app at the repo root is the single source of the UI
    sourceSets["main"].assets.srcDirs("build/generated/webassets")
}

val copyWebApp by tasks.registering(Copy::class) {
    // release builds in CI minify the page first (.github/scripts/obfuscate.mjs); otherwise the source is used
    from(rootProject.file("build-web/index.html").takeIf { it.exists() } ?: rootProject.file("../index.html"))
    from(rootProject.file("../market.json"))   // bundled copy, used when the site copy cannot be fetched
    from(rootProject.file("../modelstats.json"))
    from(rootProject.file("../service.json"))
    into(layout.buildDirectory.dir("generated/webassets"))
}
tasks.named("preBuild") { dependsOn(copyWebApp) }

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.core:core:1.13.1")
    implementation("androidx.work:work-runtime:2.9.1")
    implementation("com.google.android.play:review:2.0.2")
    implementation("com.android.installreferrer:installreferrer:2.2")
    implementation("com.android.billingclient:billing:8.0.0")
    implementation("androidx.fragment:fragment:1.8.5")
    implementation("androidx.activity:activity:1.9.3")
    implementation(platform("com.google.firebase:firebase-bom:33.5.1"))
    implementation("com.google.firebase:firebase-analytics")
}
