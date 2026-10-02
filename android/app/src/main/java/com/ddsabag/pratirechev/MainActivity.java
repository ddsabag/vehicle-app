package com.ddsabag.pratirechev;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
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

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;

public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/assets/index.html";

    private static final int REQ_FILE = 1;
    private static final int REQ_VOICE = 2;

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
            int types = WindowInsets.Type.systemBars() | WindowInsets.Type.ime();
            android.graphics.Insets i = insets.getInsets(types);
            v.setPadding(i.left, i.top, i.right, i.bottom);
            return WindowInsets.CONSUMED;
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
                pick.setType("image/*");
                Intent chooser = Intent.createChooser(pick, "תמונה של לוחית הרישוי");
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
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (HOST.equals(uri.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(START_URL);
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
                if (data != null && data.getData() != null) result = new Uri[]{data.getData()};
                else if (cameraUri != null) result = new Uri[]{cameraUri};
            }
            if (fileCallback != null) fileCallback.onReceiveValue(result);
            fileCallback = null;
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
        if (android.os.Build.VERSION.SDK_INT < 35) {
            int bar = dark ? Color.parseColor("#0A0F1A") : Color.WHITE;
            getWindow().setStatusBarColor(bar);
            getWindow().setNavigationBarColor(bar);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }
}
