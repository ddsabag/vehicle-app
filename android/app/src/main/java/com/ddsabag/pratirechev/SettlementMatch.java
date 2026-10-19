package com.ddsabag.pratirechev;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * The page's settlement matching (stlCompile and settlementsFor in index.html), for the daily check that runs without the page.
 * The car is the page's own summary of it (stlCar in index.html: normalised maker and model, year, colour, fuel, trim text, engine
 * size), so both sides read the same values. An entry with a pattern that does not compile is left out, never the whole list.
 * Keep in step with index.html: .github/scripts/stl-parity.mjs runs both on every entry whenever the list or this file changes.
 */
final class SettlementMatch {
    private static final Pattern DAY = Pattern.compile("^\\d{4}-\\d\\d-\\d\\d$");

    static final class Entry {
        final String id, title, until;
        final Pattern mk, md, not, color, fuel, nofuel, txt;
        final double[] y, cc;
        final boolean ccAny;
        final double age;
        final List<Alt> m = new ArrayList<>();

        private Entry(JSONObject e) {
            id = str(e, "id");
            title = str(e, "t");
            until = str(e, "until");
            mk = rx(str(e, "mk"), 0);
            md = rx(str(e, "md"), 0);
            not = rx(str(e, "not"), 0);
            color = rx(str(e, "color"), 0);
            fuel = rx(str(e, "fuel"), 0);
            nofuel = rx(str(e, "nofuel"), 0);
            txt = rx(str(e, "txt"), Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
            y = range(e, "y");
            cc = range(e, "cc");
            ccAny = e.optBoolean("ccAny", false);
            age = e.isNull("age") ? 0 : e.optDouble("age", 0);
            JSONArray alts = e.optJSONArray("m");
            if (alts != null) for (int i = 0; i < alts.length(); i++) m.add(new Alt(alts.optJSONObject(i)));
        }
    }

    /** One model alternative of an entry ({md, not, y}); a car must fit one of them */
    static final class Alt {
        final Pattern md, not;
        final double[] y;

        Alt(JSONObject a) {
            md = a == null ? null : rx(str(a, "md"), 0);
            not = a == null ? null : rx(str(a, "not"), 0);
            y = a == null ? null : range(a, "y");
        }
    }

    /** settlements.json items into entries; a broken entry is dropped on its own */
    static List<Entry> compile(JSONArray items) {
        List<Entry> out = new ArrayList<>();
        if (items == null) return out;
        for (int i = 0; i < items.length(); i++) {
            try {
                JSONObject e = items.optJSONObject(i);
                if (e == null || str(e, "id").isEmpty() || str(e, "mk").isEmpty() || str(e, "t").isEmpty() || !DAY.matcher(str(e, "until")).matches()) continue;
                out.add(new Entry(e));
            } catch (Exception ignored) {
                // a pattern Java cannot read: this entry only
            }
        }
        return out;
    }

    /** The entries that may apply to the car on `today` (yyyy-MM-dd, local): an entry counts through its `until` day */
    static List<Entry> match(List<Entry> list, JSONObject car, String today, int year) {
        List<Entry> out = new ArrayList<>();
        if (car == null) return out;
        String mk = str(car, "mk"), md = str(car, "md"), color = str(car, "color"), fuel = str(car, "fuel"), txt = str(car, "txt");
        double y = num(car, "y"), cc = num(car, "cc");
        for (Entry s : list) {
            if (s.until.compareTo(today) < 0) continue;
            if (!s.mk.matcher(mk).find()) continue;
            if (s.md != null && !s.md.matcher(md).find()) continue;
            if (s.y != null && !(y >= s.y[0] && y <= s.y[1])) continue;
            if (s.not != null && s.not.matcher(md).find()) continue;
            if (!s.m.isEmpty()) {
                boolean any = false;
                for (Alt a : s.m) {
                    if ((a.md == null || a.md.matcher(md).find()) && (a.not == null || !a.not.matcher(md).find()) && (a.y == null || y >= a.y[0] && y <= a.y[1])) {
                        any = true;
                        break;
                    }
                }
                if (!any) continue;
            }
            if (s.color != null && !s.color.matcher(color).find()) continue;
            if (s.fuel != null && !s.fuel.matcher(fuel).find()) continue;
            if (s.nofuel != null && s.nofuel.matcher(fuel).find()) continue;
            if (s.txt != null && !s.txt.matcher(txt).find()) continue;
            if (s.cc != null && !(cc != 0 && !Double.isNaN(cc) ? cc >= s.cc[0] && cc <= s.cc[1] : s.ccAny)) continue;   // no engine size passes only with ccAny
            if (s.age != 0 && !(y >= year - s.age)) continue;
            out.add(s);
        }
        return out;
    }

    private static Pattern rx(String s, int flags) {
        return s.isEmpty() ? null : Pattern.compile(s, flags);
    }

    /** [from, to] when the field is an array, else null (as the page reads it) */
    private static double[] range(JSONObject o, String k) {
        JSONArray a = o.optJSONArray(k);
        if (a == null) return null;
        return new double[]{a.isNull(0) ? Double.NaN : a.optDouble(0, Double.NaN), a.isNull(1) ? Double.NaN : a.optDouble(1, Double.NaN)};
    }

    /** A text field, "" when missing or null (Android's optString would give "null") */
    private static String str(JSONObject o, String k) {
        return o.isNull(k) ? "" : o.optString(k, "");
    }

    /** A number, NaN when missing or null, so it fails every range as NaN does on the page */
    private static double num(JSONObject o, String k) {
        return o.isNull(k) ? Double.NaN : o.optDouble(k, Double.NaN);
    }
}
