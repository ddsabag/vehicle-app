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
import java.util.Collections;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/**
 * Once a day, checks the saved cars: a new open recall, a test that expires soon (60 days ahead when the renewal needs time: an open
 * recall or a brake check; then 30 and 7 days ahead), a service or a document that is due, becomes a notification. Alerts go out in the
 * daytime only and not on Shabbat (see quiet), at most 2 a day and 4 a week (see budget). The saved list is handed over by the page (localStorage is not readable here).
 * Only the public Ministry of Transport API is called with a plate. The settlements list (luchit.app/settlements.json) is read
 * as a whole and matched on the phone, so no car detail leaves the phone for it.
 */
public class SavedCheckWorker extends Worker {
    static final String PREFS = "saved_alerts";
    static final String CHANNEL = "saved_cars";
    private static final String WORK = "saved-check";
    private static final String API = "https://data.gov.il/api/3/action/datastore_search";
    private static final String RECALLS = "36bf1404-0be4-49d2-82dc-2f1ead4a8b93";
    private static final String ACTIVE = "053cea08-09bc-40ec-8f7a-156f0677aff3";
    private static final String OWNERS = "bb2355dc-9ec7-4f06-9c3f-3344672171da";
    private static final String SETTLEMENTS = "https://luchit.app/settlements.json";
    private static final int LIC_LAG = 3, LIC_NEAR = 30, LIC_FRESH = 30;   // the licence rule of licState in index.html
    private List<SettlementMatch.Entry> settlements;   // read once per run, on the first car that needs it

    public SavedCheckWorker(@NonNull Context c, @NonNull WorkerParameters p) {
        super(c, p);
    }

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean enabled(Context c) {
        return prefs(c).getBoolean("enabled", true);
    }

    /**
     * Runs every 8 hours while alerts are on and at least one car is saved; each run outside the sending hours ends at once, and the checks
     * themselves run once a day. A daily period drifts later with every delayed run until it lands at night, where no alert may be sent:
     * with 8 hours, one run in every day falls inside the sending hours.
     */
    static void schedule(Context c) {
        WorkManager wm = WorkManager.getInstance(c);
        String saved = prefs(c).getString("saved", "[]");
        if (!enabled(c) || "[]".equals(saved)) {
            wm.cancelUniqueWork(WORK);
            return;
        }
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(SavedCheckWorker.class, 8, TimeUnit.HOURS)
                .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setInitialDelay(msUntilMorning(), TimeUnit.MILLISECONDS)
                .build();
        wm.enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.UPDATE, req);   // UPDATE: a phone that had the daily period takes the new one
    }

    /** First run at about 10:00 local time */
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
        if (!enabled(c) || quiet()) return Result.success();
        SharedPreferences p = prefs(c);
        String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        if (today.equals(p.getString("last_run", ""))) return Result.success();   // the checks run once a day
        p.edit().putString("last_run", today).apply();
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
                // the order is the order of importance when the day's or the week's budget runs out; the recall check comes before the
                // test, which names an open recall it recorded
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
                if (on(pr, "service")) {
                    try {
                        checkService(c, p, plate, name, car.optString("svcDue", ""));
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
                    if (on(pr, "settlement")) {
                        try {
                            checkSettlements(c, p, plate, name, car.optJSONObject("stlCar"));
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
     * a month before, a week before and a week after. Each stage once per due date.
     */
    private void checkService(Context c, SharedPreferences p, String plate, String name, String due) throws Exception {
        if (!budget(c)) return;
        if (due == null || due.length() < 10) return;
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
            text = prefix + "מועד הטיפול הבא לפי תיק הרכב: " + when + ". כדאי לתאם מראש.";
        } else if (stage == 7) {
            title = "טיפול לרכב " + fmtPlate(plate) + (days == 0 ? " היום" : " בעוד " + days + " ימים");
            text = prefix + "מועד הטיפול הבא לפי תיק הרכב: " + when + ".";
        } else {
            title = "הטיפול לרכב " + fmtPlate(plate) + " מתעכב";
            text = prefix + "עבר שבוע מהמועד המשוער לטיפול (" + when + "). אם כבר טיפלתם, רשמו את זה בתיק הרכב.";
        }
        notify(c, plate, "svc", ("svc" + plate).hashCode(), title, text);
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
            if (!now.isEmpty()) p.edit().remove("miss_" + key).apply();
            if (!fresh && known.size() > now.size() && now.isEmpty() && !repeated(p, key)) return;   // the register answered with nothing: unknown, not "closed"; alert only when it repeats
            if (!fresh && known.size() > now.size()) {
                notify(c, plate, "recall", ("recall" + plate).hashCode(),
                        "ריקול נסגר ברכב " + fmtPlate(plate),
                        (name.isEmpty() ? "" : name + ": ") + "ריקול שהיה פתוח כבר לא מופיע ברשימה. כדאי לוודא שהתיקון בוצע.");
            }
            for (String id : now) {
                if (!known.contains(id)) {
                    notify(c, plate, "recall", ("recall" + plate).hashCode(),
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
        if (now == 0 && p.getInt(key, 0) > 0) return;   // an empty answer for a car that had owners is a register hiccup, not a change
        if (p.contains(key) && now > p.getInt(key, now)) {
            notify(c, plate, "owner", ("owner" + plate).hashCode(),
                    "בעלות חדשה לרכב " + fmtPlate(plate),
                    (name.isEmpty() ? "" : name + ": ") + "נרשמה בעלות חדשה ברכב.");
        }
        p.edit().putInt(key, now).apply();
    }

    /**
     * A car that was active and is no longer in the active register. This check reads only that register, so it cannot tell a car off the
     * road from one registered as inactive (the page reads the car's own register and says which): the alert says what the register shows.
     */
    private void checkStatus(Context c, SharedPreferences p, String plate, String name) throws Exception {
        if (!budget(c)) return;
        boolean active = query(ACTIVE, "mispar_rechev", plate).length() > 0;
        String key = "active_" + plate;
        if (active) p.edit().remove("miss_" + key).apply();
        if (p.getBoolean(key, false) && !active && !repeated(p, key)) return;   // the first empty answer is unknown (the register has empty days); the second in a row is news
        if (p.getBoolean(key, false) && !active) {
            notify(c, plate, "status", ("status" + plate).hashCode(),
                    "הרכב " + fmtPlate(plate) + " כבר לא במאגר הרכבים הפעילים",
                    (name.isEmpty() ? "" : name + ": ") + "ייתכן שירד מהכביש, וייתכן שנרשם כלא פעיל. פתחו את הרכב באפליקציה כדי לראות מה רשום.");
        }
        p.edit().putBoolean(key, active).apply();
    }

    /**
     * The licence date from the active register, judged like licState in index.html: whole days, rounded (the spring clock change
     * makes one day 23 hours long, and flooring said "פג היום" a day early), the expiry day itself still valid. The register is rebuilt
     * nightly and a renewal reaches it a day or two late, so "expired" is not sent while the page shows amber: in the first LIC_LAG days
     * after the expiry, or while the last test is from LIC_NEAR days before the expiry on (a test that has not become a renewal) and at
     * most LIC_FRESH days old. It is tried for a week from the first day the page shows red, and names such a test when there is one.
     */
    private void checkTest(Context c, SharedPreferences p, String plate, String name) throws Exception {
        if (!budget(c)) return;
        JSONArray rows = query(ACTIVE, "mispar_rechev", plate);
        if (rows.length() == 0) return;
        JSONObject r = rows.getJSONObject(0);
        String tokef = r.optString("tokef_dt", "");
        Date end = day(tokef);
        if (end == null) return;
        long days = Math.round((end.getTime() - startOfToday()) / 86400000.0);
        Set<String> recalls = p.getStringSet("recalls_" + plate, new HashSet<>());
        boolean recall = !recalls.isEmpty(), old = ageAt(r, end) >= 15 * 12;
        if (days > (recall || old ? 60 : 30)) return;
        Date test = day(r.optString("mivchan_acharon_dt", ""));
        boolean near = test != null && !test.before(shift(end, -LIC_NEAR));
        if (days < 0) {
            if (days >= -LIC_LAG || near && !test.before(shift(new Date(startOfToday()), -LIC_FRESH))) return;   // amber on the page
            long red = near ? Math.max(LIC_LAG + 1, Math.round((test.getTime() - end.getTime()) / 86400000.0) + LIC_FRESH + 1) : LIC_LAG + 1;
            if (-days > red + 6) return;   // a week of daily tries from the first red day
        }
        int stage = days < 0 ? -1 : days <= 7 ? 7 : days <= 30 ? 30 : 60;
        String key = "test_" + plate;
        String mark = tokef.substring(0, 10) + "|" + stage;
        if (mark.equals(p.getString(key, ""))) return;
        SimpleDateFormat dm = new SimpleDateFormat("d.M.yyyy", Locale.US);
        String when = dm.format(end);
        boolean shown;
        if (days < 0) {
            shown = notify(c, plate, "test", ("test" + plate).hashCode(),
                    "הטסט לרכב " + fmtPlate(plate) + " פג",
                    (name.isEmpty() ? "" : name + ": ") + "לפי מאגר משרד התחבורה, תוקף הרישיון הסתיים ב-" + when + "."
                            + (near ? " במאגר רשום טסט מ-" + dm.format(test) + ", אבל הרישיון לא חודש בו." : "")
                            + " נסיעה בלי רישיון בתוקף עלולה לסכן את הביטוח ולגרור קנס.");
        } else {
            shown = notify(c, plate, "test", ("test" + plate).hashCode(),
                    "הטסט לרכב " + fmtPlate(plate) + (days == 0 ? " פג היום" : " פג בעוד " + days + " ימים"),
                    (name.isEmpty() ? "" : name + ": ") + "תוקף הרישיון עד " + when + ". " + renewal(r, end, recall, old, stage));
        }
        if (shown) p.edit().putString(key, mark).apply();   // a reminder the phone did not show (weekly budget, notifications off) is tried again the next day
    }

    /**
     * What this car's renewal needs, by the transport ministry's rules (gov.il "חידוש רישיון רכב"): the fee and the test can be done up to
     * 60 days before the expiry; a private car not yet 3 years old pays the fee without a test; a car of 15 years or more needs a brake
     * check at an authorised garage before the test; an open safety recall blocks the renewal. The register may still list a recall that
     * was fixed and not yet reported, so the text says how to settle that.
     */
    static String renewal(JSONObject r, Date end, boolean recall, boolean old, int stage) {
        String own = r.optString("baalut", "");
        boolean fleet = own.contains("ליסינג") || own.contains("השכרה");
        int age = ageAt(r, end);
        boolean feeOnly = !fleet && "P".equalsIgnoreCase(r.optString("sug_degem", "").trim()) && age >= 0 && age < 36;
        StringBuilder t = new StringBuilder();
        if (recall) t.append("לפי משרד התחבורה יש ברכב ריקול פתוח, ובלי תיקון אי אפשר לחדש את הרישיון. אם כבר תוקן, כדאי לוודא שהיבואן דיווח למשרד. ");
        if (fleet) t.append("ברכב ליסינג או השכרה החידוש בדרך כלל באחריות החברה, כדאי לוודא מולה. ");
        else if (feeOnly) t.append("השנה לא נדרש טסט, רק תשלום האגרה. ");
        else if (old) t.append("לרכב בן 15 ומעלה נדרשת לפני הטסט בדיקת בלמים במוסך מורשה. ");
        if (!fleet && !feeOnly && stage != 60) t.append("כדאי לחדש מראש: טסט ותשלום האגרה.");
        if (stage == 60) t.append(feeOnly ? "אפשר לשלם את האגרה כבר עכשיו, החל מ-60 יום לפני תום התוקף." : "אפשר לחדש כבר עכשיו: התשלום והטסט אפשריים החל מ-60 יום לפני תום התוקף.");
        return t.toString().trim();
    }

    /** The car's age in whole months on day d, from its first registration (moed_aliya_lakvish, "2023-11"), else its production year; -1 when unknown */
    static int ageAt(JSONObject r, Date d) {
        Calendar at = Calendar.getInstance();
        at.setTime(d);
        int months = at.get(Calendar.YEAR) * 12 + at.get(Calendar.MONTH);
        String m = r.optString("moed_aliya_lakvish", "").trim();
        try {
            String[] ym = m.split("-");
            if (ym.length >= 2) return months - (Integer.parseInt(ym[0].trim()) * 12 + Integer.parseInt(ym[1].trim()) - 1);
        } catch (NumberFormatException ignored) {
        }
        int y = r.optInt("shnat_yitzur", 0);
        return y >= 1950 ? months - y * 12 : -1;
    }

    /**
     * No alert at night or on Shabbat: alerts go out from 9:00 to 21:00, on Friday until 14:00, and not on Saturday. A run in those hours
     * ends at once; the next run inside the hours sends what is due (every stage has a range of days, so a skipped day loses nothing).
     */
    static boolean quiet() {
        Calendar now = Calendar.getInstance();
        int h = now.get(Calendar.HOUR_OF_DAY), d = now.get(Calendar.DAY_OF_WEEK);
        return h < 9 || h >= 21 || d == Calendar.SATURDAY || d == Calendar.FRIDAY && h >= 14;
    }

    /** d moved by n calendar days; a clock change in between does not move it off midnight */
    private static Date shift(Date d, int n) {
        Calendar cal = Calendar.getInstance();
        cal.setTime(d);
        cal.add(Calendar.DAY_OF_YEAR, n);
        return cal.getTime();
    }

    /** A register date at local midnight, or null for an empty, zero ("0000-00-00"), pre-1950 or impossible one (toDate in index.html) */
    private static Date day(String s) {
        if (s == null || s.length() < 10) return null;
        try {
            SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            f.setLenient(false);
            Date d = f.parse(s.substring(0, 10));
            return d != null && Integer.parseInt(s.substring(0, 4)) >= 1950 ? d : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** Vehicle-file documents with an expiry date (insurance, licences): a month before, a week before, on the day and a few days after */
    private void checkDocs(Context c, SharedPreferences p, String plate, String name, JSONArray docs) throws Exception {
        if (docs == null || docs.length() == 0) return;
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
            notify(c, plate, "doc", ("doc" + plate + cat).hashCode(), title, text);
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
            notify(c, plate, "mods", ("mods" + plate).hashCode(),
                    "נרשם שינוי ברכב " + fmtPlate(plate),
                    (name.isEmpty() ? "" : name + ": ") + "במאגר הרכבים נרשם שינוי במבנה, בצבע, בגפ״מ או בצמיגים.");
        }
        p.edit().putString(key, sig).apply();
    }

    /**
     * A settlement the weekly review added, or widened, that may apply to the car (the same match as the car's page, on the page's
     * summary of the car). Like recalls, the first check only records what already applies, so saving a car never triggers an alert.
     */
    private void checkSettlements(Context c, SharedPreferences p, String plate, String name, JSONObject car) throws Exception {
        if (car == null || !budget(c)) return;
        if (settlements == null) {
            settlements = Collections.emptyList();   // a list that failed to load is not asked for again by the next car in this run
            settlements = SettlementMatch.compile(new JSONObject(fetch(SETTLEMENTS)).optJSONArray("items"));
        }
        if (settlements.isEmpty()) return;   // an empty or unreadable list says nothing about the car
        String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        List<SettlementMatch.Entry> hits = SettlementMatch.match(settlements, car, today, Calendar.getInstance().get(Calendar.YEAR));
        String key = "stl_" + plate;
        Set<String> seen = new HashSet<>(p.getStringSet(key, new HashSet<>()));
        if (p.contains(key)) {
            SettlementMatch.Entry first = null;
            int fresh = 0;
            for (SettlementMatch.Entry e : hits) {
                if (seen.contains(e.id)) continue;
                if (first == null) first = e;
                fresh++;
            }
            if (first != null) {
                notify(c, plate, "stl", ("stl" + plate).hashCode(),
                        "ייתכן שמגיעה הטבה לרכב " + fmtPlate(plate),
                        (name.isEmpty() ? "" : name + ": ") + (fresh == 1 ? "נוסף הסדר פשרה שעשוי לחול על הרכב: " : "נוספו " + fresh + " הסדרי פשרה שעשויים לחול על הרכב, ביניהם: ")
                                + first.title + ". הפרטים בלשונית ריקולים.");
            }
        }
        // every id that ever applied stays known, so an entry that drops out for a while and comes back does not alert twice
        for (SettlementMatch.Entry e : hits) seen.add(e.id);
        p.edit().putStringSet(key, seen).apply();
    }

    private static boolean on(JSONObject prefs, String kind) {
        return prefs == null || prefs.optBoolean(kind, true);
    }

    /** At most 2 notifications a day and 4 in any 7 days, so the phone is never flooded; skipped checks run again the next day */
    private static boolean budget(Context c) {
        SharedPreferences p = prefs(c);
        long now = System.currentTimeMillis(), week = TimeUnit.DAYS.toMillis(7), today = startOfToday(), n = 0, d = 0;
        for (String t : p.getString("sent_log", "").split(",")) {
            try {
                long at = Long.parseLong(t);
                if (now - at < week) n++;
                if (at >= today) d++;
            } catch (NumberFormatException ignored) {
            }
        }
        return n < 4 && d < 2;
    }

    /** Anonymous usage count (the kind of alert only, never the plate), kept off when the owner switched usage statistics off in the app */
    static void logUsage(Context c, String name, String kind) {
        try {
            if (!c.getSharedPreferences("analytics", Context.MODE_PRIVATE).getBoolean("on", true)) return;
            android.os.Bundle b = new android.os.Bundle();
            b.putString("kind", kind);
            com.google.firebase.analytics.FirebaseAnalytics.getInstance(c).logEvent(name, b);
        } catch (Throwable ignored) {
            // analytics must never break an alert
        }
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
    /** True when the same empty answer was already seen on the previous run (the counter is cleared by the caller's normal path) */
    private static boolean repeated(SharedPreferences p, String key) {
        int miss = p.getInt("miss_" + key, 0) + 1;
        p.edit().putInt("miss_" + key, miss < 2 ? miss : 0).apply();
        return miss >= 2;
    }

    private static JSONArray query(String resource, String field, String plate) throws Exception {
        Exception last = null;
        boolean ok = false;
        for (Object v : new Object[]{Long.parseLong(plate), plate}) {
            try {
                JSONObject f = new JSONObject().put(field, v);
                String url = API + "?resource_id=" + resource + "&limit=100&filters=" + URLEncoder.encode(f.toString(), "UTF-8");
                JSONObject j = new JSONObject(fetch(url));
                if (!j.optBoolean("success")) throw new Exception("api error");
                ok = true;
                JSONArray r = j.getJSONObject("result").getJSONArray("records");
                if (r.length() > 0) return r;
            } catch (Exception e) {
                last = e;
            }
        }
        if (!ok && last != null) throw last;
        return new JSONArray();
    }

    private static String fetch(String url) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
        con.setConnectTimeout(15000);
        con.setReadTimeout(20000);
        con.setRequestProperty("Accept", "application/json");
        try (InputStream in = con.getInputStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } finally {
            con.disconnect();
        }
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

    /** Posts the notification; false when it was not shown (weekly budget spent, notifications blocked or not allowed) */
    private static boolean notify(Context c, String plate, String kind, int id, String title, String text) {
        ensureChannel(c);
        Intent open = new Intent(c, MainActivity.class)
                .setData(Uri.parse("luchit://plate/" + plate))
                .putExtra("plate", plate)
                .putExtra("nkind", kind)
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
        if (!budget(c) || !NotificationManagerCompat.from(c).areNotificationsEnabled()) return false;   // at most 4 a week, and a blocked notification does not spend the budget
        try {
            NotificationManagerCompat.from(c).notify(id, b.build());
            logSent(c);
            logUsage(c, "notif_sent", kind);
            return true;
        } catch (SecurityException ignored) {
            // notifications were not allowed
            return false;
        }
    }
}
