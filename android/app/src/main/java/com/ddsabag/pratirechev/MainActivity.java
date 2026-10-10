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
    private String pendingJs = null;

    private WebView webView;
    private FrameLayout root;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        setDark(false);

        // Keep the page clear of the status and navigation bars (edge-to-edge is enforced on new Android versions)
        root.setOnApplyWindowInsetsListener((View v, WindowInsets insets) -> {
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
        // Lets the page tell us its light/dark choice so the system bars match it
        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void setDark(boolean dark) {
                runOnUiThread(() -> MainActivity.this.setDark(dark));
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
                        if (v instanceof Number) b.putLong(k, ((Number) v).longValue());
                        else if (v instanceof Boolean) b.putLong(k, ((Boolean) v) ? 1 : 0);
                        else b.putString(k, String.valueOf(v).substring(0, Math.min(String.valueOf(v).length(), 60)));
                    }
                    com.google.firebase.analytics.FirebaseAnalytics.getInstance(MainActivity.this).logEvent(name, b);
                } catch (Throwable ignored) {
                    // analytics must never break the app
                }
            }

            @JavascriptInterface
            public void setAnalytics(boolean on) {
                try {
                    com.google.firebase.analytics.FirebaseAnalytics.getInstance(MainActivity.this).setAnalyticsCollectionEnabled(on);
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
                    runOnUiThread(() -> webView.evaluateJavascript("window.toast && toast('השיתוף נכשל')", null));
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
                        webView.evaluateJavascript("window.onVoiceResult && window.onVoiceResult(null)", null);
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
                        webView.evaluateJavascript("window.calendarFallback && calendarFallback()", null);
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
                runOnUiThread(() -> {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
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

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                if (pendingJs != null) {
                    String js = pendingJs;
                    pendingJs = null;
                    view.evaluateJavascript(js, null);
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
        if (plate != null) {
            webView.loadUrl(START_URL + "#" + plate);
        } else if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(START_URL);
        }
        handleIncoming(getIntent());
        checkInstallReferrer();
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
                        String plate = null;
                        if (ref != null) for (String part : Uri.decode(ref).split("&")) {
                            if (part.startsWith("plate=")) plate = part.substring(6).replaceAll("[^0-9]", "");
                        }
                        if (plate != null && plate.length() >= 5 && plate.length() <= 8) {
                            String js = "window.run && run('" + plate + "')";
                            runOnUiThread(() -> runJs(js));
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

    /** Runs page code now, or once the page has loaded */
    private void runJs(String js) {
        if (pageReady) webView.evaluateJavascript(js, null);
        else pendingJs = js;
    }

    /** Text or a picture shared from another app, and the launcher shortcuts */
    private void handleIncoming(Intent i) {
        if (i == null) return;
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

    // a tapped notification carries the plate of the saved car
    private static String plateFrom(Intent i) {
        if (i == null) return null;
        String p = i.getStringExtra("plate");
        if (p == null) return null;
        p = p.replaceAll("[^0-9]", "");
        return p.isEmpty() ? null : p;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String plate = plateFrom(intent);
        if (plate != null) webView.evaluateJavascript("window.run && run(" + JSONObject.quote(plate) + ")", null);
        handleIncoming(intent);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_NOTIFY) {
            boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            webView.evaluateJavascript("window.onAlertsPermission && onAlertsPermission(" + ok + ")", null);
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
            webView.evaluateJavascript("window.onVoiceResult && window.onVoiceResult(" + JSONObject.quote(text) + ")", null);
        }
    }

    private void handleBack() {
        webView.evaluateJavascript("(window.appBack && window.appBack()) ? 'y' : 'n'", result -> {
            if (result == null || !result.contains("y")) finish();
        });
    }

    @Override
    public boolean onKeyDown(int keyCode, android.view.KeyEvent event) {
        if (keyCode == android.view.KeyEvent.KEYCODE_BACK && android.os.Build.VERSION.SDK_INT < 33) {
            handleBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    private void setDark(boolean dark) {
        root.setBackgroundColor(dark ? Color.parseColor("#0A0F1A") : Color.WHITE);
        int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) c.setSystemBarsAppearance(dark ? 0 : light, light);
        } else {
            int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            View d = getWindow().getDecorView();
            int cur = d.getSystemUiVisibility();
            d.setSystemUiVisibility(dark ? (cur & ~flags) : (cur | flags));
        }
        // the bars are transparent (theme): the window background shows through them, so no deprecated bar-colour calls are needed
        getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(dark ? Color.parseColor("#0A0F1A") : Color.WHITE));
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }
}
