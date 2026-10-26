package com.ddsabag.pratirechev;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.provider.CalendarContract;
import android.provider.MediaStore;
import android.speech.RecognizerIntent;
import android.text.TextUtils;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import com.google.android.play.core.appupdate.AppUpdateInfo;
import com.google.android.play.core.appupdate.AppUpdateManager;
import com.google.android.play.core.appupdate.AppUpdateManagerFactory;
import com.google.android.play.core.appupdate.AppUpdateOptions;
import com.google.android.play.core.install.InstallStateUpdatedListener;
import com.google.android.play.core.install.model.AppUpdateType;
import com.google.android.play.core.install.model.InstallStatus;
import com.google.android.play.core.install.model.UpdateAvailability;
import com.google.android.play.core.review.ReviewInfo;
import com.google.android.play.core.review.ReviewManager;
import com.google.android.play.core.review.ReviewManagerFactory;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/assets/index.html";

    private static final int REQ_FILE = 1;
    private static final int REQ_VOICE = 2;
    private static final int REQ_NOTIFY = 3;
    private static final int REQ_CAMERA = 4;
    private static final int REQ_UPDATE = 5;

    private AppUpdateManager updateManager;
    private AppUpdateInfo updateInfo;
    private InstallStateUpdatedListener updateListener;

    private boolean pageReady = false;
    private static long lastRendererGone = 0;
    private final java.util.List<String> pendingJs = new java.util.ArrayList<>();   // every script queued before the page loads runs, in order

    private WebView webView;
    private FrameLayout root;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;

    // the page's colours (index.html's tokens; app-wiring.mjs keeps them equal): --bg, --band-tint at the top of home, and the bottom bar
    // (--card at 90% over --bg). The window shows them from the first frame, until the page sends the colours of its own edges (setBars)
    static final int PAGE_LIGHT = 0xFFF2F4F8, TOP_LIGHT = 0xFFE2ECFD, BOTTOM_LIGHT = 0xFFFEFEFE;
    static final int PAGE_DARK = 0xFF0E121A, TOP_DARK = 0xFF182338, BOTTOM_DARK = 0xFF1B212E;
    private final BarsDrawable bars = new BarsDrawable();
    private volatile boolean systemNight;   // the phone's dark mode, which the page's "לפי המכשיר" follows
    private boolean dark;                   // the page is dark: its choice, or the phone's under "לפי המכשיר"

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // the look the page chose, before the window is made: the window, the WebView's prefers-color-scheme and the first frame follow it
        systemNight = night(getResources().getConfiguration());
        String mode = themeMode();
        if ("dark".equals(mode)) setTheme(R.style.AppTheme_Dark);
        else if ("auto".equals(mode)) setTheme(R.style.AppTheme_DayNight);
        dark = isDark(mode);
        super.onCreate(savedInstanceState);
        initAnalytics();
        // shared pictures and PDFs are temporary: drop the ones older than a day
        try {
            File[] old = sharedDir().listFiles();
            if (old != null) for (File f : old) if (System.currentTimeMillis() - f.lastModified() > 24L * 3600 * 1000) f.delete();
        } catch (Exception ignored) {}

        // the root paints nothing: the window's background (BarsDrawable) shows through the bars and, on Android 15, through its padding
        root = new FrameLayout(this);
        // the app guardian drives the page of a debuggable build (build type qa, made only in CI) through the WebView's DevTools;
        // a build for Google Play is never debuggable, so its page cannot be inspected
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        webView = new WebView(this);
        webView.setBackgroundColor(dark ? PAGE_DARK : PAGE_LIGHT);   // until the page has drawn: its own colour, never a white flash
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        getWindow().setBackgroundDrawable(bars);
        paintBars(dark ? TOP_DARK : TOP_LIGHT, dark ? BOTTOM_DARK : BOTTOM_LIGHT);

        // Keep the page clear of the status and navigation bars (edge-to-edge is enforced on new Android versions)
        root.setOnApplyWindowInsetsListener((View v, WindowInsets insets) -> {
            bars.invalidateSelf();   // the bars' strips follow their size (a turn, a cutout)
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                int types = WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime();
                android.graphics.Insets i = insets.getInsets(types);
                v.setPadding(i.left, i.top, i.right, i.bottom);
                return WindowInsets.CONSUMED;
            }
            v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true); // lets the page read the plate photo picked from the camera or gallery

        // Serve the bundled page from an https origin so API calls to data.gov.il pass CORS
        webView.addJavascriptInterface(new Object() {
            /** The look the user chose in the page: light, dark, or auto (the phone's). Kept for the next launch, whose splash follows it */
            @JavascriptInterface
            public void setTheme(String mode) {
                if (!"light".equals(mode) && !"dark".equals(mode) && !"auto".equals(mode)) return;
                runOnUiThread(() -> themeChosen(mode));
            }

            /** The phone's dark mode now: the page's "לפי המכשיר" (the WebView's prefers-color-scheme keeps the mode it opened with) */
            @JavascriptInterface
            public boolean systemDark() {
                return systemNight;
            }

            /** The colours of the page's top and bottom edges (#rrggbb): the status bar and the navigation bar take them */
            @JavascriptInterface
            public void setBars(String top, String bottom) {
                Integer t = rgb(top), b = rgb(bottom);
                if (t == null || b == null) return;
                runOnUiThread(() -> paintBars(t, b));
            }

            /** A silent failure in the page (tag only), recorded as a non-fatal in Crashlytics */
            @JavascriptInterface
            public void logError(String tag) {
                try {
                    if (tag == null || !tag.matches("[a-z][a-z0-9_]{0,59}")) return;
                    com.google.firebase.crashlytics.FirebaseCrashlytics.getInstance().recordException(new RuntimeException("web:" + tag));
                } catch (Throwable ignored) {
                }
            }

            /** Anonymous usage event from the page (no plate, no personal data); ignored when Firebase is not configured */
            @JavascriptInterface
            public void logEvent(String name, String json) {
                try {
                    if (name == null || !name.matches("[a-z][a-z0-9_]{0,39}")) return;
                    android.os.Bundle b = new android.os.Bundle();
                    org.json.JSONObject o = new org.json.JSONObject(json == null ? "{}" : json);
                    java.util.Iterator<String> it = o.keys();
                    int n = 0;
                    while (it.hasNext() && n++ < 8) {
                        String k = it.next();
                        if (!k.matches("[a-z][a-z0-9_]{0,39}")) continue;
                        Object v = o.get(k);
                        if (v instanceof Number) { long lv = ((Number) v).longValue(); if (Math.abs(lv) < 10000) b.putLong(k, lv); }   // counts and flags only, never a plate-sized number
                        else if (v instanceof Boolean) b.putLong(k, ((Boolean) v) ? 1 : 0);
                        else {
                            String sv = String.valueOf(v);
                            // never a plate (5+ digits, with or without separators) or an email
                            if (sv.replaceAll("[^0-9]", "").length() >= 5 || sv.contains("@")) continue;
                            b.putString(k, sv.substring(0, Math.min(sv.length(), 60)));
                        }
                    }
                    com.google.firebase.analytics.FirebaseAnalytics.getInstance(MainActivity.this).logEvent(name, b);
                } catch (Throwable ignored) {
                    // analytics must never break the app
                }
            }

            @JavascriptInterface
            public String readClipboard() {
                try {
                    android.content.ClipboardManager cm = (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    android.content.ClipData d = cm == null ? null : cm.getPrimaryClip();
                    if (d == null || d.getItemCount() == 0) return "";
                    CharSequence t = d.getItemAt(0).coerceToText(MainActivity.this);
                    return t == null ? "" : t.toString();
                } catch (Exception e) { return ""; }
            }

            @JavascriptInterface
            public void setAnalytics(boolean on) {
                try {
                    getSharedPreferences("analytics", MODE_PRIVATE).edit().putBoolean("on", on).apply();   // the next launch switches on before the page loads (initAnalytics)
                    com.google.firebase.analytics.FirebaseAnalytics.getInstance(MainActivity.this).setAnalyticsCollectionEnabled(on && !testLab);
                    com.google.firebase.crashlytics.FirebaseCrashlytics.getInstance().setCrashlyticsCollectionEnabled(on);   // crash reports from pre-launch devices are kept: they find real crashes
                } catch (Throwable ignored) {
                }
            }

            @JavascriptInterface
            public void setLandscape(boolean on) {
                runOnUiThread(() -> setRequestedOrientation(on
                        ? android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                        : android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED));
            }

            @JavascriptInterface
            public void copy(String text) {
                runOnUiThread(() -> {
                    ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("פרטי רכב", text));
                });
            }

            @JavascriptInterface
            public void share(String title, String text) {
                runOnUiThread(() -> {
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType("text/plain");
                    send.putExtra(Intent.EXTRA_SUBJECT, title);
                    send.putExtra(Intent.EXTRA_TEXT, text);
                    startActivity(Intent.createChooser(send, "שיתוף"));
                });
            }

            @JavascriptInterface
            public void shareFile(String name, String mime, String base64, String title) {
                shareFileText(name, mime, base64, title, null);
            }

            /** Same, with a message beside the file (WhatsApp shows it as the caption) */
            @JavascriptInterface
            public void shareFileText(String name, String mime, String base64, String title, String text) {
                try {
                    byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                    File f = new File(sharedDir(), name.replaceAll("[^A-Za-z0-9._-]", "_"));
                    try (FileOutputStream out = new FileOutputStream(f)) {
                        out.write(bytes);
                    }
                    Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".files", f);
                    runOnUiThread(() -> {
                        Intent send = new Intent(Intent.ACTION_SEND);
                        send.setType(mime);
                        send.putExtra(Intent.EXTRA_STREAM, uri);
                        send.putExtra(Intent.EXTRA_SUBJECT, title);
                        if (text != null) send.putExtra(Intent.EXTRA_TEXT, text);
                        send.setClipData(ClipData.newRawUri(title, uri));
                        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        startActivity(Intent.createChooser(send, "שיתוף"));
                    });
                } catch (Exception e) {
                    runOnUiThread(() -> pageJs("window.toast && toast('השיתוף נכשל')"));
                }
            }

            @JavascriptInterface
            public void voice() {
                runOnUiThread(() -> {
                    Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                    i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                    i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "he-IL");
                    i.putExtra(RecognizerIntent.EXTRA_PROMPT, "אמרו את מספר הרישוי");
                    i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5);
                    try {
                        startActivityForResult(i, REQ_VOICE);
                    } catch (ActivityNotFoundException e) {
                        pageJs("window.onVoiceResult && window.onVoiceResult(null)");
                    }
                });
            }

            /** Opens the phone's calendar with an all-day event filled in; the user just taps save */
            @JavascriptInterface
            public void addCalendar(String title, String desc, String ymd) {
                runOnUiThread(() -> {
                    try {
                        Date d = new SimpleDateFormat("yyyyMMdd", Locale.US).parse(ymd);
                        // all-day events are stored at UTC midnight
                        long start = d.getTime() + java.util.TimeZone.getDefault().getOffset(d.getTime());
                        Intent i = new Intent(Intent.ACTION_INSERT)
                                .setData(CalendarContract.Events.CONTENT_URI)
                                .putExtra(CalendarContract.Events.TITLE, title)
                                .putExtra(CalendarContract.Events.DESCRIPTION, desc)
                                .putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, true)
                                .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, start)
                                .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, start + 86400000L);
                        startActivity(i);
                    } catch (Exception e) {
                        pageJs("window.calendarFallback && calendarFallback()");
                    }
                });
            }

            /** The page hands over the saved cars so the daily check can run without it */
            @JavascriptInterface
            public void syncSaved(String json) {
                SavedCheckWorker.prefs(MainActivity.this).edit().putString("saved", json == null ? "[]" : json).apply();
                SavedCheckWorker.schedule(MainActivity.this);
            }

            /** "on", "off", or "blocked" when the phone does not allow notifications */
            @JavascriptInterface
            public String alertsState() {
                if (!SavedCheckWorker.enabled(MainActivity.this)) return "off";
                return notificationsAllowed() ? "on" : "blocked";
            }

            @JavascriptInterface
            public void setAlerts(boolean on) {
                SavedCheckWorker.prefs(MainActivity.this).edit().putBoolean("enabled", on).apply();
                SavedCheckWorker.schedule(MainActivity.this);
                if (on && !notificationsAllowed() && android.os.Build.VERSION.SDK_INT >= 33) {
                    runOnUiThread(() -> requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY));
                }
            }

            /** Google decides whether the rating card actually appears, and limits how often */
            @JavascriptInterface
            public void askReview() {
                runOnUiThread(() -> {
                    ReviewManager rm = ReviewManagerFactory.create(MainActivity.this);
                    rm.requestReviewFlow().addOnCompleteListener(t -> {
                        if (t.isSuccessful()) {
                            ReviewInfo info = t.getResult();
                            rm.launchReviewFlow(MainActivity.this, info);
                        }
                    });
                });
            }

            /** In-app update: only installs from Google Play can answer. The page learns the result through onUpdateState */
            @JavascriptInterface
            public void checkUpdate() {
                runOnUiThread(() -> {
                    try {
                        if (updateManager == null) updateManager = AppUpdateManagerFactory.create(MainActivity.this);
                        updateManager.getAppUpdateInfo().addOnSuccessListener(info -> {
                            updateInfo = info;
                            if (info.installStatus() == InstallStatus.DOWNLOADED) runJs("window.onUpdateState && onUpdateState('downloaded')");
                            else if (info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE && info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE)) runJs("window.onUpdateState && onUpdateState('available')");
                            else runJs("window.onUpdateState && onUpdateState('none')");
                        }).addOnFailureListener(e -> runJs("window.onUpdateState && onUpdateState('none')"));
                    } catch (Exception e) {
                        runJs("window.onUpdateState && onUpdateState('none')");
                    }
                });
            }

            @JavascriptInterface
            public void startUpdate() {
                runOnUiThread(() -> {
                    try {
                        if (updateManager == null || updateInfo == null) return;
                        if (updateListener == null) {
                            updateListener = state -> {
                                if (state.installStatus() == InstallStatus.DOWNLOADED) runJs("window.onUpdateState && onUpdateState('downloaded')");
                            };
                            updateManager.registerListener(updateListener);
                        }
                        updateManager.startUpdateFlowForResult(updateInfo, MainActivity.this, AppUpdateOptions.newBuilder(AppUpdateType.FLEXIBLE).build(), REQ_UPDATE);
                    } catch (Exception e) {
                        runJs("window.onUpdateState && onUpdateState('none')");
                    }
                });
            }

            @JavascriptInterface
            public void completeUpdate() {
                runOnUiThread(() -> { if (updateManager != null) updateManager.completeUpdate(); });
            }

            /** Plans: the page asks, Google Play decides, and the result comes back through onEntitlement */
            @JavascriptInterface
            public void billingInit() {
                runOnUiThread(() -> billing().init());
            }

            @JavascriptInterface
            public void purchase(String sku) {
                runOnUiThread(() -> billing().purchase(MainActivity.this, sku));
            }

            @JavascriptInterface
            public void openUrl(String url) {
                // only web, phone, mail and map links: never intent:, file: or content: from the page
                final Uri target = Uri.parse(url == null ? "" : url);
                final String sch = target.getScheme();
                if (sch == null || !("https".equals(sch) || "http".equals(sch) || "mailto".equals(sch) || "tel".equals(sch) || "geo".equals(sch))) return;
                runOnUiThread(() -> {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, target));
                    } catch (Exception ignored) {
                    }
                });
            }
        }, "AndroidApp");

        // Back: let the page close settings or return to the home screen first
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }

        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        // Photo of a plate: offer the camera and the gallery
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                boolean docs = false;
                for (String t : params.getAcceptTypes()) if (t != null && t.contains("pdf")) docs = true;
                if (docs) {
                    pick.setType("*/*");
                    pick.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "application/pdf"});
                    if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                } else {
                    pick.setType("image/*");
                }
                Intent chooser = Intent.createChooser(pick, docs ? "מסמך לתיק הרכב" : "תמונה של לוחית הרישוי");
                try {
                    File photo = new File(sharedDir(), "plate-photo.jpg");
                    cameraUri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".files", photo);
                    Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                    cam.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
                    cam.setClipData(ClipData.newRawUri("photo", cameraUri));
                    cam.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cam});
                } catch (Exception e) {
                    cameraUri = null;
                }
                try {
                    startActivityForResult(chooser, REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            /** The page's renderer died (low memory, a heavy photo): rebuild the screen instead of letting the whole app close */
            @Override
            public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                if (view == webView) { webView = null; pageReady = false; pendingJs.clear(); }
                root.removeView(view);
                view.destroy();
                long now = android.os.SystemClock.elapsedRealtime();
                boolean loop = now - lastRendererGone < 15000;   // a second crash right after a rebuild: close cleanly rather than loop
                lastRendererGone = now;
                if (isFinishing()) return true;
                if (loop) { finish(); return true; }
                setIntent(new Intent(MainActivity.this, MainActivity.class));   // the rebuilt screen must not replay a share or link that was already handled
                recreate();
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                if (!pendingJs.isEmpty()) {
                    for (String js : pendingJs) view.evaluateJavascript(js, null);
                    pendingJs.clear();
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (HOST.equals(uri.getHost())) return false;
                String sch = uri.getScheme();
                if (!("https".equals(sch) || "http".equals(sch) || "mailto".equals(sch) || "tel".equals(sch) || "geo".equals(sch))) return true;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        SavedCheckWorker.ensureChannel(this);
        SavedCheckWorker.schedule(this);
        String plate = plateFrom(getIntent());
        String nk = kindFrom(getIntent());
        if (savedInstanceState == null) notifOpened(getIntent());
        if (plate != null) {
            webView.loadUrl(START_URL + (nk != null ? "?nk=" + nk : "") + "#" + plate);
        } else if (savedInstanceState != null) {
            if (webView.restoreState(savedInstanceState) == null) webView.loadUrl(START_URL);   // a restore that fails must not leave a white screen
        } else {
            webView.loadUrl(START_URL);
        }
        handleIncoming(getIntent());
        checkInstallReferrer();
    }

    /* Usage statistics are off in the manifest and switched on here, before the first screen is counted. Google Play's pre-launch report
       runs the app on Firebase Test Lab devices: they are not users, so they never count. The user's own off switch is kept by setAnalytics. */
    private boolean testLab;

    private void initAnalytics() {
        try {
            testLab = "true".equals(android.provider.Settings.System.getString(getContentResolver(), "firebase.test.lab"));
        } catch (Throwable e) {
            testLab = false;   // unreadable: counted as before
        }
        try {
            android.content.SharedPreferences p = getSharedPreferences("analytics", MODE_PRIVATE);
            Boolean on = null;
            if (testLab) on = false;
            else if (p.contains("on")) on = p.getBoolean("on", true);   // the choice the page passed on its last load
            else if (firstRun()) on = true;   // a new install is counted from its first_open
            // otherwise an update from a version without the flag: Firebase still holds the page's last choice until the page repeats it
            if (on != null) com.google.firebase.analytics.FirebaseAnalytics.getInstance(this).setAnalyticsCollectionEnabled(on);
        } catch (Throwable ignored) {
            // analytics must never break the app
        }
    }

    /** Never run before: not an update, and nothing restored from a backup (the first launch records the install referrer check) */
    private boolean firstRun() {
        try {
            android.content.pm.PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return pi.firstInstallTime == pi.lastUpdateTime && !getSharedPreferences("install", MODE_PRIVATE).contains("referrerChecked");
        } catch (Exception e) {
            return false;
        }
    }

    /** Installed from a shared link: the store passes "plate=…", and the first launch opens that car */
    private void checkInstallReferrer() {
        android.content.SharedPreferences p = getSharedPreferences("install", MODE_PRIVATE);
        if (p.getBoolean("referrerChecked", false)) return;
        com.android.installreferrer.api.InstallReferrerClient client =
                com.android.installreferrer.api.InstallReferrerClient.newBuilder(this).build();
        try {
            client.startConnection(new com.android.installreferrer.api.InstallReferrerStateListener() {
                @Override
                public void onInstallReferrerSetupFinished(int code) {
                    p.edit().putBoolean("referrerChecked", true).apply();
                    if (code != com.android.installreferrer.api.InstallReferrerClient.InstallReferrerResponse.OK) {
                        client.endConnection();
                        return;
                    }
                    try {
                        String ref = client.getInstallReferrer().getInstallReferrer();
                        String plate = null, medium = "", source = "";
                        if (ref != null) for (String part : Uri.decode(ref).split("&")) {
                            if (part.startsWith("plate=")) plate = part.substring(6).replaceAll("[^0-9]", "");
                            else if (part.startsWith("utm_medium=")) medium = part.substring(11).replaceAll("[^a-z]", "");
                            else if (part.startsWith("utm_source=")) source = part.substring(11).replaceAll("[^a-z]", "");
                        }
                        // the first launch after an install that started from a shared report: open that car and count it (one page call, the pending slot holds a single script)
                        String js = "";
                        if (plate != null && plate.length() >= 5 && plate.length() <= 8) js += "window.run && run('" + plate + "');";
                        if ("share".equals(source)) js += "typeof track==='function'&&track('referral_open',{via:'" + (medium.isEmpty() ? "none" : medium.substring(0, Math.min(8, medium.length()))) + "'});";
                        if (!js.isEmpty()) {
                            final String fjs = js;
                            runOnUiThread(() -> runJs(fjs));
                        }
                    } catch (Exception ignored) {
                    }
                    client.endConnection();
                }

                @Override
                public void onInstallReferrerServiceDisconnected() {
                }
            });
        } catch (Exception ignored) {
            p.edit().putBoolean("referrerChecked", true).apply();
        }
    }

    private BillingManager billingMgr;

    private BillingManager billing() {
        if (billingMgr == null) billingMgr = new BillingManager(this, js -> runOnUiThread(() -> runJs(js)));
        return billingMgr;
    }

    /** Runs page code on the live WebView; nothing when it is being replaced after a renderer crash */
    private void pageJs(String js) {
        if (webView != null) webView.evaluateJavascript(js, null);
    }

    /** Runs page code now, or once the page has loaded */
    private void runJs(String js) {
        if (webView == null) return;
        if (pageReady) webView.evaluateJavascript(js, null);
        else pendingJs.add(js);
    }

    /** Text or a picture shared from another app, and the launcher shortcuts */
    private void handleIncoming(Intent i) {
        if (i == null) return;
        try {
            handleIncomingIntent(i);
        } catch (Exception e) {
            // a malformed intent from another app (a non-Uri stream, an opaque URI) must not crash the launch
        }
    }

    private void handleIncomingIntent(Intent i) {
        String action = i.getAction();
        if (Intent.ACTION_SEND.equals(action)) {
            String type = i.getType() == null ? "" : i.getType();
            if (type.startsWith("image/")) {
                Uri uri = i.getParcelableExtra(Intent.EXTRA_STREAM);
                if (uri != null) sendImage(uri);
            } else {
                CharSequence t = i.getCharSequenceExtra(Intent.EXTRA_TEXT);
                String sub = i.getStringExtra(Intent.EXTRA_SUBJECT);
                String text = (sub == null ? "" : sub + "\n") + (t == null ? "" : t);
                runJs("window.onSharedText && onSharedText(" + JSONObject.quote(text) + ")");
            }
            i.setAction(null);
        } else if (Intent.ACTION_VIEW.equals(action) && i.getData() != null && "https".equals(i.getData().getScheme()) && i.getData().isHierarchical()) {
            // an App Link from luchit.app: ?plate=, #plate, ?cmp= or ?compare= (the readable form the site shares: 1234567,m413.20.2019.SUN)
            Uri d = i.getData();
            String cmp = d.getQueryParameter("cmp");
            String compare = d.getQueryParameter("compare");
            String plate = d.getQueryParameter("plate");
            if (plate == null && d.getFragment() != null) plate = d.getFragment();
            if (plate != null) plate = plate.replaceAll("[^0-9]", "");
            String via = d.getQueryParameter("s");
            via = via == null ? "none" : via.replaceAll("[^a-z]", "");
            if (via.isEmpty()) via = "none";
            if (via.length() > 8) via = via.substring(0, 8);
            // kind as the site's link_landing has it: a comparison link carries no s=, so the dashboard counts it as a shared arrival by its kind
            String seen = "typeof track==='function'&&track('link_open',{via:'" + via + "',kind:'";
            if (cmp != null && cmp.matches("[A-Za-z0-9_-]{1,4000}")) runJs("window.loadCompareLink && loadCompareLink(" + JSONObject.quote(cmp) + ");" + seen + "cmp'});");
            else if (compare != null && !compare.trim().isEmpty() && compare.length() <= 2000) runJs("window.loadCompareLink && loadCompareLink(" + JSONObject.quote(compare.trim()) + ");" + seen + "cmp'});");
            else if (plate != null && plate.length() >= 5 && plate.length() <= 8) runJs("window.run && run(" + JSONObject.quote(plate) + ");" + seen + "plate'});");
            else {
                // a campaign link (luchit.app/go/fb?c=market answers luchit.app/?utm_source=...&utm_campaign=market): counted as the site's link_landing kind campaign, with its topic
                String src = d.getQueryParameter("utm_source");
                src = src == null ? "" : src.toLowerCase().replaceAll("[^a-z]", "");
                if (src.length() > 12) src = src.substring(0, 12);
                String camp = d.getQueryParameter("utm_campaign");
                camp = camp == null ? "" : camp.toLowerCase().replaceAll("[^a-z0-9_]", "");
                if (camp.length() > 24) camp = camp.substring(0, 24);
                if (!src.isEmpty() && !"share".equals(src) && !"luchitapp".equals(src))
                    runJs("typeof track==='function'&&track('link_open',{kind:'campaign',via:(typeof srcName==='function'?srcName('" + src + "'):'" + src + "')" + (camp.isEmpty() ? "" : ",camp:'" + camp + "'") + "});");
            }
            i.setAction(null);
        } else if (Intent.ACTION_VIEW.equals(action) && i.getData() != null && "luchit".equals(i.getData().getScheme())) {
            String what = i.getData().getHost();
            if ("camera".equals(what)) openCamera();
            else runJs("window.appAction && appAction(" + JSONObject.quote(what == null ? "" : what) + ")");
            i.setAction(null);
        }
    }

    private void openCamera() {
        try {
            File photo = new File(sharedDir(), "plate-photo.jpg");
            cameraUri = FileProvider.getUriForFile(this, getPackageName() + ".files", photo);
            Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            cam.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
            cam.setClipData(ClipData.newRawUri("photo", cameraUri));
            cam.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(cam, REQ_CAMERA);
        } catch (Exception e) {
            runJs("window.appAction && appAction('camera')");
        }
    }

    /** Hands a picture to the page, scaled down so the plate reader gets a manageable image */
    private void sendImage(Uri uri) {
        new Thread(() -> {
            try {
                android.graphics.BitmapFactory.Options o = new android.graphics.BitmapFactory.Options();
                o.inJustDecodeBounds = true;
                try (java.io.InputStream in = getContentResolver().openInputStream(uri)) {
                    android.graphics.BitmapFactory.decodeStream(in, null, o);
                }
                int sample = 1;
                while (Math.max(o.outWidth, o.outHeight) / (sample * 2) >= 1600) sample *= 2;
                android.graphics.BitmapFactory.Options o2 = new android.graphics.BitmapFactory.Options();
                o2.inSampleSize = sample;
                android.graphics.Bitmap bmp;
                try (java.io.InputStream in = getContentResolver().openInputStream(uri)) {
                    bmp = android.graphics.BitmapFactory.decodeStream(in, null, o2);
                }
                if (bmp == null) throw new Exception("decode");
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 88, out);
                String data = "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
                runOnUiThread(() -> runJs("window.onSharedImage && onSharedImage(" + JSONObject.quote(data) + ")"));
            } catch (Exception e) {
                runOnUiThread(() -> runJs("window.toast && toast('לא הצלחתי לפתוח את התמונה')"));
            }
        }).start();
    }

    private boolean notificationsAllowed() {
        if (android.os.Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            return false;
        return androidx.core.app.NotificationManagerCompat.from(this).areNotificationsEnabled();
    }

    // a tapped alert is counted once by its kind (never the plate); reopening the app from recent apps repeats the old intent and is not counted
    private void notifOpened(Intent i) {
        if (i == null || (i.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        String kind = i.getStringExtra("nkind");
        if (kind == null || !kind.matches("[a-z]{1,12}")) return;
        i.removeExtra("nkind");
        SavedCheckWorker.logUsage(this, "notif_open", kind);
    }

    // the kind of a tapped alert (test, recall, svc, doc ...), read before notifOpened removes it: the page opens the tab it is about
    private static String kindFrom(Intent i) {
        String k = i == null ? null : i.getStringExtra("nkind");
        return k != null && k.matches("[a-z]{1,12}") ? k : null;
    }

    // a tapped notification carries the plate of the saved car
    private static String plateFrom(Intent i) {
        if (i == null) return null;
        String p = i.getStringExtra("plate");
        if (p == null) return null;
        p = p.replaceAll("[^0-9]", "");
        return p.isEmpty() ? null : p;
    }

    /* Screenshot counter (Android 14+, no storage permission): tells the page that a screenshot of the app was taken, nothing about the image. */
    private Object screenCaptureCallback;

    @Override
    protected void onStart() {
        super.onStart();
        if (android.os.Build.VERSION.SDK_INT >= 34) registerScreenshotWatcher();
    }

    @Override
    protected void onStop() {
        if (android.os.Build.VERSION.SDK_INT >= 34) unregisterScreenshotWatcher();
        super.onStop();
    }

    @android.annotation.TargetApi(34)
    private void registerScreenshotWatcher() {
        try {
            if (screenCaptureCallback == null) {
                screenCaptureCallback = (Activity.ScreenCaptureCallback) () -> runOnUiThread(() -> {
                    if (webView != null && pageReady) webView.evaluateJavascript("window.onScreenshot && window.onScreenshot()", null);
                });
            }
            registerScreenCaptureCallback(getMainExecutor(), (Activity.ScreenCaptureCallback) screenCaptureCallback);
        } catch (Throwable ignored) {
            // a missing callback only means the counter stays at zero
        }
    }

    @android.annotation.TargetApi(34)
    private void unregisterScreenshotWatcher() {
        try {
            if (screenCaptureCallback != null) unregisterScreenCaptureCallback((Activity.ScreenCaptureCallback) screenCaptureCallback);
        } catch (Throwable ignored) {
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String plate = plateFrom(intent);
        String nk = kindFrom(intent);
        notifOpened(intent);
        if (plate != null) pageJs("window.openAlert ? openAlert(" + JSONObject.quote(plate) + "," + JSONObject.quote(nk == null ? "" : nk) + ") : window.run && run(" + JSONObject.quote(plate) + ")");
        handleIncoming(intent);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_NOTIFY) {
            boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            pageJs("window.onAlertsPermission && onAlertsPermission(" + ok + ")");
        }
    }

    private File sharedDir() {
        File dir = new File(getCacheDir(), "shared");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE) {
            Uri[] result = null;
            if (resultCode == RESULT_OK) {
                if (data != null && data.getClipData() != null && data.getClipData().getItemCount() > 0) {
                    int n = data.getClipData().getItemCount();
                    result = new Uri[n];
                    for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data != null && data.getData() != null) result = new Uri[]{data.getData()};
                else if (cameraUri != null) result = new Uri[]{cameraUri};
            }
            if (fileCallback != null) fileCallback.onReceiveValue(result);
            fileCallback = null;
        } else if (requestCode == REQ_CAMERA) {
            if (resultCode == RESULT_OK && cameraUri != null) sendImage(cameraUri);
        } else if (requestCode == REQ_VOICE) {
            String text = "";
            if (resultCode == RESULT_OK && data != null) {
                ArrayList<String> r = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
                if (r != null && !r.isEmpty()) text = TextUtils.join("\n", r);
            }
            pageJs("window.onVoiceResult && window.onVoiceResult(" + JSONObject.quote(text) + ")");
        }
    }

    private void handleBack() {
        if (webView == null) { leave(); return; }
        webView.evaluateJavascript("(window.appBack && window.appBack()) ? 'y' : 'n'", result -> {
            if (result == null || !result.contains("y")) leave();
        });
    }

    // Back with nothing left to close in the page: the app goes to the background, as Android 12 and later do with every app, and opens
    // again where it was. Opened inside another app (an ad shared from it) it closes, so Back returns to that app
    private void leave() {
        if (isTaskRoot()) moveTaskToBack(true);
        else finish();
    }

    @Override
    public boolean onKeyDown(int keyCode, android.view.KeyEvent event) {
        if (keyCode == android.view.KeyEvent.KEYCODE_BACK && android.os.Build.VERSION.SDK_INT < 33) {
            handleBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // ---- the look: the theme the page chose, the bars in the colours of the page's edges, their icons readable on them

    private android.content.SharedPreferences ui() {
        return getSharedPreferences("ui", MODE_PRIVATE);
    }

    private String themeMode() {
        String m = ui().getString("theme", "light");
        return "dark".equals(m) || "auto".equals(m) ? m : "light";
    }

    private static boolean night(android.content.res.Configuration c) {
        return (c.uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES;
    }

    private boolean isDark(String mode) {
        return "dark".equals(mode) || ("auto".equals(mode) && systemNight);
    }

    /** The page applied a theme (on every load, and when the user picks one in its settings) */
    private void themeChosen(String mode) {
        android.content.SharedPreferences p = ui();
        if (!mode.equals(p.getString("theme", "light"))) p.edit().putString("theme", mode).apply();
        // the splash of the next launch: Android 13 and later keep it per app (earlier versions draw the manifest's light theme)
        if (android.os.Build.VERSION.SDK_INT >= 33 && !mode.equals(p.getString("splash", "light"))) {
            try {
                getSplashScreen().setSplashScreenTheme("dark".equals(mode) ? R.style.AppTheme_Dark : "auto".equals(mode) ? R.style.AppTheme_DayNight : android.content.res.Resources.ID_NULL);
                p.edit().putString("splash", mode).apply();
            } catch (Throwable ignored) {
            }
        }
        lookChanged(isDark(mode));
    }

    // light turned dark or back: the window and the WebView's ground in the new colours at once (the page sends its own edges right after)
    private void lookChanged(boolean d) {
        if (d == dark) return;
        dark = d;
        if (webView != null) webView.setBackgroundColor(dark ? PAGE_DARK : PAGE_LIGHT);
        paintBars(dark ? TOP_DARK : TOP_LIGHT, dark ? BOTTOM_DARK : BOTTOM_LIGHT);
    }

    @Override
    public void onConfigurationChanged(android.content.res.Configuration c) {
        super.onConfigurationChanged(c);
        boolean n = night(c);
        if (n == systemNight) return;
        systemNight = n;
        // the phone turned dark or light with the app open: "לפי המכשיר" follows it now, not at the next launch
        if ("auto".equals(themeMode())) {
            lookChanged(n);
            pageJs("window.onSystemDark && window.onSystemDark(" + n + ")");
        }
    }

    /** The status bar takes the colour of the page's top edge and the navigation bar that of its bottom edge; each one's icons are dark or
     *  light, whichever reads better on it */
    private void paintBars(int top, int bottom) {
        bars.set(dark ? PAGE_DARK : PAGE_LIGHT, top, bottom);
        boolean lightTop = lightBar(top), lightBottom = lightBar(bottom);
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            int both = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            if (c != null) c.setSystemBarsAppearance((lightTop ? WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS : 0)
                    | (lightBottom ? WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS : 0), both);
        } else {
            View d = getWindow().getDecorView();
            int f = d.getSystemUiVisibility() & ~(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
            d.setSystemUiVisibility(f | (lightTop ? View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR : 0) | (lightBottom ? View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : 0));
        }
    }

    // dark icons where they contrast more than light ones: relative luminance above 0.179, where black and white contrast equally (WCAG)
    private static boolean lightBar(int c) {
        return 0.2126 * lin(Color.red(c)) + 0.7152 * lin(Color.green(c)) + 0.0722 * lin(Color.blue(c)) > 0.179;
    }

    private static double lin(int v) {
        double s = v / 255.0;
        return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    }

    private static Integer rgb(String s) {
        if (s == null || !s.matches("#[0-9a-fA-F]{6}")) return null;
        return 0xFF000000 | Integer.parseInt(s.substring(1), 16);
    }

    /** The window's background, which the transparent bars show: the status bar's strip in the colour of the page's top edge, the
     *  navigation bar's in that of its bottom edge, the rest (the sides of a phone on its side) in the page's own colour */
    private final class BarsDrawable extends android.graphics.drawable.Drawable {
        private final android.graphics.Paint paint = new android.graphics.Paint();
        private int page = PAGE_LIGHT, top = TOP_LIGHT, bottom = BOTTOM_LIGHT;

        void set(int page, int top, int bottom) {
            if (page == this.page && top == this.top && bottom == this.bottom) return;
            this.page = page;
            this.top = top;
            this.bottom = bottom;
            invalidateSelf();
        }

        @Override
        public void draw(android.graphics.Canvas c) {
            android.graphics.Rect r = getBounds();
            int t = 0, b = 0;
            WindowInsets wi = getWindow().getDecorView().getRootWindowInsets();
            if (wi != null) {
                if (android.os.Build.VERSION.SDK_INT >= 30) {
                    t = wi.getInsets(WindowInsets.Type.statusBars() | WindowInsets.Type.displayCutout()).top;
                    b = wi.getInsets(WindowInsets.Type.navigationBars()).bottom;
                } else {
                    t = wi.getStableInsetTop();
                    b = wi.getStableInsetBottom();
                }
            }
            paint.setColor(page);
            c.drawRect(r, paint);
            if (t > 0) { paint.setColor(top); c.drawRect(r.left, r.top, r.right, r.top + t, paint); }
            if (b > 0) { paint.setColor(bottom); c.drawRect(r.left, r.bottom - b, r.right, r.bottom, paint); }
        }

        @Override
        public void setAlpha(int alpha) {
        }

        @Override
        public void setColorFilter(android.graphics.ColorFilter filter) {
        }

        @Override
        public int getOpacity() {
            return android.graphics.PixelFormat.OPAQUE;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        // the WebView holds a renderer and the whole page: released with the screen (a rebuilt screen makes a new one)
        if (updateManager != null && updateListener != null) updateManager.unregisterListener(updateListener);
        if (webView != null) {
            root.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
