"""One self-contained HTML file: no external fonts, scripts or images, RTL, light and dark, readable on a phone."""
from html import escape as E
from datetime import date


class Raw(str):
    """a label that already holds safe HTML (e.g. a left-to-right number inside Hebrew text)"""


MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"]


def heb_range(a, b):
    x, y = date.fromisoformat(str(a)), date.fromisoformat(str(b))
    if x.year == y.year and x.month == y.month: return f"{x.day} עד {y.day} ב{MONTHS[y.month-1]} {y.year}"
    if x.year == y.year: return f"{x.day} ב{MONTHS[x.month-1]} עד {y.day} ב{MONTHS[y.month-1]} {y.year}"
    return f"{x.day} ב{MONTHS[x.month-1]} {x.year} עד {y.day} ב{MONTHS[y.month-1]} {y.year}"

CSS = """
:root{--bg:#f3f4f7;--card:#fff;--fg:#151a24;--muted:#5d6676;--line:#e3e6ec;--soft:#f0f2f6;--accent:#2556c8;--ok:#16794c;--warn:#8a5a00;--bad:#b3261e;--okbg:#e5f4ec;--warnbg:#fff3d6;--badbg:#fde8e6;--infobg:#e8eefc;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0d1118;--card:#161c27;--fg:#e9edf3;--muted:#97a1b3;--line:#262e3c;--soft:#1d2533;--accent:#7ea2ff;--ok:#5fd3a0;--warn:#f0c26b;--bad:#ff8f87;--okbg:#12281f;--warnbg:#2b2310;--badbg:#341715;--infobg:#17213a;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 "Assistant",system-ui,-apple-system,"Segoe UI",Arial,sans-serif}
main{max-width:1040px;margin:0 auto;padding:24px 16px 56px;display:flex;flex-direction:column;gap:18px}
h1{margin:0;font-size:1.55rem}h2{margin:0 0 10px;font-size:1.05rem}.muted{color:var(--muted);font-size:.88rem}
header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;font-weight:700;font-size:.85rem}
.pill.green{background:var(--okbg);color:var(--ok)}.pill.yellow{background:var(--warnbg);color:var(--warn)}.pill.red{background:var(--badbg);color:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px}
.alerts{display:flex;flex-direction:column;gap:8px}.al{display:flex;gap:10px;border-radius:12px;padding:10px 12px;border:1px solid transparent}
.al b{display:block}.al.red{background:var(--badbg);border-color:var(--bad)}.al.yellow{background:var(--warnbg);border-color:var(--warn)}.al.info{background:var(--infobg);border-color:var(--line)}
.dot{flex:0 0 10px;height:10px;border-radius:50%;margin-top:7px}.red .dot{background:var(--bad)}.yellow .dot{background:var(--warn)}.info .dot{background:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:2px}
.kpi .t{font-size:.85rem;color:var(--muted)}.kpi .v{font-size:1.8rem;font-weight:800;line-height:1.15;font-variant-numeric:tabular-nums}.kpi .v small{font-size:1rem;font-weight:700;color:var(--muted)}
.chip{display:inline-flex;align-self:flex-start;gap:4px;font-size:.8rem;font-weight:700;padding:1px 8px;border-radius:999px;margin-top:4px}
.chip.good{background:var(--okbg);color:var(--ok)}.chip.badc{background:var(--badbg);color:var(--bad)}.chip.flat{background:var(--soft);color:var(--muted)}
.zero{margin:10px 0 0;padding:8px 12px;border-radius:10px;background:var(--soft);color:var(--muted);font-size:.88rem}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.bar{display:grid;grid-template-columns:110px 1fr 56px;gap:8px;align-items:center;margin:6px 0;font-size:.9rem}
.bar i{display:block;height:10px;border-radius:6px;background:var(--accent)}.bar span{background:var(--soft);border-radius:6px;display:block}.bar em{font-style:normal;text-align:end;font-variant-numeric:tabular-nums;color:var(--muted)}
svg text{fill:var(--muted);font-size:11px;font-family:inherit}.chart{direction:ltr;width:100%;height:auto}
.legend{display:flex;gap:14px;font-size:.82rem;color:var(--muted);margin-top:6px}.legend b{display:inline-block;width:18px;height:3px;border-radius:2px;vertical-align:middle;margin-inline-end:6px}
ol,ul{margin:0;padding-inline-start:20px}li{margin:6px 0}
.rec{display:flex;gap:12px;align-items:flex-start;margin:8px 0}.rec b.n{flex:0 0 28px;height:28px;border-radius:50%;background:var(--accent);color:var(--card);display:grid;place-items:center}
@media (max-width:520px){h1{font-size:1.3rem}.kpi .v{font-size:1.55rem}.bar{grid-template-columns:90px 1fr 48px}}
@media print{body{background:#fff}.card,.kpi{break-inside:avoid}}
"""


def num(n):
    return f"{int(round(n)):,}" if isinstance(n, (int, float)) else "—"


def fmt_val(k):
    v = k["cur"]
    if v is None: return "—"
    if k["fmt"] == "pct": return f"{v:g}<small>%</small>"
    if k["fmt"] == "ratio": return f"{v:g}"
    return num(v)


def chip(k):
    cur, prev = k["cur"], k["prev"]
    if cur is None or prev is None: return '<span class="chip flat">אין השוואה</span>'
    if k["fmt"] in ("pct", "ratio"):
        diff = round(cur - prev, 2 if k["fmt"] == "ratio" else 1)
        if diff == 0: return '<span class="chip flat">ללא שינוי</span>'
        up = diff > 0; txt = f"{'+' if up else ''}{diff:g}" + (" נק׳" if k["fmt"] == "pct" else "")
    else:
        if not prev: return '<span class="chip flat">אין השוואה</span>'
        d = round((cur - prev) / prev * 100, 1)
        if d == 0: return '<span class="chip flat">ללא שינוי</span>'
        up = d > 0; txt = f"{'+' if up else ''}{d:g}%"
    good = (up and not k["bad_up"]) or (not up and k["bad_up"])
    return f'<span class="chip {"good" if good else "badc"}">{"▲" if up else "▼"} <bdi dir="ltr">{txt}</bdi></span>'


def kpi_html(k):
    note = f'<div class="muted" style="font-size:.8rem">{E(k["note"])}</div>' if k["note"] else ""
    return f'<div class="kpi"><div class="t">{E(k["title"])}</div><div class="v">{fmt_val(k)}</div>{chip(k)}{note}</div>'


def line_chart(daily):
    last = daily[-7:]; prev = daily[-14:-7]
    if len(last) < 2: return ""
    W, H, L, R, T, B = 640, 190, 38, 26, 12, 26
    vals = [x["lookups"] for x in last + prev] or [1]
    top = max(vals) * 1.1 or 1
    def X(i): return L + (W - L - R) * i / (len(last) - 1)
    def Y(v): return T + (H - T - B) * (1 - v / top)
    def path(series): return " ".join(("M" if i == 0 else "L") + f"{X(i):.1f},{Y(x['lookups']):.1f}" for i, x in enumerate(series))
    grid = "".join(f'<line x1="{L}" x2="{W-R}" y1="{Y(top*f/4):.1f}" y2="{Y(top*f/4):.1f}" stroke="var(--line)"/><text x="{L-6}" y="{Y(top*f/4)+4:.1f}" text-anchor="end">{int(top*f/4):,}</text>' for f in range(5))
    labels = "".join(f'<text x="{X(i):.1f}" y="{H-8}" text-anchor="middle">{x["date"][8:]}/{x["date"][5:7]}</text>' for i, x in enumerate(last))
    dots = "".join(f'<circle cx="{X(i):.1f}" cy="{Y(x["lookups"]):.1f}" r="3.2" fill="var(--accent)"/>' for i, x in enumerate(last))
    prevp = f'<path d="{path(prev)}" fill="none" stroke="var(--muted)" stroke-width="2" stroke-dasharray="5 4" opacity=".7"/>' if len(prev) == len(last) else ""
    return (f'<svg class="chart" viewBox="0 0 {W} {H}" role="img" aria-label="חיפושים ביום, השבוע לעומת השבוע שעבר">{grid}{labels}{prevp}'
            f'<path d="{path(last)}" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>{dots}</svg>'
            '<div class="legend"><span><b style="background:var(--accent)"></b>השבוע</span><span><b style="background:var(--muted);opacity:.7"></b>שבוע שעבר</span></div>')


def bars(rows, title, empty="אין נתונים"):
    tot = sum(r[1] for r in rows)
    if not tot: return f'<div class="card"><h2>{E(title)}</h2><p class="muted">{empty}</p></div>'
    top = max(r[1] for r in rows) or 1
    body = "".join(f'<div class="bar"><div>{r[0] if isinstance(r[0], Raw) else E(str(r[0]))}</div><span><i style="width:{max(2, r[1]/top*100):.0f}%"></i></span><em>{round(r[1]/tot*100)}%</em></div>' for r in rows)
    return f'<div class="card"><h2>{E(title)}</h2>{body}</div>'


def grid_html(title, kpis):
    """cards for numbers that moved, one quiet line for counters that sit at zero"""
    live = [k for k in kpis if not (k["fmt"] in ("n", "ratio") and not k["cur"])]
    zero = [k for k in kpis if k not in live]
    strip = f'<p class="zero">ללא פעילות השבוע: {" · ".join(E(k["title"]) for k in zero)}</p>' if zero else ""
    grid = f'<div class="grid">{"".join(kpi_html(k) for k in live)}</div>' if live else ""
    return f'<section><h2>{title}</h2>{grid}{strip}</section>'


def page(d, a):
    p = d["period"]
    status = {"green": ("green", "תקין"), "yellow": ("yellow", "דורש תשומת לב"), "red": ("red", "יש חריגות")}[a["status"]]
    al = "".join(f'<div class="al {x["level"]}"><span class="dot"></span><div><b>{E(x["title"])}</b>{E(x["detail"])}</div></div>' for x in a["anomalies"]) or '<p class="muted">אין חריגות.</p>'
    def group(title, key): return grid_html(title, a["kpis"][key])
    versions = bars([(Raw(f'גרסה <bdi dir="ltr">{E(str(v))}</bdi>'), n) for v, n in a["versions"]], "גרסאות בשימוש (משתמשים פעילים)") if a["versions"] else ""
    take = "".join(f"<li>{E(t)}</li>" for t in a["takeaways"]) or "<li>אין מספיק נתונים לסיכום.</li>"
    recs = "".join(f'<div class="rec"><b class="n">{i}</b><div>{E(r)}</div></div>' for i, r in enumerate(a["recommendations"], 1))
    return f"""<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>לוחית · דוח שבועי</title><style>{CSS}</style></head><body><main>
<header><div><h1>לוחית · דוח שבועי</h1><div class="muted">{heb_range(p["start"], p["end"])} · בהשוואה ל-{heb_range(p["prev_start"], p["prev_end"])}</div></div><span class="pill {status[0]}">{status[1]}</span></header>
<section class="two"><div class="card"><h2>תובנות מרכזיות</h2><ul>{take}</ul></div><div class="card"><h2>שלוש המלצות לשבוע הקרוב</h2>{recs}</div></section>
<section class="card"><h2>חריגות והתראות</h2><div class="alerts">{al}</div></section>
{group("בריאות המערכת", "health")}{group("מעורבות משתמשים", "engagement")}{group("שימוש ברכיבים", "usage")}{viral_html(a)}
<section class="two"><div class="card"><h2>חיפושים ביום</h2>{line_chart(a["daily"])}</div>{bars(a["dur"], "זמן עד תוצאה")}</section>
<section class="two">{bars([(r[0], r[1]) for r in a["tabs"]], "לשוניות שנפתחו")}{bars([(r[0], r[1]) for r in a["shares"]], "סוגי שיתוף")}{versions}</section>
<section class="two">{bars(a["makes"], "יצרנים שנבדקו הכי הרבה")}{bars(a["models"], "דגמים שנבדקו הכי הרבה")}</section>
<section class="two">{bars(a["fuels"], "סוג דלק או הנעה בבדיקות")}</section>
{extra_html(a)}{email_html(a, d)}
<p class="muted">נוצר אוטומטית מ-GA4 של לוחית. הנתונים אנונימיים ולא כוללים מספרי רישוי. הקובץ אינו נשמר באתר הציבורי.</p>
</main></body></html>"""


def extra_html(a):
    X = a.get("extra") or {}
    parts = []
    cf, sc, ps, pl = X.get("cloudflare"), X.get("search_console"), X.get("psi"), X.get("play")
    if cf or sc:
        ks = []
        if cf:
            ks += [kpi_html({"title": "ביקורים באתר", "cur": cf["cur"]["visits"], "prev": cf["prev"]["visits"], "fmt": "n", "bad_up": False, "note": f"{cf['cur']['views']:,} צפיות"})]
        if sc:
            ks += [kpi_html({"title": "קליקים מגוגל", "cur": sc["cur"]["clicks"], "prev": sc["prev"]["clicks"], "fmt": "n", "bad_up": False, "note": f"{sc['cur']['impressions']:,} חשיפות"}),
                   kpi_html({"title": "מיקום ממוצע בגוגל", "cur": sc["cur"]["position"], "prev": sc["prev"]["position"], "fmt": "n", "bad_up": True, "note": "נמוך יותר טוב יותר"})]
        parts.append(f'<section><h2>האתר וחיפוש בגוגל</h2><div class="grid">{"".join(ks)}</div></section>')
        rows = []
        if cf:
            SEC = {"home": "דף הבית", "model": "דפי דגמים", "magazine": "מגזין", "guide": "מדריכים", "other": "אחר"}
            rows.append(bars([(SEC[k], v) for k, v in cf["sections"].items()], "צפיות לפי אזור באתר"))
        if sc and sc["queries"]:
            rows.append(bars([(q["query"], q["clicks"]) for q in sc["queries"]], "שאילתות מובילות (קליקים)"))
        if rows: parts.append(f'<section class="two">{"".join(rows)}</section>')
    q = []
    if pl:
        q += [kpi_html({"title": "קריסות (Google Play)", "cur": pl["crash_pct"], "prev": None, "fmt": "pct", "bad_up": True, "note": "סף Play: 1.09%"}),
              kpi_html({"title": "ANR (Google Play)", "cur": pl["anr_pct"], "prev": None, "fmt": "pct", "bad_up": True, "note": "סף Play: 0.47%"})]
    for r in ps or []:
        path = r["url"].replace("https://luchit.app", "").strip("/")
        q.append(kpi_html({"title": "מהירות " + ("דף הבית" if not path else "דפי דגמים" if path.startswith("model") else path), "cur": r["score"], "prev": None, "fmt": "n", "bad_up": False, "note": f"LCP {r['lcp']} שנ׳ · CLS {r['cls']}"}))
    if q: parts.append(f'<section><h2>איכות ומהירות</h2><div class="grid">{"".join(q)}</div></section>')
    return "".join(parts)


def email_html(a, d):
    bv = (a.get("extra") or {}).get("brevo"); em = d.get("email")
    if not bv and not em: return ""
    parts = []
    if bv:
        ks = [kpi_html({"title": "מנויים פעילים", "cur": bv["total"], "prev": max(0, bv["total"] - bv["new"]["cur"]), "fmt": "n", "bad_up": False, "note": "גודל רשימת התפוצה"}),
              kpi_html({"title": "נרשמים חדשים", "cur": bv["new"]["cur"], "prev": bv["new"]["prev"], "fmt": "n", "bad_up": False, "note": "אחרי אישור כפול"}),
              kpi_html({"title": "הסרות וחסימות", "cur": bv["lost"]["cur"], "prev": bv["lost"]["prev"], "fmt": "n", "bad_up": True, "note": "מקמפיינים שיצאו בשבוע"})]
        L = bv.get("last")
        if L:
            ks += [kpi_html({"title": "פתיחות בקמפיין האחרון", "cur": L["open_pct"], "prev": None, "fmt": "pct", "bad_up": False, "note": f"{L['name']} · {L['delivered']:,} נמענים"}),
                   kpi_html({"title": "לחיצות בקמפיין האחרון", "cur": L["ctr_pct"], "prev": None, "fmt": "pct", "bad_up": False, "note": f"{L['clicks']:,} לחיצות ייחודיות"})]
        parts.append(f'<section><h2>דיוור וקהילה</h2><div class="grid">{"".join(ks)}</div>' + ('<p class="muted" style="margin:8px 0 0">שיעור הפתיחה מנופח: אפל טוענת מיילים מראש במכשירים רבים, ולכן הסף האדום (מתחת ל-20%) מתריע רק על נפילה ממשית.</p>' if L else '<p class="zero">עוד לא יצא קמפיין.</p>') + '</section>')
    if em:
        rows = "".join(f'<tr><td>{E(t)}</td><td class="n">{em[k]["cur"]:,}</td><td class="n">{em[k]["prev"]:,}</td></tr>' for k, t in (("sessions", "סשנים באפליקציה"), ("users", "משתמשים"), ("installs", "התקנות")))
        parts.append(f'<section class="card"><h2>תנועה חוזרת מהמייל</h2><div class="wrap"><table><thead><tr><th>מדד</th><th class="n">השבוע</th><th class="n">שבוע קודם</th></tr></thead><tbody>{rows}</tbody></table></div>'
                     '<p class="muted" style="margin:8px 0 0">נמדד ב-GA4 לפי utm_medium=email או utm_source=newsletter, ולכן רק אפליקציה. ביקורים באתר מהמייל נספרים כלחיצות בקמפיין למעלה, כי האתר לא שולח אירועים ל-GA4.</p></section>')
    return "".join(parts)


def viral_html(a):
    b = bars([(r[0], r[1]) for r in a["shot_tabs"]], "צילומי מסך לפי מסך") if a["shot_tabs"] else ""
    note = f'<div class="card"><h2>תובנה</h2><p style="margin:0">{E(a["shot_insight"])}</p><p class="muted" style="margin:8px 0 0">הפילוג בין אפליקציה לאתר לא נמדד: האתר לא שולח אירועים, וזיהוי צילום מסך בדפדפן לא אמין.</p></div>'
    return f'{grid_html("ויראליות ושיתופים", a["kpis"]["viral"])}<section class="two">{b}{note}</section>'
