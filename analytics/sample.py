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
        "car_save": (int(lk_c * 0.09), int(lk_p * 0.08)), "tab_view": (int(lk_c * 1.4), int(lk_p * 1.3)), "upgrade_open": (6, 4), "upgrade_purchase_start": (0, 0), "trial_start": (3, 2),
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
        "tabs": split(ev["tab_view"][0], ev["tab_view"][1], {"overview": 0.3, "buy": 0.24, "maint": 0.14, "recalls": 0.2, "specs": 0.12}),
        "upgrade_from": {"home": {"cur": 4, "prev": 3}, "maint": {"cur": 2, "prev": 1}},
        "versions": {"1.23": int(wau_c * 0.5), "1.22": int(wau_c * 0.3), "1.21": int(wau_c * 0.1)},
    }
