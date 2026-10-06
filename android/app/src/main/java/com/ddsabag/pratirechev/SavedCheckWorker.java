package com.ddsabag.pratirechev;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/**
 * Once a day, checks the saved cars: a new open recall, or a test that expires in 30 or 7 days,
 * becomes a notification. The saved list is handed over by the page (localStorage is not readable here).
 * Only the public Ministry of Transport API is called; nothing leaves the phone otherwise.
 */
public class SavedCheckWorker extends Worker {
    static final String PREFS = "saved_alerts";
    static final String CHANNEL = "saved_cars";
    private static final String WORK = "saved-check";
    private static final String API = "https://data.gov.il/api/3/action/datastore_search";
    private static final String RECALLS = "36bf1404-0be4-49d2-82dc-2f1ead4a8b93";
    private static final String ACTIVE = "053cea08-09bc-40ec-8f7a-156f0677aff3";
    private static final String OWNERS = "bb2355dc-9ec7-4f06-9c3f-3344672171da";

    public SavedCheckWorker(@NonNull Context c, @NonNull WorkerParameters p) {
        super(c, p);
    }

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean enabled(Context c) {
        return prefs(c).getBoolean("enabled", true);
    }

    /** Runs daily while alerts are on and at least one car is saved */
    static void schedule(Context c) {
        WorkManager wm = WorkManager.getInstance(c);
        String saved = prefs(c).getString("saved", "[]");
        if (!enabled(c) || "[]".equals(saved)) {
            wm.cancelUniqueWork(WORK);
            return;
        }
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(SavedCheckWorker.class, 1, TimeUnit.DAYS)
                .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setInitialDelay(2, TimeUnit.HOURS)
                .build();
        wm.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, req);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        if (!enabled(c)) return Result.success();
        SharedPreferences p = prefs(c);
        try {
            JSONArray saved = new JSONArray(p.getString("saved", "[]"));
            for (int i = 0; i < saved.length() && i < 20; i++) {
                JSONObject car = saved.getJSONObject(i);
                String plate = car.optString("plate");
                if (plate.isEmpty() || !car.optBoolean("alerts", true)) continue;
                String name = car.optString("title", "");
                try {
                    checkService(c, p, plate, name, car.optString("svcDue", ""));
                } catch (Exception ignored) {
                }
                try {
                    checkRecalls(c, p, plate, name);
                } catch (Exception ignored) {
                }
                try {
                    checkTest(c, p, plate, name);
                } catch (Exception ignored) {
                }
                // new owner and left-the-road alerts belong to the paid plans; the page marks each car
                if (car.optBoolean("ext", true)) {
                    try {
                        checkOwners(c, p, plate, name);
                    } catch (Exception ignored) {
                    }
                    try {
                        checkStatus(c, p, plate, name);
                    } catch (Exception ignored) {
                    }
                }
            }
        } catch (Exception e) {
            return Result.retry();
        }
        return Result.success();
    }

    /**
     * Service reminder from the date the page computed out of the service log (the log itself stays on the phone):
     * a month before, a week before and a week after. Sent in the daytime only, each stage once per due date.
     */
    private void checkService(Context c, SharedPreferences p, String plate, String name, String due) throws Exception {
        if (due == null || due.length() < 10) return;
        int hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);
        if (hour < 9 || hour >= 21) return;
        Date end = new SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(due.substring(0, 10));
        if (end == null) return;
        long days = TimeUnit.MILLISECONDS.toDays(end.getTime() - startOfToday());
        int stage;
        if (days <= -7 && days >= -14) stage = -7;
        else if (days >= 0 && days <= 7) stage = 7;
        else if (days > 7 && days <= 30) stage = 30;
        else return;
        String key = "svc_" + plate, mark = due.substring(0, 10) + "|" + stage;
        Set<String> sent = new HashSet<>(p.getStringSet(key, new HashSet<>()));
        if (sent.contains(mark)) return;
        String when = new SimpleDateFormat("d.M.yyyy", Locale.US).format(end);
        String prefix = name.isEmpty() ? "" : name + ": ";
        String title, text;
        if (stage == 30) {
            title = "טיפול לרכב " + fmtPlate(plate) + " בעוד כחודש";
            text = prefix + "מועד הטיפול הבא לפי היומן: " + when + ". כדאי לתאם מראש.";
        } else if (stage == 7) {
            title = "טיפול לרכב " + fmtPlate(plate) + (days == 0 ? " היום" : " בעוד " + days + " ימים");
            text = prefix + "מועד הטיפול הבא לפי היומן: " + when + ".";
        } else {
            title = "הטיפול לרכב " + fmtPlate(plate) + " מתעכב";
            text = prefix + "עבר שבוע מהמועד המשוער לטיפול (" + when + "). אם כבר טיפלת, רשום את זה ביומן.";
        }
        notify(c, plate, ("svc" + plate).hashCode(), title, text);
        sent.add(mark);
        p.edit().putStringSet(key, sent).apply();
    }

    private void checkRecalls(Context c, SharedPreferences p, String plate, String name) throws Exception {
        JSONArray rows = query(RECALLS, "MISPAR_RECHEV", plate);
        Set<String> now = new HashSet<>();
        for (int i = 0; i < rows.length(); i++) now.add(rows.getJSONObject(i).optString("RECALL_ID"));
        String key = "recalls_" + plate;
        // the first check only records what is already known, so saving a car never triggers an alert
        if (p.contains(key)) {
            Set<String> known = p.getStringSet(key, new HashSet<>());
            for (String id : now) {
                if (!known.contains(id)) {
                    notify(c, plate, ("recall" + plate).hashCode(),
                            "ריקול חדש לרכב " + fmtPlate(plate),
                            (name.isEmpty() ? "" : name + ": ") + "נפתח ריקול חדש. כדאי לתאם תיקון אצל היבואן.");
                    break;
                }
            }
        }
        p.edit().putStringSet(key, now).apply();
    }

    /** A new row in the ownership log means the car changed hands (the log is monthly) */
    private void checkOwners(Context c, SharedPreferences p, String plate, String name) throws Exception {
        int now = query(OWNERS, "mispar_rechev", plate).length();
        String key = "owners_" + plate;
        if (p.contains(key) && now > p.getInt(key, now)) {
            notify(c, plate, ("owner" + plate).hashCode(),
                    "בעלות חדשה לרכב " + fmtPlate(plate),
                    (name.isEmpty() ? "" : name + ": ") + "נרשמה בעלות חדשה ברכב.");
        }
        p.edit().putInt(key, now).apply();
    }

    /** A car that was active and is no longer in the active register has left the road */
    private void checkStatus(Context c, SharedPreferences p, String plate, String name) throws Exception {
        boolean active = query(ACTIVE, "mispar_rechev", plate).length() > 0;
        String key = "active_" + plate;
        if (p.getBoolean(key, false) && !active) {
            notify(c, plate, ("status" + plate).hashCode(),
                    "הרכב " + fmtPlate(plate) + " ירד מהכביש",
                    (name.isEmpty() ? "" : name + ": ") + "הרכב כבר לא מופיע במאגר הרכבים הפעילים.");
        }
        p.edit().putBoolean(key, active).apply();
    }

    private void checkTest(Context c, SharedPreferences p, String plate, String name) throws Exception {
        JSONArray rows = query(ACTIVE, "mispar_rechev", plate);
        if (rows.length() == 0) return;
        String tokef = rows.getJSONObject(0).optString("tokef_dt", "");
        if (tokef.length() < 10) return;
        Date end = new SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(tokef.substring(0, 10));
        if (end == null) return;
        long days = TimeUnit.MILLISECONDS.toDays(end.getTime() - startOfToday());
        if (days < 0 || days > 30) return;
        int stage = days <= 7 ? 7 : 30;
        String key = "test_" + plate;
        String mark = tokef.substring(0, 10) + "|" + stage;
        if (mark.equals(p.getString(key, ""))) return;
        String when = new SimpleDateFormat("d.M.yyyy", Locale.US).format(end);
        notify(c, plate, ("test" + plate).hashCode(),
                "הטסט לרכב " + fmtPlate(plate) + (days == 0 ? " פג היום" : " פג בעוד " + days + " ימים"),
                (name.isEmpty() ? "" : name + ": ") + "תוקף הרישיון עד " + when + ". כדאי לקבוע טסט.");
        p.edit().putString(key, mark).apply();
    }

    private static long startOfToday() {
        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.HOUR_OF_DAY, 0);
        cal.set(Calendar.MINUTE, 0);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        return cal.getTimeInMillis();
    }

    /** Plate columns are numeric in some datasets and text in others, so both are tried */
    private static JSONArray query(String resource, String field, String plate) throws Exception {
        Exception last = null;
        for (Object v : new Object[]{Long.parseLong(plate), plate}) {
            try {
                JSONObject f = new JSONObject().put(field, v);
                String url = API + "?resource_id=" + resource + "&limit=100&filters=" + URLEncoder.encode(f.toString(), "UTF-8");
                HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
                con.setConnectTimeout(15000);
                con.setReadTimeout(20000);
                con.setRequestProperty("Accept", "application/json");
                try (InputStream in = con.getInputStream()) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    JSONObject j = new JSONObject(out.toString("UTF-8"));
                    if (j.optBoolean("success")) {
                        JSONArray r = j.getJSONObject("result").getJSONArray("records");
                        if (r.length() > 0) return r;
                    }
                } finally {
                    con.disconnect();
                }
            } catch (Exception e) {
                last = e;
            }
        }
        if (last != null) throw last;
        return new JSONArray();
    }

    static String fmtPlate(String p) {
        if (p.length() == 7) return p.substring(0, 2) + "-" + p.substring(2, 5) + "-" + p.substring(5);
        if (p.length() == 8) return p.substring(0, 3) + "-" + p.substring(3, 5) + "-" + p.substring(5);
        return p;
    }

    static void ensureChannel(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm != null && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "רכבים שמורים", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("ריקול חדש או טסט שעומד לפוג ברכב ששמרת");
            nm.createNotificationChannel(ch);
        }
    }

    private static void notify(Context c, String plate, int id, String title, String text) {
        ensureChannel(c);
        Intent open = new Intent(c, MainActivity.class)
                .setData(Uri.parse("luchit://plate/" + plate))
                .putExtra("plate", plate)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setColor(0xFFFFC400)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(pi)
                .setAutoCancel(true);
        try {
            NotificationManagerCompat.from(c).notify(id, b.build());
        } catch (SecurityException ignored) {
            // notifications were not allowed
        }
    }
}
