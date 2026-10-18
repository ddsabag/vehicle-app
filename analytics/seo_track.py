"""Weekly SEO tracker: page rankings week over week, pages that disappeared from Google, and the outcome of each change in analytics/seo-changes.json
three weeks after it was made. State is kept as JSON on the orphan branch "seo-track" (history.json, last 20 weekly snapshots).
Usage: python analytics/seo_track.py <state_dir> [--dry] [--out FILE]   (needs GA_SERVICE_ACCOUNT_JSON; Telegram secrets optional)
--out FILE writes the message to FILE instead of sending it: SEO daily digest runs this on Mondays and sends it inside its own message (one SEO message).
The file is written before --dry stops, so a dry run still shows the combined message."""
import json, os, sys, urllib.parse, urllib.request
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
SITE = "sc-domain:luchit.app"
LAG = 3          # Search Console data arrives 2-3 days late
WINDOW = 21      # days a change must settle before it is judged


def fetch_pages(end):
    from sources import _google_session
    s = _google_session(["https://www.googleapis.com/auth/webmasters.readonly"])
    url = f"https://www.googleapis.com/webmasters/v3/sites/{urllib.parse.quote(SITE, safe='')}/searchAnalytics/query"
    body = {"startDate": (end - timedelta(days=6)).isoformat(), "endDate": end.isoformat(), "dimensions": ["page"], "rowLimit": 1000}
    r = s.post(url, json=body, timeout=60); r.raise_for_status()
    return {x["keys"][0]: {"c": int(x["clicks"]), "i": int(x["impressions"]), "p": round(x["position"], 1)} for x in r.json().get("rows", [])}


def short(u): return u.replace("https://luchit.app", "") or "/"


def agg(pages, prefix):
    rows = [v for u, v in pages.items() if (u.startswith(prefix[:-1]) if prefix.endswith("*") else u == prefix)]
    i = sum(v["i"] for v in rows); c = sum(v["c"] for v in rows)
    if not i: return None
    return {"i": i, "c": c, "ctr": round(c / i * 100, 1), "p": round(sum(v["p"] * v["i"] for v in rows) / i, 1)}


def compare(cur, prev):
    lines = []
    top = sorted(cur.items(), key=lambda kv: -kv[1]["i"])[:10]
    for u, v in top:
        o = prev.get(u)
        if o and o["i"] >= 10 and v["p"] - o["p"] >= 3:
            lines.append(f"⬇️ {short(u)}: מקום {o['p']:g} ← {v['p']:g} ({v['i']} חשיפות)")
    gone = [u for u, o in prev.items() if o["i"] >= 10 and u not in cur]
    if gone:
        lines.append("🕳️ נעלמו מגוגל השבוע (היו ≥10 חשיפות): " + ", ".join(short(u) for u in gone[:5]) + (" ועוד" if len(gone) > 5 else ""))
    new = [u for u, v in cur.items() if u not in prev and v["i"] >= 3]
    if new:
        lines.append(f"🌱 {len(new)} דפים חדשים מופיעים בגוגל, למשל " + ", ".join(short(u) for u in new[:3]))
    return lines


def outcomes(cur, hist, ledger, today, done):
    lines = []
    for key, e in ledger.items():
        if key.startswith("_") or not isinstance(e, dict) or not e.get("date"): continue
        d = date.fromisoformat(e["date"])
        if (today - d).days < WINDOW or key + "@" + e["date"] in done: continue
        base = None
        for snap in hist:                     # newest snapshot taken on or before the change date
            if date.fromisoformat(snap["date"]) <= d: base = snap["pages"]
        a, b = (agg(base, key) if base else None), agg(cur, key)
        done.append(key + "@" + e["date"])
        if not a or not b:
            lines.append(f"📋 {short(key)} ({e['date']}): אין מספיק נתונים להשוואה לפני/אחרי.")
            continue
        verdict = "שיפור" if b["p"] < a["p"] - 0.5 or b["ctr"] > a["ctr"] + 0.5 else "ירידה" if b["p"] > a["p"] + 1.5 or b["ctr"] < a["ctr"] - 0.5 else "ללא שינוי ברור"
        lines.append(f"📋 {short(key)} ({e['date']}, {e.get('what', '')[:50]}): מקום {a['p']:g} ← {b['p']:g}, הקלקות {a['ctr']:g}% ← {b['ctr']:g}%. {verdict}.")
    return lines


def telegram(text):
    tok, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not (tok and chat): print("no telegram secrets"); return
    data = urllib.parse.urlencode({"chat_id": chat, "text": text, "disable_notification": "true"}).encode()
    urllib.request.urlopen(urllib.request.Request(f"https://api.telegram.org/bot{tok}/sendMessage", data=data), timeout=30)


def main():
    state, dry = sys.argv[1], "--dry" in sys.argv
    out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv[:-1] else None
    today = date.today(); end = today - timedelta(days=LAG)
    p = os.path.join(state, "history.json")
    H = json.load(open(p)) if os.path.exists(p) else {"snapshots": [], "done": []}
    cur = json.load(open(os.environ["SEO_TRACK_SAMPLE"])) if os.environ.get("SEO_TRACK_SAMPLE") else fetch_pages(end)
    ledger = json.load(open(os.path.join(ROOT, "analytics", "seo-changes.json"), encoding="utf-8"))
    prev = H["snapshots"][-1]["pages"] if H["snapshots"] else {}
    lines = compare(cur, prev) if prev else ["🆕 זו הרצה ראשונה של מעקב הדירוג; ההשוואה תתחיל בשבוע הבא."]
    lines += outcomes(cur, H["snapshots"], ledger, today, H["done"])
    tot_c, tot_i = sum(v["c"] for v in cur.values()), sum(v["i"] for v in cur.values())
    head = f"🔍 מעקב SEO שבועי: {len(cur)} דפים בגוגל, {tot_i} חשיפות, {tot_c} קליקים (7 ימים)."
    msg = head + "\n" + ("\n".join(lines) if lines else "אין שינוי דירוג חריג.")
    print(msg)
    if out:
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        with open(out, "w", encoding="utf-8") as f: f.write(msg)
    if dry: return
    H["snapshots"] = (H["snapshots"] + [{"date": end.isoformat(), "pages": cur}])[-20:]
    os.makedirs(state, exist_ok=True); json.dump(H, open(p, "w"), ensure_ascii=False)
    if not out: telegram(msg)


if __name__ == "__main__": main()
