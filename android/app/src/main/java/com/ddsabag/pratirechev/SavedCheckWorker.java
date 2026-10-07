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
                .setInitialDelay(msUntilMorning(), TimeUnit.MILLISECONDS)
                .build();
        wm.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, req);
    }

    /** First run at about 10:00 local time, so the daytime-only service reminders are not skipped every day */
    private static long msUntilMorning() {
        Calendar t = Calendar.getInstance();
        t.set(Calendar.HOUR_OF_DAY, 10);
        t.set(Calendar.MINUTE, 0);
        t.set(Calendar.SECOND, 0);
        long d = t.getTimeInMillis() - System.currentTimeMillis();
        if (d < TimeUnit.HOURS.toMillis(1)) d += TimeUnit.DAYS.toMillis(1);
        return d;
    }

    @NonNull
    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        if (!enabled(c)) return Result.success();
        SharedPreferences p = prefs(c);
        try {
            JSONArray saved = new JSONArray(p.getString("saved", "[]"));
            int checked = 0;
            for (int i = 0; i < saved.length() && checked < 20; i++) {
                JSONObject car = saved.getJSONObject(i);
                String plate = car.optString("plate");
                if (plate.isEmpty() || !car.optBoolean("alerts", true)) continue;
                checked++;
                String name = car.optString("title", "");
                JSONObject pr = car.optJSONObject("prefs");
                if (on(pr, "service")) {
                    try {
                        checkService(c, p, plate, name, car.optString("svcDue", ""));
                    } catch (Exception ignored) {
                    }
                }
                if (on(pr, "recall")) {
                    try {
                        checkRecalls(c, p, plate, name);
                    } catch (Exception ignored) {
                    }
                }
                if (on(pr, "test")) {
                    try {
                        checkTest(c, p, plate, name);
                    } catch (Exception ignored) {
                    }
                }
                if (on(pr, "docs")) {
                    try {
                        checkDocs(c, p, plate, name, car.optJSONArray("docs"));
                    } catch (Exception ignored) {
                    }
                }
                // new owner, left-the-road and registered-change alerts belong to the paid plans; the page marks each car
                if (car.optBoolean("ext", true)) {
                    if (on(pr, "owner")) {
                        try {
                            checkOwners(c, p, plate, name);
                        } catch (Exception ignored) {
                        }
                    }
                    if (on(pr, "status")) {
                        try {
                            checkStatus(c, p, plate, name);
                        } catch (Exception ignored) {
                        }
                        try {
                            checkMods(c, p, plate, name);
                        } catch (Exception ignored) {
                        }
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
        if (!budget(c)) return;
        if (due == null || due.length() < 10) return;
        int hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);
        if (hour < 8 || hour >= 22) return;
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
        if (!budget(c)) return;
        JSONArray rows = query(RECALLS, "MISPAR_RECHEV", plate);
        Set<String> now = new HashSet<>();
        for (int i = 0; i < rows.length(); i++) now.add(rows.getJSONObject(i).optString("RECALL_ID"));
        String key = "recalls_" + plate;
        // the first check only records what is already known, so saving a car never triggers an alert
        if (p.contains(key)) {
            Set<String> known = p.getStringSet(key, new HashSet<>());
            boolean fresh = false;
            for (String id : now) if (!known.contains(id)) fresh = true;
            if (!fresh && known.size() > now.size()) {
                notify(c, plate, ("recall" + plate).hashCode(),
                        "ריקול נסגר ברכב " + fmtPlate(plate),
                        (name.isEmpty() ? "" : name + ": ") + "ריקול שהיה פתוח כבר לא מופיע ברשימה. כדאי לוודא שהתיקון בוצע.");
            }
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
        if (!budget(c)) return;
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
        if (!budget(c)) return;
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
        if (!budget(c)) return;
        JSONArray rows = query(ACTIVE, "mispar_rechev", plate);
        if (rows.length() == 0) return;
        String tokef = rows.getJSONObject(0).optString("tokef_dt", "");
        if (tokef.length() < 10) return;
        Date end = new SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(tokef.substring(0, 10));
        if (end == null) return;
        long days = TimeUnit.MILLISECONDS.toDays(end.getTime() - startOfToday());
        if (days < -7 || days > 30) return;
        int stage = days < 0 ? -1 : days <= 7 ? 7 : 30;
        String key = "test_" + plate;
        String mark = tokef.substring(0, 10) + "|" + stage;
        if (mark.equals(p.getString(key, ""))) return;
        String when = new SimpleDateFormat("d.M.yyyy", Locale.US).format(end);
        if (days < 0) {
            notify(c, plate, ("test" + plate).hashCode(),
                    "הטסט לרכב " + fmtPlate(plate) + " פג",
                    (name.isEmpty() ? "" : name + ": ") + "תוקף הרישיון הסתיים ב-" + when + ". נסיעה בלי רישיון בתוקף עלולה לסכן את הביטוח ולגרור קנס.");
        } else {
            notify(c, plate, ("test" + plate).hashCode(),
                    "הטסט לרכב " + fmtPlate(plate) + (days == 0 ? " פג היום" : " פג בעוד " + days + " ימים"),
                    (name.isEmpty() ? "" : name + ": ") + "תוקף הרישיון עד " + when + ". כדאי לקבוע טסט.");
        }
        p.edit().putString(key, mark).apply();
    }

    /** Vehicle-file documents with an expiry date (insurance, licences): a month before, a week before, on the day and a few days after */
    private void checkDocs(Context c, SharedPreferences p, String plate, String name, JSONArray docs) throws Exception {
        if (docs == null || docs.length() == 0) return;
        int hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);
        if (hour < 8 || hour >= 22) return;
        Set<String> sent = new HashSet<>(p.getStringSet("docs_" + plate, new HashSet<>()));
        boolean dirty = false;
        for (int i = 0; i < docs.length(); i++) {
            if (!budget(c)) break;
            JSONObject d = docs.getJSONObject(i);
            String exp = d.optString("exp", ""), cat = d.optString("cat", "מסמך");
            if (exp.length() < 10) continue;
            Date end = new SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(exp.substring(0, 10));
            if (end == null) continue;
            long days = TimeUnit.MILLISECONDS.toDays(end.getTime() - startOfToday());
            int stage;
            if (days < 0 && days >= -3) stage = -1;
            else if (days == 0) stage = 0;
            else if (days > 0 && days <= 7) stage = 7;
            else if (days > 7 && days <= 30) stage = 30;
            else continue;
            String mark = cat + "|" + exp.substring(0, 10) + "|" + stage;
            if (sent.contains(mark)) continue;
            String when = new SimpleDateFormat("d.M.yyyy", Locale.US).format(end);
            String prefix = name.isEmpty() ? "" : name + ": ";
            String title;
            if (stage == -1) title = cat + " לרכב " + fmtPlate(plate) + " פג";
            else if (stage == 0) title = cat + " לרכב " + fmtPlate(plate) + " פג היום";
            else title = cat + " לרכב " + fmtPlate(plate) + " פג בעוד " + days + " ימים";
            String text = prefix + "התוקף ב-תיק הרכב: " + when + (stage == -1 ? ". כדאי לחדש בהקדם." : ". כדאי לחדש מראש.");
            notify(c, plate, ("doc" + plate + cat).hashCode(), title, text);
            sent.add(mark);
            dirty = true;
        }
        if (dirty) p.edit().putStringSet("docs_" + plate, sent).apply();
    }

    /** Structure, colour or gas-conversion flags changed in the register since the last check */
    private void checkMods(Context c, SharedPreferences p, String plate, String name) throws Exception {
        if (!budget(c)) return;
        JSONArray rows = query(ACTIVE, "mispar_rechev", plate);
        if (rows.length() == 0) return;
        JSONObject r = rows.getJSONObject(0);
        String sig = r.optString("shinui_mivne_ind", "") + "|" + r.optString("gapam_ind", "") + "|" + r.optString("shnui_zeva_ind", "") + "|" + r.optString("shinui_zmig_ind", "");
        String key = "mods_" + plate;
        String old = p.getString(key, null);
        if (old != null && !old.equals(sig)) {
            notify(c, plate, ("mods" + plate).hashCode(),
                    "נרשם שינוי ברכב " + fmtPlate(plate),
                    (name.isEmpty() ? "" : name + ": ") + "במאגר הרכבים נרשם שינוי במבנה, בצבע, בגפ״מ או בצמיגים.");
        }
        p.edit().putString(key, sig).apply();
    }

    private static boolean on(JSONObject prefs, String kind) {
        return prefs == null || prefs.optBoolean(kind, true);
    }

    /** At most 4 notifications in any 7 days, so the phone is never flooded; skipped checks run again the next day */
    private static boolean budget(Context c) {
        SharedPreferences p = prefs(c);
        long now = System.currentTimeMillis(), week = TimeUnit.DAYS.toMillis(7), n = 0;
        for (String t : p.getString("sent_log", "").split(",")) {
            try {
                if (now - Long.parseLong(t) < week) n++;
            } catch (NumberFormatException ignored) {
            }
        }
        return n < 4;
    }

    private static void logSent(Context c) {
        SharedPreferences p = prefs(c);
        long now = System.currentTimeMillis(), week = TimeUnit.DAYS.toMillis(7);
        StringBuilder sb = new StringBuilder();
        for (String t : p.getString("sent_log", "").split(",")) {
            try {
                if (now - Long.parseLong(t) < week) sb.append(t).append(',');
            } catch (NumberFormatException ignored) {
            }
        }
        sb.append(now);
        p.edit().putString("sent_log", sb.toString()).apply();
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
        boolean ok = false;
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
                    if (!j.optBoolean("success")) throw new Exception("api error");
                    ok = true;
                    JSONArray r = j.getJSONObject("result").getJSONArray("records");
                    if (r.length() > 0) return r;
                } finally {
                    con.disconnect();
                }
            } catch (Exception e) {
                last = e;
            }
        }
        if (!ok && last != null) throw last;
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
            ch.setDescription("טסט, ריקולים, טיפולים ותוקף מסמכים ברכבים ששמרת");
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
            logSent(c);
        } catch (SecurityException ignored) {
            // notifications were not allowed
        }
    }
}
