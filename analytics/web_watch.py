"""Daily watch on the split web build (app.<hash>.js): PageSpeed mobile on the home page (median of 3), plus Google's real-user LCP (CrUX) when PSI returns it.
History is kept on the orphan branch "web-watch" (history.json, 60 days). It stays silent while things are fine and sends ONE Telegram alert when the
rollback rule trips: lab score < 88 on each of the last 3 days, or real-user LCP > 2500 ms on each of the last 2 days. The same alert goes to the
/live dashboard (flash.mjs, needs node and GITHUB_TOKEN). A Telegram error does not stop the state save; it is reported as telegram_failed=1 in GITHUB_OUTPUT.
Usage: python analytics/web_watch.py <state_dir> [--dry]"""
import json, os, statistics, subprocess, sys, time, urllib.parse, urllib.request
from datetime import date

URL = "https://luchit.app/"
SCORE_MIN, SCORE_DAYS, LCP_MAX, LCP_DAYS = 88, 3, 2500, 2


def psi_once():
    q = {"url": URL, "strategy": "mobile", "category": "performance"}
    if os.environ.get("PSI_API_KEY"): q["key"] = os.environ["PSI_API_KEY"]
    for wait in (0, 20, 45, 90):
        time.sleep(wait)
        try:
            with urllib.request.urlopen("https://www.googleapis.com/pagespeedonline/v5/runPagespeed?" + urllib.parse.urlencode(q), timeout=120) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            err = e
    raise err


def measure():
    runs = [psi_once() for _ in range(3)]
    sc = [round(j["lighthouseResult"]["categories"]["performance"]["score"] * 100) for j in runs]
    lcp = [j["lighthouseResult"]["audits"]["largest-contentful-paint"]["numericValue"] for j in runs]
    field = None
    try: field = runs[-1]["loadingExperience"]["metrics"]["LARGEST_CONTENTFUL_PAINT_MS"]["percentile"]
    except Exception: pass
    return {"date": date.today().isoformat(), "score": int(statistics.median(sc)), "lcp_ms": int(statistics.median(lcp)), "field_lcp_ms": field}


def verdict(hist):
    last = hist[-SCORE_DAYS:]
    low = len(last) == SCORE_DAYS and all(h["score"] < SCORE_MIN for h in last)
    f = [h["field_lcp_ms"] for h in hist[-LCP_DAYS:]]
    slow = len(f) == LCP_DAYS and all(x is not None and x > LCP_MAX for x in f)
    why = []
    if low: why.append(f"ציון המובייל מתחת ל-{SCORE_MIN} {SCORE_DAYS} ימים ברצף ({', '.join(str(h['score']) for h in last)})")
    if slow: why.append(f"אצל משתמשים אמיתיים התוכן הראשי נטען אחרי יותר מ-{LCP_MAX/1000:g} שניות {LCP_DAYS} ימים ברצף ({', '.join(f'{x/1000:.1f}' for x in f)} שניות)")
    return why


def telegram(text):
    """False only when Telegram did not take the message (missing secrets just print)."""
    tok, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not (tok and chat): print("no telegram secrets"); return True
    try:
        urllib.request.urlopen(urllib.request.Request(f"https://api.telegram.org/bot{tok}/sendMessage", data=urllib.parse.urlencode({"chat_id": chat, "text": text}).encode()), timeout=30)
        return True
    except Exception as e:
        print("telegram failed:", str(e)[:120]); return False


def flash(text):
    """An 'infra alert' entry on the /live dashboard, like the other agents' alerts. Never fails the run."""
    run, repo = os.environ.get("GITHUB_RUN_ID"), os.environ.get("GITHUB_REPOSITORY", "ddsabag/vehicle-app")
    link = [f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{repo}/actions/runs/{run}"] if run else []
    js = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".github", "scripts", "flash.mjs")
    sys.stdout.flush()
    try: subprocess.run(["node", js, "infra", "alert", text] + link, timeout=120)
    except Exception as e: print("flash skipped:", str(e)[:120])


def rollback():
    """With PAGES_ADMIN_TOKEN (fine-grained PAT: Pages + Variables read/write on this repo) the rollback runs by itself:
    Pages back to branch main / root and WEB_DEPLOY=false. Returns a short result line for the alert."""
    tok, repo = os.environ.get("PAGES_ADMIN_TOKEN"), os.environ.get("GITHUB_REPOSITORY", "ddsabag/vehicle-app")
    if not tok: return "MANUAL"
    h = {"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json", "Content-Type": "application/json"}
    def call(method, path, body):
        req = urllib.request.Request(f"https://api.github.com{path}", data=json.dumps(body).encode(), headers=h, method=method)
        with urllib.request.urlopen(req, timeout=30) as r: return r.status
    try:
        call("PUT", f"/repos/{repo}/pages", {"build_type": "legacy", "source": {"branch": "main", "path": "/"}})
        call("PATCH", f"/repos/{repo}/actions/variables/WEB_DEPLOY", {"name": "WEB_DEPLOY", "value": "false"})
        return "DONE"
    except Exception as e:
        return "MANUAL:" + str(e)[:200]


def main():
    state, dry = sys.argv[1], "--dry" in sys.argv
    p = os.path.join(state, "history.json")
    H = json.load(open(p)) if os.path.exists(p) else {"days": [], "alerted": None}
    m = json.load(open(os.environ["WEB_WATCH_SAMPLE"])) if os.environ.get("WEB_WATCH_SAMPLE") else measure()
    H["days"] = [d for d in H["days"] if d["date"] != m["date"]] + [m]
    H["days"] = H["days"][-60:]
    print(m)
    why = verdict(H["days"])
    if why and H.get("alerted") != m["date"]:
        # the shared message shape of .github/scripts/tg-text.mjs: classification line, short text, what to do (English detail last)
        rb = "DRY" if dry else rollback()
        msg = ("🟠 לטיפול היום · אתר\nהאתר נהיה איטי מעבר לסף\n" + "; ".join(why) + ".\n" +
               {"DRY": "(הרצת ניסיון, לא הוחזר כלום.)\n👌 לא צריך לעשות כלום.",
                "DONE": "האתר הוחזר אוטומטית לגרסה הפשוטה (בלי הבנייה המפוצלת), והוא יתעדכן תוך כמה דקות.\n👉 מה לעשות: לכתוב לי בשרשור \"תפעול, בוטים ומייל\" כדי שאבדוק מה האט את האתר."}.get(rb,
               "החזרה האוטומטית לגרסה הפשוטה לא בוצעה.\n👉 מה לעשות: לכתוב לי בשרשור \"תפעול, בוטים ומייל\", ואחזיר אותה." +
               (f"\nפרטים טכניים: {rb[7:]}" if rb.startswith("MANUAL:") else "")))
        print(msg)
        if not dry:
            flash(msg)
            if not telegram(msg) and os.environ.get("GITHUB_OUTPUT"): open(os.environ["GITHUB_OUTPUT"], "a").write("telegram_failed=1\n")
            H["alerted"] = m["date"]
    elif not why: H["alerted"] = None
    if not dry: os.makedirs(state, exist_ok=True); json.dump(H, open(p, "w"), ensure_ascii=False)


if __name__ == "__main__": main()
