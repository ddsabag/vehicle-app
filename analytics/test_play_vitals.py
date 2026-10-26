#!/usr/bin/env python3
"""Offline test of the weekly report's Google Play vitals source (sources.play_vitals): the session is faked, no network.
Checks: the 7 days end where Google's DAILY data ends (the freshness of each set), never after the day before the report's last day;
a freshness that cannot be read keeps that day; a refused query fails with Google's reason; rows are weighted by users.
  python3 -I -B analytics/test_play_vitals.py"""
import os, sys
from datetime import date
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import sources  # noqa: E402
n = bad = 0
def ok(c, m):
    global n, bad; n += 1
    if not c: bad += 1; print("FAIL", m)

class R:
    def __init__(self, code, body): self.status_code, self.ok, self._b = code, 200 <= code < 300, body
    def json(self):
        if isinstance(self._b, Exception): raise self._b
        return self._b
    @property
    def text(self): return str(self._b)

def run(fresh, post=None, end=date(2026, 10, 24)):
    """fresh: {set: latestEndTime dict | None | 'fail'}; returns (result or exception, the bodies posted per set)"""
    sent = {}
    class S:
        def get(self, url, timeout=None):
            kind = url.rsplit("/", 1)[1]; f = fresh.get(kind)
            if f == "fail": return R(403, {"error": {"message": "no"}})
            if f == "bad": return R(200, ValueError("not json"))
            return R(200, {"name": kind, "freshnessInfo": {"freshnesses": ([{"aggregationPeriod": "HOURLY", "latestEndTime": {"year": 2026, "month": 10, "day": 26, "hours": 5}}]
                                                                              + ([{"aggregationPeriod": "DAILY", "latestEndTime": f}] if f else []))}})
        def post(self, url, json=None, timeout=None):
            kind = url.rsplit("/", 1)[1].split(":")[0]; sent[kind] = json
            return post(kind, json) if post else R(200, {"rows": []})
    sources._google_session = lambda scopes: S()
    try: res = sources.play_vitals({"start": date(2026, 10, 18), "end": end}, {"sources": {"play_package": "com.example"}})
    except Exception as e: res = e
    return res, sent

def span(body):
    t = body["timelineSpec"]; d = lambda x: date(x["year"], x["month"], x["day"])
    return d(t["startTime"]), d(t["endTime"]), t["startTime"]["timeZone"]["id"], t["aggregationPeriod"]

# Google's DAILY data ends 21.10 (the 25.10 case: "two days ago" asked up to 23.10 and got 400)
res, sent = run({"crashRateMetricSet": {"year": 2026, "month": 10, "day": 21, "timeZone": {"id": "America/Los_Angeles"}}, "anrRateMetricSet": {"year": 2026, "month": 10, "day": 22}})
ok(res == {"crash_pct": None, "anr_pct": None}, f"no rows -> None: {res}")
ok(span(sent["crashRateMetricSet"]) == (date(2026, 10, 14), date(2026, 10, 21), "America/Los_Angeles", "DAILY"), f"crash ends at its freshness: {span(sent['crashRateMetricSet'])}")
ok(span(sent["anrRateMetricSet"])[:2] == (date(2026, 10, 15), date(2026, 10, 22)), f"each set by its own freshness: {span(sent['anrRateMetricSet'])}")
# fresher than the report: the old window, ending the day before the report's last day (exclusive), 7 days
res, sent = run({"crashRateMetricSet": {"year": 2026, "month": 10, "day": 26}, "anrRateMetricSet": {"year": 2026, "month": 10, "day": 25}})
ok(span(sent["crashRateMetricSet"])[:2] == (date(2026, 10, 16), date(2026, 10, 23)), f"capped at the report: {span(sent['crashRateMetricSet'])}")
# freshness refused, unreadable, or no DAILY entry: the old window
for f in ("fail", "bad", None):
    res, sent = run({"crashRateMetricSet": f, "anrRateMetricSet": f})
    ok(span(sent["crashRateMetricSet"])[:2] == (date(2026, 10, 16), date(2026, 10, 23)) and not isinstance(res, Exception), f"freshness {f}: {span(sent['crashRateMetricSet'])} {res}")
# a refused query: the reason in the error (it goes to the Actions log only), whitespace folded, short
res, _ = run({}, post=lambda kind, body: R(400, {"error": {"code": 400, "message": "Requested end time is after the latest available data.\n  Try   earlier.", "status": "INVALID_ARGUMENT"}}))
ok(isinstance(res, RuntimeError) and "crashRateMetricSet 400" in str(res) and "latest available data" in str(res) and "\n" not in str(res) and len(str(res)) < 200, f"400 reason: {res!r}")
# rows weighted by users: (1% x 100 + 3% x 300) / 400 = 2.5%
rows = {"rows": [{"metrics": [{"metric": "userPerceivedCrashRate", "decimalValue": {"value": "0.01"}}, {"metric": "distinctUsers", "decimalValue": {"value": "100"}}]},
                 {"metrics": [{"metric": "userPerceivedCrashRate", "decimalValue": {"value": "0.03"}}, {"metric": "distinctUsers", "decimalValue": {"value": "300"}}]},
                 {"metrics": [{"metric": "userPerceivedCrashRate", "decimalValue": {"value": "0.5"}}]}]}
res, _ = run({}, post=lambda kind, body: R(200, rows if kind == "crashRateMetricSet" else {}))
ok(res == {"crash_pct": 2.5, "anr_pct": None}, f"weighted: {res}")
print(f"play vitals: {n - bad}/{n} ok"); sys.exit(1 if bad else 0)
