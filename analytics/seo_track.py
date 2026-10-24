"""Weekly SEO tracker: page rankings week over week, pages that disappeared from Google, and the outcome of each change in analytics/seo-changes.json
three weeks after it was made. State is kept on the orphan branch "seo-track" (history.enc, last 20 weekly snapshots), sealed: the repo is public
and its clicks and impressions are business numbers. A plain history.json from before is read once and deleted.
Usage: python analytics/seo_track.py <state_dir> [--dry] [--out FILE]   (needs GA_SERVICE_ACCOUNT_JSON; Telegram secrets optional)
--out FILE writes the message to FILE instead of sending it: SEO daily digest runs this on Mondays and sends it inside its own message (one SEO message).
A FILE ending in .enc is sealed too (it travels between jobs as an Actions artifact); seo-daily.mjs opens it with the same key.
The file is written before --dry stops, so a dry run still shows the combined message."""
import json, os, sys, urllib.parse, urllib.request
import re
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


# AES-256-GCM, key derived from the service account's private key (a secret both jobs already hold; no new secret to paste).
# File = 12-byte nonce + ciphertext + 16-byte tag, base64. A new service account key makes old files unreadable: the tracker then starts fresh.
SEAL_LABEL = b"luchit seo-track v1\n"


def _key():
    sa = json.loads(os.environ.get("GA_SERVICE_ACCOUNT_JSON") or "null")
    if not sa or not sa.get("private_key"): sys.exit("GA_SERVICE_ACCOUNT_JSON is needed to seal the tracker state")
    import hashlib
    return hashlib.sha256(SEAL_LABEL + sa["private_key"].encode()).digest()


def seal(text):
    import base64
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    n = os.urandom(12)
    return base64.b64encode(n + AESGCM(_key()).encrypt(n, text.encode(), None)).decode()


def unseal(blob):
    import base64
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    raw = base64.b64decode(blob)
    return AESGCM(_key()).decrypt(raw[:12], raw[12:], None).decode()


def load_history(state):
    enc, old = os.path.join(state, "history.enc"), os.path.join(state, "history.json")
    H = None
    if os.path.exists(enc):
        try: H = json.loads(unseal(open(enc).read()))
        except Exception as e: print("saved state could not be opened (new service account key?), starting fresh:", type(e).__name__)
    elif os.path.exists(old):
        H = json.load(open(old))
    if os.path.exists(old): os.remove(old)   # never travels on in plain text (artifact, branch)
    return H or {"snapshots": [], "done": []}


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
    H = load_history(state)
    cur = json.load(open(os.environ["SEO_TRACK_SAMPLE"])) if os.environ.get("SEO_TRACK_SAMPLE") else fetch_pages(end)
    if not cur:
        # an empty answer is a gap in Search Console, not a week without pages: saved, it would report every page as gone from Google now and as
        # new next week, and close the 3-week judgment of each change due now as "not enough data". The job fails and Failure alert says so.
        sys.exit(f"Search Console returned no pages for the week ending {end.isoformat()}: nothing compared or saved")
    ledger = json.load(open(os.path.join(ROOT, "analytics", "seo-changes.json"), encoding="utf-8"))
    prev = H["snapshots"][-1]["pages"] if H["snapshots"] else {}
    lines = compare(cur, prev) if prev else ["🆕 זו הרצה ראשונה של מעקב הדירוג; ההשוואה תתחיל בשבוע הבא."]
    lines += outcomes(cur, H["snapshots"], ledger, today, H["done"])
    tot_c, tot_i = sum(v["c"] for v in cur.values()), sum(v["i"] for v in cur.values())
    head = f"🔍 מעקב SEO שבועי: {len(cur)} דפים בגוגל, {tot_i} חשיפות, {tot_c} קליקים (7 ימים)."
    msg = head + "\n" + ("\n".join(lines) if lines else "אין שינוי דירוג חריג.")
    print(re.sub(r"\d", "#", msg))  # the Actions log is public: digits masked; the full text goes to --out and Telegram
    if out:
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        with open(out, "w", encoding="utf-8") as f: f.write(seal(msg) if out.endswith(".enc") else msg)
    if dry: return
    H["snapshots"] = (H["snapshots"] + [{"date": end.isoformat(), "pages": cur}])[-20:]
    os.makedirs(state, exist_ok=True)
    with open(os.path.join(state, "history.enc"), "w") as f: f.write(seal(json.dumps(H, ensure_ascii=False)))
    if not out: telegram(msg)


if __name__ == "__main__": main()
