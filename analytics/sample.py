"""Synthetic numbers shaped like the real GA4 output, for testing the layout and the alert rules without a connection."""
import random
from datetime import timedelta


def make(period, scenario="busy"):
    rnd = random.Random(7)
    days = [period["end"] - timedelta(days=27 - i) for i in range(28)]
    daily = []
    for i, dt in enumerate(days):
        base = 150 + 6 * i + rnd.randint(-18, 18) + (40 if dt.weekday() in (5, 6) else 0)
        daily.append({"date": dt.isoformat(), "active": int(base * 0.46), "lookups": base})
    if scenario == "incident":
        daily[-1]["lookups"] = 40
    lk_c = sum(x["lookups"] for x in daily[-7:]); lk_p = sum(x["lookups"] for x in daily[-14:-7])
    slow = (0.062 if scenario == "incident" else 0.021)
    ev = {
        "car_lookup": (lk_c, lk_p), "lookup_failed": (int(lk_c * 0.04), int(lk_p * 0.03)),
        "lookup_slow": (int(lk_c * slow), int(lk_p * 0.02)), "lookup_abort": (int(lk_c * (0.05 if scenario == "incident" else 0.02)), int(lk_p * 0.02)),
        "lookup_timeout": (4, 1), "lookup_from_cache": (9, 0), "share": (int(lk_c * 0.14), int(lk_p * 0.16)), "compare_open": (int(lk_c * 0.07), int(lk_p * 0.06)),
        "car_save": (int(lk_c * 0.09), int(lk_p * 0.08)), "tab_view": (int(lk_c * 1.4), int(lk_p * 1.3)), "user_screenshot": (int(lk_c * 0.11), int(lk_p * 0.06)), "upgrade_open": (6, 4), "upgrade_purchase_start": (0, 0), "trial_start": (3, 2),
    }
    wau_c = int(sum(x["active"] for x in daily[-7:]) * 0.55); wau_p = int(sum(x["active"] for x in daily[-14:-7]) * 0.55)
    def split(total_c, total_p, shares):
        return {k: {"cur": int(total_c * s), "prev": int(total_p * s)} for k, s in shares.items()}
    ok_c, ok_p = lk_c, lk_p
    return {
        "period": {k: v.isoformat() for k, v in period.items()}, "notes": [],
        "events": {k: {"cur": a, "prev": b} for k, (a, b) in ev.items()},
        "users": {"activeUsers": {"cur": wau_c, "prev": wau_p}, "newUsers": {"cur": int(wau_c * 0.38), "prev": int(wau_p * 0.35)}},
        "returning": {"cur": int(wau_c * 0.55), "prev": int(wau_p * 0.5)},
        "daily": daily,
        "lookup_kind": split(ok_c, ok_p, {"car": 0.86, "model": 0.1, "cancelled": 0.04}),
        "lookup_dur": split(ok_c, ok_p, {"lt2": 0.62, "2to5": 0.26, "5to10": 0.09, "gt10": 0.03}),
        "lookup_partial": split(ok_c, ok_p, {"0": 0.95, "1": 0.05}),
        "failed_kind": split(ev["lookup_failed"][0], ev["lookup_failed"][1], {"not_found": 0.6, "offline": 0.3, "source_down": 0.1}),
        "share_kind": split(ev["share"][0], ev["share"][1], {"pdf": 0.45, "image": 0.5, "text": 0.05}),
        "make": split(ok_c, ok_p, {"טויוטה": 0.2, "יונדאי": 0.15, "קיה": 0.12, "מאזדה": 0.1, "סקודה": 0.08}),
        "model": split(ok_c, ok_p, {"COROLLA": 0.07, "TUCSON": 0.05, "OCTAVIA": 0.04}),
        "fuel": split(ok_c, ok_p, {"בנזין": 0.6, "היברידי": 0.2, "חשמל": 0.1, "דיזל": 0.1}),
        "tabs": split(ev["tab_view"][0], ev["tab_view"][1], {"overview": 0.3, "buy": 0.24, "file": 0.14, "recalls": 0.2, "specs": 0.12}),
        "screenshot_tab": split(ev["user_screenshot"][0], ev["user_screenshot"][1], {"overview": 0.2, "buy": 0.4, "file": 0.1, "recalls": 0.2, "specs": 0.05, "cars": 0.05}),
        "upgrade_from": {"home": {"cur": 4, "prev": 3}, "file": {"cur": 2, "prev": 1}},
        "email": {"sessions": {"cur": 31, "prev": 18}, "users": {"cur": 24, "prev": 15}, "installs": {"cur": 6, "prev": 3}},
        "versions": {"1.23": int(wau_c * 0.5), "1.22": int(wau_c * 0.3), "1.21": int(wau_c * 0.1)},
    }


def extras(scenario="busy"):
    bad = scenario == "incident"
    return {
        "search_console": {"cur": {"clicks": 212, "impressions": 9400, "position": 14.2, "ctr": 2.3}, "prev": {"clicks": 150 if not bad else 340, "impressions": 7100, "position": 15.9, "ctr": 2.1}, "sections": {"home": 3000, "model": 5200, "magazine": 900, "guide": 150, "other": 150},
                           "queries": [{"query": "בדיקת רכב לפי מספר", "clicks": 40, "impressions": 1100}, {"query": "ריקול קורולה", "clicks": 22, "impressions": 640}, {"query": "היסטוריית בעלויות רכב", "clicks": 18, "impressions": 900}],
                           "pages": [{"page": "https://luchit.app/", "clicks": 120, "impressions": 3000}, {"page": "https://luchit.app/model/toyota-corolla/", "clicks": 25, "impressions": 800}]},
        "cloudflare": {"cur": {"views": 3400, "visits": 2100}, "prev": {"views": 2800, "visits": 1800}, "sections": {"home": 1500, "model": 1200, "magazine": 450, "guide": 120, "other": 130}},
        "psi": [{"url": "https://luchit.app/", "score": 93 if not bad else 64, "lcp": 2.1 if not bad else 4.6, "cls": 0.0, "tbt": 80}, {"url": "https://luchit.app/model/", "score": 100, "lcp": 0.9, "cls": 0.0, "tbt": 0}],
        "brevo": {"total": 1240, "new": {"cur": 42, "prev": 31}, "lost": {"cur": 9 if not bad else 40, "prev": 6},
                  "last": {"name": "magazine-2026-09", "sent_date": "2026-10-08", "delivered": 1190, "opens": 570 if not bad else 150, "clicks": 140, "unsubs": 11 if not bad else 40, "bounces": 6, "open_pct": 47.9 if not bad else 12.6, "ctr_pct": 11.8, "unsub_pct": 0.9 if not bad else 3.4, "age_days": 3}},
        "play": {"crash_pct": 0.3 if not bad else 1.4, "anr_pct": 0.1},
    }
