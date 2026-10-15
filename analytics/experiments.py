"""The Experimenter: reads the wording experiments from GA4, and when one variant is clearly better, writes the winner into experiments.json.
Exposure = event exp_expose, result = event named in RESULTS (both carry the custom event dimensions exp and exp_v).
A winner needs MIN_EXPOSED exposures per variant, a two-proportion z-test above Z_MIN and a relative lift of at least MIN_LIFT.
Needs GA_PROPERTY_ID and GA_SERVICE_ACCOUNT_JSON. Usage: python analytics/experiments.py [--selftest] [--dry]"""
import json, math, os, sys, urllib.parse, urllib.request
from datetime import date, timedelta

RESULTS = {"share_label": "share"}     # experiment -> the event that counts as a success
MIN_EXPOSED, Z_MIN, MIN_LIFT = 400, 1.96, 0.05
FILE = "experiments.json"


def decide(stats):
    """stats: {variant(str): (exposed, converted)} -> (winner index or None, summary text)."""
    rows = sorted((int(v), e, c) for v, (e, c) in stats.items())
    if len(rows) < 2 or any(e < MIN_EXPOSED for _, e, _ in rows):
        return None, "עדיין אין מספיק נתונים: " + ", ".join(f"{v}: {e} חשיפות" for v, e, _ in rows)
    best = max(rows, key=lambda r: r[2] / r[1])
    ctrl = rows[0]
    if best[0] == ctrl[0]:
        others = [r for r in rows if r[0] != ctrl[0]]
        best_other = max(others, key=lambda r: r[2] / r[1])
        a, b = ctrl, best_other
    else:
        a, b = ctrl, best
    p1, p2 = a[2] / a[1], b[2] / b[1]
    p = (a[2] + b[2]) / (a[1] + b[1])
    se = math.sqrt(p * (1 - p) * (1 / a[1] + 1 / b[1])) or 1e-9
    z = (p2 - p1) / se
    summary = ", ".join(f"{v}: {c}/{e} ({c / e:.1%})" for v, e, c in rows) + f", z={z:.2f}"
    if abs(z) >= Z_MIN and abs(p2 - p1) / max(min(p1, p2), 1e-9) >= MIN_LIFT:
        return (b[0] if p2 > p1 else a[0]), summary
    return None, "אין הבדל מובהק: " + summary


def selftest():
    assert decide({"0": (100, 5), "1": (100, 9)})[0] is None
    assert decide({"0": (1000, 50), "1": (1000, 52)})[0] is None
    assert decide({"0": (1000, 50), "1": (1000, 90)})[0] == 1
    assert decide({"0": (1000, 90), "1": (1000, 50)})[0] == 0
    print("selftest ok")


def counts(client, prop, event, since):
    import ga
    rows = ga._report(client, prop, [(since, date.today())], ["customEvent:exp", "customEvent:exp_v"], ["eventCount"], event=event)
    out = {}
    for (e, v), (n,) in rows:
        if e and e != "(not set)" and v and v != "(not set)": out.setdefault(e, {})[v] = int(n)
    return out


def telegram(text):
    tok, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not (tok and chat): print(text); return
    data = urllib.parse.urlencode({"chat_id": chat, "text": text, "disable_notification": "true"}).encode()
    urllib.request.urlopen(urllib.request.Request(f"https://api.telegram.org/bot{tok}/sendMessage", data=data), timeout=30)


def main():
    sys.path.insert(0, os.path.dirname(__file__))
    import ga
    prop, client = os.environ["GA_PROPERTY_ID"].strip(), ga._client()
    cfg = json.load(open(FILE, encoding="utf8"))
    since = date.today() - timedelta(days=28)
    expo = counts(client, prop, "exp_expose", since)
    changed = []
    for name, event in RESULTS.items():
        cur = cfg.setdefault(name, {})
        if cur.get("winner") is not None or cur.get("off"): continue      # a decided or switched-off experiment is left alone
        res = counts(client, prop, event, since).get(name, {})
        stats = {v: (n, res.get(v, 0)) for v, n in expo.get(name, {}).items()}
        win, summary = decide(stats)
        print(name, win, summary)
        if win is not None:
            cur["winner"] = win; cur["decided"] = date.today().isoformat(); cur["summary"] = summary
            changed.append(f"ניסוי {name}: המנצח הוא וריאנט {win}. {summary}")
    if changed and "--dry" not in sys.argv:
        json.dump(cfg, open(FILE, "w", encoding="utf8"), ensure_ascii=False, indent=1)
        open("out-experiments.txt", "w", encoding="utf8").write("\n".join(changed))
        telegram("🧪 לוחית: ניסוי הסתיים\n" + "\n".join(changed))


if __name__ == "__main__":
    selftest() if "--selftest" in sys.argv else main()
