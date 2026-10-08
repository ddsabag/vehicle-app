# Methods the page calls through the WebView bridge are found by name at run time
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface

# WorkManager re-creates the worker from its class name
-keep class com.ddsabag.pratirechev.SavedCheckWorker { <init>(...); }

# readable stack traces in Play Console crash reports
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
