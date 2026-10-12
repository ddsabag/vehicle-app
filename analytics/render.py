"""One self-contained HTML file: no external fonts, scripts or images, RTL, light and dark, readable on a phone."""
from html import escape as E

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
    return num(v)


def chip(k):
    cur, prev = k["cur"], k["prev"]
    if cur is None or prev is None: return '<span class="chip flat">אין השוואה</span>'
    if k["fmt"] == "pct":
        diff = round(cur - prev, 1)
        if diff == 0: return '<span class="chip flat">ללא שינוי</span>'
        up = diff > 0; txt = f"{'+' if up else ''}{diff:g} נק׳"
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
    body = "".join(f'<div class="bar"><div>{E(str(r[0]))}</div><span><i style="width:{max(2, r[1]/top*100):.0f}%"></i></span><em>{round(r[1]/tot*100)}%</em></div>' for r in rows)
    return f'<div class="card"><h2>{E(title)}</h2>{body}</div>'


def page(d, a):
    p = d["period"]
    status = {"green": ("green", "תקין"), "yellow": ("yellow", "דורש תשומת לב"), "red": ("red", "יש חריגות")}[a["status"]]
    al = "".join(f'<div class="al {x["level"]}"><span class="dot"></span><div><b>{E(x["title"])}</b>{E(x["detail"])}</div></div>' for x in a["anomalies"]) or '<p class="muted">אין חריגות.</p>'
    def group(title, key): return f'<section><h2>{title}</h2><div class="grid">{"".join(kpi_html(k) for k in a["kpis"][key])}</div></section>'
    versions = bars([(f"גרסה {v}", n) for v, n in a["versions"]], "גרסאות בשימוש (משתמשים פעילים)") if a["versions"] else ""
    take = "".join(f"<li>{E(t)}</li>" for t in a["takeaways"]) or "<li>אין מספיק נתונים לסיכום.</li>"
    recs = "".join(f'<div class="rec"><b class="n">{i}</b><div>{E(r)}</div></div>' for i, r in enumerate(a["recommendations"], 1))
    return f"""<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>לוחית · דוח שבועי</title><style>{CSS}</style></head><body><main>
<header><div><h1>לוחית · דוח שבועי</h1><div class="muted">{p["start"]} עד {p["end"]}, בהשוואה ל-{p["prev_start"]} עד {p["prev_end"]}</div></div><span class="pill {status[0]}">{status[1]}</span></header>
<section class="card"><h2>חריגות והתראות</h2><div class="alerts">{al}</div></section>
{group("בריאות המערכת", "health")}{group("מעורבות משתמשים", "engagement")}{group("שימוש ברכיבים", "usage")}
<section class="two"><div class="card"><h2>חיפושים ביום</h2>{line_chart(a["daily"])}</div>{bars(a["dur"], "זמן עד תוצאה")}</section>
<section class="two">{bars([(r[0], r[1]) for r in a["tabs"]], "לשוניות שנפתחו")}{bars([(r[0], r[1]) for r in a["shares"]], "סוגי שיתוף")}{versions}</section>
{extra_html(a)}
<section class="card"><h2>תובנות מרכזיות</h2><ul>{take}</ul></section>
<section class="card"><h2>שלוש המלצות לשבוע הקרוב</h2>{recs}</section>
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
