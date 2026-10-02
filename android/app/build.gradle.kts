plugins {
    id("com.android.application")
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
    from(rootProject.file("../index.html"))
    into(layout.buildDirectory.dir("generated/webassets"))
}
tasks.named("preBuild") { dependsOn(copyWebApp) }

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}
