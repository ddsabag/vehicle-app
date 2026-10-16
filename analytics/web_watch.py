"""Daily watch on the split web build (app.<hash>.js): PageSpeed mobile on the home page (median of 3), plus Google's real-user LCP (CrUX) when PSI returns it.
History is kept on the orphan branch "web-watch" (history.json, 60 days). It stays silent while things are fine and sends ONE Telegram alert when the
rollback rule trips: lab score < 88 on each of the last 3 days, or real-user LCP > 2500 ms on each of the last 2 days.
Usage: python analytics/web_watch.py <state_dir> [--dry]"""
import json, os, statistics, sys, time, urllib.parse, urllib.request
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
    if slow: why.append(f"LCP של משתמשים אמיתיים מעל {LCP_MAX/1000:g} שניות {LCP_DAYS} ימים ברצף ({', '.join(str(x) for x in f)} ms)")
    return why


def telegram(text):
    tok, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not (tok and chat): print("no telegram secrets"); return
    urllib.request.urlopen(urllib.request.Request(f"https://api.telegram.org/bot{tok}/sendMessage", data=urllib.parse.urlencode({"chat_id": chat, "text": text}).encode()), timeout=30)


def rollback():
    """With PAGES_ADMIN_TOKEN (fine-grained PAT: Pages + Variables read/write on this repo) the rollback runs by itself:
    Pages back to branch main / root and WEB_DEPLOY=false. Returns a short result line for the alert."""
    tok, repo = os.environ.get("PAGES_ADMIN_TOKEN"), os.environ.get("GITHUB_REPOSITORY", "ddsabag/vehicle-app")
    if not tok: return "אין טוקן PAGES_ADMIN_TOKEN, לכן החזרה דורשת פעולה ידנית: Pages > Source > Deploy from a branch (main, root) ו-WEB_DEPLOY=false."
    h = {"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json", "Content-Type": "application/json"}
    def call(method, path, body):
        req = urllib.request.Request(f"https://api.github.com{path}", data=json.dumps(body).encode(), headers=h, method=method)
        with urllib.request.urlopen(req, timeout=30) as r: return r.status
    try:
        call("PUT", f"/repos/{repo}/pages", {"build_type": "legacy", "source": {"branch": "main", "path": "/"}})
        call("PATCH", f"/repos/{repo}/actions/variables/WEB_DEPLOY", {"name": "WEB_DEPLOY", "value": "false"})
        return "בוצעה חזרה אוטומטית: Pages מפרסם שוב מהענף main ו-WEB_DEPLOY כבוי. האתר יתעדכן תוך דקות."
    except Exception as e:
        return f"החזרה האוטומטית נכשלה ({str(e)[:80]}). לבצע ידנית: Pages > Source > Deploy from a branch (main, root) ו-WEB_DEPLOY=false."


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
        msg = "⚠️ לוחית: מהירות האתר (הבנייה המפוצלת) מעבר לסף. " + "; ".join(why) + ".\n" + ("(הרצה יבשה, לא בוצעה חזרה)" if dry else rollback())
        print(msg)
        if not dry: telegram(msg); H["alerted"] = m["date"]
    elif not why: H["alerted"] = None
    if not dry: os.makedirs(state, exist_ok=True); json.dump(H, open(p, "w"), ensure_ascii=False)


if __name__ == "__main__": main()
