"""Turns the raw numbers into KPIs, anomalies, takeaways and recommendations. No network, no LLM: the same input gives the same report."""
from statistics import mean, pstdev


def _ev(d, cfg, key):
    e = d["events"].get(cfg["events"][key], {"cur": 0, "prev": 0})
    return e["cur"], e["prev"]


def pct(a, b):
    return None if not b else round((a - b) / b * 100, 1)


def rate(n, total):
    return None if not total else round(n / total * 100, 2)


def kpi(key, title, cur, prev, unit="", bad_when_up=False, note="", fmt="n"):
    return {"key": key, "title": title, "cur": cur, "prev": prev, "delta": pct(cur, prev) if cur is not None and prev else None,
            "unit": unit, "bad_up": bad_when_up, "note": note, "fmt": fmt}


def analyze(d, cfg, extra=None):
    T = cfg["thresholds"]
    ok_c, ok_p = _ev(d, cfg, "lookup")
    fl_c, fl_p = _ev(d, cfg, "lookup_failed")
    slow_c, slow_p = _ev(d, cfg, "slow")
    ab_c, ab_p = _ev(d, cfg, "abort")
    to_c, to_p = _ev(d, cfg, "timeout")
    ca_c, ca_p = _ev(d, cfg, "from_cache")
    sh_c, sh_p = _ev(d, cfg, "share")
    cm_c, cm_p = _ev(d, cfg, "compare")
    sv_c, sv_p = _ev(d, cfg, "save")
    ss_c, ss_p = _ev(d, cfg, "screenshot")
    uo_c, uo_p = _ev(d, cfg, "upgrade_open")
    pu_c, pu_p = _ev(d, cfg, "purchase_start")
    se_c, se_p = ok_c + fl_c, ok_p + fl_p     # every lookup that ended in a result or an error

    tech = {"offline", "source_down"}
    fk = d.get("failed_kind", {})
    tech_c = sum(v["cur"] for k, v in fk.items() if k in tech) if fk else fl_c
    tech_p = sum(v["prev"] for k, v in fk.items() if k in tech) if fk else fl_p
    nf_c = fk.get("not_found", {}).get("cur", 0); nf_p = fk.get("not_found", {}).get("prev", 0)
    part = d.get("lookup_partial", {})
    partial_c = part.get("1", {}).get("cur", 0); partial_p = part.get("1", {}).get("prev", 0)

    daily = d.get("daily", [])
    last7 = daily[-7:]
    dau_c = round(mean([x["active"] for x in last7]), 1) if last7 else 0
    prev7 = daily[-14:-7]
    dau_p = round(mean([x["active"] for x in prev7]), 1) if prev7 else 0
    wau_c, wau_p = d["users"]["activeUsers"]["cur"], d["users"]["activeUsers"]["prev"]
    ret = d.get("returning", {"cur": 0, "prev": 0})
    ret_c, ret_p = rate(ret["cur"], wau_c), rate(ret["prev"], wau_p)

    m = {
        "searches": (se_c, se_p), "slow_pct": (rate(slow_c, se_c), rate(slow_p, se_p)), "abort_pct": (rate(ab_c, se_c), rate(ab_p, se_p)),
        "fail_pct": (rate(tech_c, se_c), rate(tech_p, se_p)),
    }
    kpis = {
        "health": [
            kpi("searches", "בדיקות רכב (חיפוש לפי לוחית)", se_c, se_p, "", False, "כמה פעמים הקלידו מספר לוחית באפליקציה ופתחו תוצאה"),
            kpi("slow", "בדיקות איטיות", m["slow_pct"][0], m["slow_pct"][1], "%", True, f"{slow_c} בדיקות לקחו יותר מ-3.5 שניות", "pct"),
            kpi("abort", "בדיקות שנעצרו באמצע", m["abort_pct"][0], m["abort_pct"][1], "%", True, f"{ab_c} בדיקות שהמשתמש ביטל או עזב לפני התוצאה", "pct"),
            kpi("fail", "בדיקות שנכשלו", m["fail_pct"][0], m["fail_pct"][1], "%", True, f"{tech_c} בדיקות לא הצליחו (אין אינטרנט או שאתר הממשלה לא ענה)", "pct"),
            kpi("partial", "תוצאות עם מידע חסר", rate(partial_c, ok_c), rate(partial_p, ok_p), "%", True, "תוצאה הוצגה, אבל אחד ממאגרי משרד התחבורה לא ענה", "pct"),
            kpi("cache", "תוצאות שנפתחו בלי אינטרנט", ca_c, ca_p, "", False, "הוצגה התוצאה האחרונה של רכב שמור"),
        ],
        "engagement": [
            kpi("wau", "משתמשים בשבוע", wau_c, wau_p, "", False, "אנשים שונים שפתחו את האפליקציה השבוע"),
            kpi("dau", "משתמשים ביום ממוצע", dau_c, dau_p, "", False, "כמה אנשים פותחים את האפליקציה בכל יום, בממוצע"),
            kpi("stick", "כמה חוזרים כל יום", rate(dau_c, wau_c), rate(dau_p, wau_p), "%", False, "מתוך כל מי שהשתמש השבוע, כמה בממוצע באים ביום רגיל. 20% ומעלה נחשב טוב לאפליקציית רכב", "pct"),
            kpi("ret", "משתמשים שחזרו", ret_c, ret_p, "%", False, "מי שכבר השתמש באפליקציה בעבר וחזר", "pct"),
            kpi("new", "משתמשים חדשים", d["users"]["newUsers"]["cur"], d["users"]["newUsers"]["prev"], "", False, "אנשים שפתחו את האפליקציה לראשונה השבוע"),
        ],
        "usage": [
            kpi("share", "שיתופים (לחצו על שיתוף)", sh_c, sh_p, "", False, f"שיתפו תוצאה ב-{rate(sh_c, ok_c) or 0}% מהבדיקות"),
            kpi("compare", "השוואות בין רכבים", cm_c, cm_p, "", False, f"פתחו השוואה ב-{rate(cm_c, ok_c) or 0}% מהבדיקות"),
            kpi("save", "רכבים ששמרו", sv_c, sv_p, "", False, "כמה פעמים שמרו רכב לרשימה האישית"),
            kpi("upgrade", "צפיות במסך 'שדרוג ל-PRO'", uo_c, uo_p, "", False, f"{pu_c} התחילו רכישה (כרגע האפליקציה חינמית בבטא)"),
        ],
    }

    # screenshots are the quiet kind of sharing: people keep or send a picture instead of pressing share
    ratio_c = round(ss_c / sh_c, 2) if sh_c else None; ratio_p = round(ss_p / sh_p, 2) if sh_p else None
    kpis["viral"] = [
        kpi("shots", "צילומי מסך מהאפליקציה", ss_c, ss_p, "", False, "משתמשים שצילמו את המסך. נמדד רק באנדרואיד 14 ומעלה, ולכן זו הערכה נמוכה"),
        kpi("shares2", "שיתופים (לחצו על שיתוף)", sh_c, sh_p, "", False, "שליחה של תמונה, PDF או קישור"),
        kpi("ratio", "צילומי מסך מול שיתופים", ratio_c, ratio_p, "", False, "אם המספר מעל 1, אנשים מצלמים יותר ממה ששולחים בכפתור, וכדאי להפוך את הצילום לשיתוף נוח", "ratio"),
        kpi("shot_rate", "צילומי מסך על כל 100 בדיקות", round(ss_c / ok_c * 100, 1) if ok_c else None, round(ss_p / ok_p * 100, 1) if ok_p else None, "", False, "כמה מ-100 בדיקות הסתיימו בצילום מסך", "ratio"),
    ]
    TAB_HE0 = {"overview": "סקירה", "buy": "קנייה", "maint": "אחזקה", "recalls": "ריקולים והסדרים", "specs": "מפרט", "home": "מסך הבית", "compare": "השוואה"}
    st = sorted(((TAB_HE0.get(k, k), v["cur"], v["prev"]) for k, v in d.get("screenshot_tab", {}).items()), key=lambda x: -x[1])
    shot_insight = ""
    if ss_c == 0:
        shot_insight = "לא נרשמו צילומי מסך השבוע. המדידה פועלת רק באנדרואיד 14 ומעלה, ולכן המספר הוא הערכה נמוכה."
    else:
        ch = pct(ss_c, ss_p); tot_s = sum(x[1] for x in st)
        parts = []
        if st and tot_s and st[0][1] / tot_s >= 0.4 and st[0][1] >= 5:
            parts.append(f"{round(st[0][1] / tot_s * 100)}% מהצילומים נעשו במסך «{st[0][0]}». כדאי לבדוק אם יש שם מידע ששווה להפוך לכרטיס שיתוף ייעודי.")
        if ch is not None and ch >= 50 and ss_c >= 5:
            parts.append(f"נרשם זינוק של {ch}% בצילומי מסך לעומת שבוע שעבר.")
        if ratio_c is not None and ratio_c > 1:
            parts.append(f"מצלמים {ratio_c} צילומים על כל שיתוף: חלק גדול מהמשתמשים מעדיף לצלם מאשר ללחוץ על שיתוף.")
        shot_insight = " ".join(parts) or "אין שינוי משמעותי בצילומי המסך."
    anomalies = []
    def add(level, title, detail): anomalies.append({"level": level, "title": title, "detail": detail})
    enough = se_c >= T["min_searches_for_rates"]
    if wau_c == 0:
        add("red", "לא נקלטו נתונים השבוע", "אין משתמשים פעילים ב-GA4. בדקו שהאנליטיקה באפליקציה פועלת ושהנכס נכון.")
    if not enough and wau_c:
        add("info", "נפח חיפושים נמוך", f"רק {se_c} חיפושים השבוע, ולכן אחוזים שבועיים רועשים ולא הופעלו בהם התראות.")
    sp = m["slow_pct"][0]
    if enough and sp is not None:
        if sp > T["slow_pct_red"]: add("red", "חיפושים איטיים מעל הסף", f"{sp}% מהחיפושים עברו 3.5 שניות (הסף {T['slow_pct_red']}%). בדקו את מאגרי משרד התחבורה ואת הזמינות שלהם.")
        elif sp > T["slow_pct_yellow"]: add("yellow", "חיפושים איטיים בעלייה", f"{sp}% מהחיפושים איטיים (אזהרה מעל {T['slow_pct_yellow']}%).")
    ab_ch = pct(ab_c, ab_p)
    if enough and ab_c >= T["abort_min_count"] and ab_ch is not None and ab_ch >= T["abort_rise_pct"]:
        add("red", "קפיצה בביטולי חיפוש", f"{ab_c} ביטולים לעומת {ab_p} בשבוע שעבר (+{ab_ch}%). משתמשים מוותרים באמצע המתנה.")
    fp = m["fail_pct"][0]
    if enough and fp is not None:
        if fp > T["fail_pct_red"]: add("red", "שיעור כשלים טכניים גבוה", f"{fp}% מהחיפושים נכשלו בגלל חיבור או מאגר שלא ענה.")
        elif fp > T["fail_pct_yellow"]: add("yellow", "כשלים טכניים מעל הרגיל", f"{fp}% מהחיפושים נכשלו (אזהרה מעל {T['fail_pct_yellow']}%).")
    pp = rate(partial_c, ok_c)
    if ok_c >= T["min_searches_for_rates"] and pp is not None and pp > T["partial_pct_yellow"]:
        add("yellow", "תוצאות עם מידע חסר", f"{pp}% מהתוצאות הוצגו בלי מאגר אחד או יותר. ייתכן שמאגר מסוים לא יציב.")
    lc = pct(se_c, se_p)
    if se_p >= T["min_searches_for_rates"] and lc is not None:
        if lc <= -T["lookups_drop_red_pct"]: add("red", "ירידה חדה בחיפושים", f"{se_c} חיפושים לעומת {se_p} בשבוע שעבר ({lc}%).")
        elif lc <= -T["lookups_drop_yellow_pct"]: add("yellow", "ירידה בחיפושים", f"{se_c} חיפושים לעומת {se_p} בשבוע שעבר ({lc}%).")
    sr_c, sr_p = rate(sh_c, ok_c), rate(sh_p, ok_p)
    if sr_c is not None and sr_p and ok_p >= T["min_searches_for_rates"] and (sr_c - sr_p) / sr_p * 100 <= -T["share_rate_drop_pct"]:
        add("yellow", "ירידה בשיעור השיתוף", f"{sr_c}% מהבדיקות הסתיימו בשיתוף, לעומת {sr_p}% בשבוע שעבר.")
    series = [x["lookups"] for x in daily]
    if len(series) >= 22:
        base, today = series[-22:-1], series[-1]
        sd = pstdev(base)
        if sd > 0 and abs(today - mean(base)) / sd >= T["daily_zscore"] and max(today, mean(base)) >= 10:
            direction = "גבוה" if today > mean(base) else "נמוך"
            add("yellow", "יום חריג בחיפושים", f"ב-{daily[-1]['date']} נרשמו {today} חיפושים, {direction} משמעותית מהממוצע היומי ({round(mean(base))}).")
    # static reminder removed from the alerts list: it is not an anomaly and repeated every week
    #     add("info", "לא נמדד כרגע", "היצרנים והדגמים הנבדקים ביותר וסוגי ההנעה: האפליקציה לא שולחת אותם. המרה מהאתר להורדה נמדדת ב-Play Console (Acquisition לפי UTM של luchit.app), ולא כאן.")
    X = extra or {}
    sc, cf, ps, pl = X.get("search_console"), X.get("cloudflare"), X.get("psi"), X.get("play")
    if sc:
        ch = pct(sc["cur"]["clicks"], sc["prev"]["clicks"])
        if sc["prev"]["clicks"] >= 20 and ch is not None and ch <= -T["lookups_drop_yellow_pct"]:
            add("yellow", "ירידה בקליקים מגוגל", f"{sc['cur']['clicks']} קליקים לעומת {sc['prev']['clicks']} ({ch}%). כדאי לבדוק ב-Search Console אם דפים יצאו מהאינדקס.")
    if cf:
        ch = pct(cf["cur"]["visits"], cf["prev"]["visits"])
        if cf["prev"]["visits"] >= 50 and ch is not None and ch <= -T["lookups_drop_yellow_pct"]:
            add("yellow", "ירידה בביקורים באתר", f"{cf['cur']['visits']} ביקורים לעומת {cf['prev']['visits']} ({ch}%).")
    for r in ps or []:
        short = r["url"].replace("https://", "")
        if r["score"] < 75 or r["lcp"] > 4 or r["cls"] > 0.1:
            add("yellow", "מהירות האתר ירדה", f"{short}: ציון {r['score']}, LCP {r['lcp']} שניות, CLS {r['cls']}.")
    if pl:
        if pl.get("crash_pct") is not None and pl["crash_pct"] > 1.09: add("red", "שיעור קריסות מעל סף Google Play", f"{pl['crash_pct']}% מהמשתמשים חוו קריסה (הסף של Play הוא 1.09%). חשיפה בחנות עלולה לרדת.")
        if pl.get("anr_pct") is not None and pl["anr_pct"] > 0.47: add("red", "שיעור ANR מעל סף Google Play", f"{pl['anr_pct']}% מהמשתמשים חוו ANR (הסף 0.47%).")
    bv = X.get("brevo")
    if bv and bv.get("last") and bv["last"]["delivered"] >= 50 and bv["last"].get("age_days", 99) <= 14:
        L = bv["last"]
        if L["unsub_pct"] is not None and L["unsub_pct"] > 2:
            add("red", "שיעור הסרות גבוה בניוזלטר", f"{L['unsub_pct']}% מהנמענים ביקשו הסרה אחרי «{L['name']}» (הסף 2%). כדאי לבדוק את הנושא, התוכן והתדירות.")
        if L["open_pct"] is not None and L["open_pct"] < 20:
            add("red", "שיעור פתיחה נמוך בניוזלטר", f"{L['open_pct']}% פתחו את «{L['name']}» (הסף 20%). ייתכן שהנושא חלש או שהמייל מגיע לספאם.")
    for n in d.get("notes", []):
        src, _, msg = n.partition("|") if "|" in n else ("", "", n)
        SRC_HE = {"psi": "מהירות האתר", "cloudflare": "ביקורי האתר", "search_console": "חיפוש בגוגל", "play": "Google Play", "brevo": "דיוור (Brevo)"}
        add("info", f"נתונים לא זמינים: {SRC_HE.get(src, src)}" if src else "נתונים חלקיים", msg)
    order = {"red": 0, "yellow": 1, "info": 2}
    anomalies.sort(key=lambda a: order[a["level"]])

    # simple distributions
    dur = d.get("lookup_dur", {})
    dur_order = [("lt2", "עד 2 שניות"), ("2to5", "2 עד 5"), ("5to10", "5 עד 10"), ("gt10", "מעל 10")]
    dur_rows = [(lbl, dur.get(k, {}).get("cur", 0), dur.get(k, {}).get("prev", 0)) for k, lbl in dur_order]
    tabs = sorted(((k, v["cur"], v["prev"]) for k, v in d.get("tabs", {}).items()), key=lambda x: -x[1])
    TAB_HE = {"overview": "סקירה", "buy": "קנייה", "maint": "אחזקה", "recalls": "ריקולים והסדרים", "specs": "מפרט"}
    tabs = [(TAB_HE.get(k, "לא צוין" if k in ("(not set)", "") else k), c, p) for k, c, p in tabs]
    SHARE_HE = {"pdf": "PDF", "image": "תמונה", "text": "טקסט", "bizpdf": "PDF עסקי"}
    shares = sorted(((SHARE_HE.get(k, "לא צוין" if k in ("(not set)", "") else k), v["cur"], v["prev"]) for k, v in d.get("share_kind", {}).items()), key=lambda x: -x[1])
    def top(key, n=5):
        rows = sorted(((k, v["cur"]) for k, v in d.get(key, {}).items() if k not in ("(not set)", "")), key=lambda x: -x[1])
        return rows[:n]
    makes, models, fuels = top("make"), top("model"), top("fuel")
    versions = sorted(d.get("versions", {}).items(), key=lambda x: -x[1])[:4]

    # takeaways and recommendations (rule based)
    take = []
    if wau_c:
        take.append(f"{wau_c} משתמשים פעילים השבוע ({_chg(pct(wau_c, wau_p))}) ו-{se_c} חיפושים ({_chg(lc)}).")
    if dur_rows and sum(x[1] for x in dur_rows):
        tot = sum(x[1] for x in dur_rows); fast = dur_rows[0][1]
        take.append(f"{round(fast / tot * 100)}% מהבדיקות הסתיימו תוך 2 שניות.")
    if tabs: take.append(f"הלשונית הנפתחת ביותר: {tabs[0][0]}.")
    if sh_c: take.append(f"{sh_c} שיתופים ({rate(sh_c, ok_c)}% מהבדיקות)" + (f", בעיקר {shares[0][0]}" if shares else "") + ".")
    if ret_c is not None and wau_c: take.append(f"{ret_c}% מהפעילים הם משתמשים חוזרים.")
    recs = []
    reds = [a for a in anomalies if a["level"] == "red"]
    if any("איטיים" in a["title"] or "כשלים" in a["title"] or "ביטולי" in a["title"] for a in reds + [x for x in anomalies if x["level"] == "yellow"]):
        recs.append("לבדוק את זמינות מאגרי משרד התחבורה בימים החריגים ולשקול הגדלת הסתמכות על המטמון המקומי של רכבים שמורים.")
    if sh_c and ok_c and (rate(sh_c, ok_c) or 0) < 5:
        recs.append("שיעור השיתוף נמוך מ-5%: לשקול להבליט את כפתור השיתוף אחרי טעינת תוצאה נקייה.")
    if (ret_c or 0) < 30 and wau_c:
        recs.append("שיעור החוזרים נמוך: להדגיש את שמירת הרכב והתראות הטסט והריקולים כסיבה לחזור.")
    if tabs and (tabs[-1][1] == 0 or len(tabs) < 5):
        recs.append("לבדוק אילו לשוניות כמעט לא נפתחות, ולהחליט אם לאחד או להבליט אותן.")
    recs += ["לפני שחרור גרסה, לבדוק ב-Firebase שאחוז המשתמשים בגרסה האחרונה עולה, ושאין עלייה בכשלים אחרי העדכון.",
             "לבדוק פעם בחודש שהאירועים החדשים מופיעים ב-GA4 וששמות הממדים תואמים לקוד."]
    recs = recs[:3]
    return {"kpis": kpis, "anomalies": anomalies, "dur": dur_rows, "tabs": tabs, "shares": shares, "makes": makes, "models": models, "fuels": fuels, "versions": versions,
            "takeaways": take, "recommendations": recs, "extra": X, "shot_tabs": st, "shot_insight": shot_insight, "daily": daily, "metrics": m,
            "status": "red" if reds else ("yellow" if any(a["level"] == "yellow" for a in anomalies) else "green")}


def _chg(v):
    # the number sits in a left-to-right isolate so the sign and the percent sign stay on the right sides
    return "ללא שינוי" if not v else "\u2066" + (f"+{v}%" if v > 0 else f"{v}%") + "\u2069 לעומת שבוע שעבר"
