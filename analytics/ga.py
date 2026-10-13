"""Collects the numbers from the GA4 Data API (read-only). Needs GA_PROPERTY_ID and GA_SERVICE_ACCOUNT_JSON."""
import json, os
from datetime import timedelta


def _client():
    from google.analytics.data_v1beta import BetaAnalyticsDataClient
    from google.oauth2 import service_account
    info = json.loads(os.environ["GA_SERVICE_ACCOUNT_JSON"])
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/analytics.readonly"])
    return BetaAnalyticsDataClient(credentials=creds)


def _report(client, prop, ranges, dims, metrics, event=None, limit=1000):
    from google.analytics.data_v1beta.types import (DateRange, Dimension, Filter, FilterExpression, Metric, RunReportRequest)
    req = RunReportRequest(
        property=f"properties/{prop}",
        date_ranges=[DateRange(start_date=a.isoformat(), end_date=b.isoformat()) for a, b in ranges],
        dimensions=[Dimension(name=d) for d in dims],
        metrics=[Metric(name=m) for m in metrics],
        limit=limit)
    if event:
        req.dimension_filter = FilterExpression(filter=Filter(
            field_name="eventName", string_filter=Filter.StringFilter(value=event, match_type=Filter.StringFilter.MatchType.EXACT)))
    out = []
    for r in client.run_report(req).rows:
        out.append(([v.value for v in r.dimension_values], [float(v.value or 0) for v in r.metric_values]))
    return out


def _split(rows, ndims):
    """With two date ranges GA adds a `dateRange` dimension at the end: split into {key: {cur, prev}}."""
    res = {}
    for dims, mets in rows:
        rng = dims[-1]
        key = tuple(dims[:ndims]) if ndims > 1 else dims[0]
        slot = res.setdefault(key, {"cur": 0, "prev": 0})
        slot["cur" if rng == "date_range_0" else "prev"] += mets[0]
    return res


def collect(period, cfg):
    prop = os.environ["GA_PROPERTY_ID"].strip()
    c = _client()
    cur = (period["start"], period["end"]); prev = (period["prev_start"], period["prev_end"])
    notes = []
    data = {"period": {k: v.isoformat() for k, v in period.items()}, "notes": notes}

    # event totals for the two weeks
    ev = _split(_report(c, prop, [cur, prev], ["eventName"], ["eventCount"]), 1)
    data["events"] = {k: {"cur": int(v["cur"]), "prev": int(v["prev"])} for k, v in ev.items()}

    # people: with two date ranges every row ends with a `dateRange` value, even with no other dimension
    u = {}
    for name in ("activeUsers", "newUsers"):
        vals = {"cur": 0, "prev": 0}
        for dims, mets in _report(c, prop, [cur, prev], [], [name]):
            vals["cur" if dims[-1] == "date_range_0" else "prev"] = int(mets[0])
        u[name] = vals
    data["users"] = u

    # daily series: 28 days, active users and lookups
    start28 = period["end"] - timedelta(days=27)
    daily = {}
    for dims, mets in _report(c, prop, [(start28, period["end"])], ["date"], ["activeUsers"]):
        d = f"{dims[0][:4]}-{dims[0][4:6]}-{dims[0][6:]}"
        daily.setdefault(d, {})["active"] = int(mets[0])
    for dims, mets in _report(c, prop, [(start28, period["end"])], ["date"], ["eventCount"], event=cfg["events"]["lookup"]):
        d = f"{dims[0][:4]}-{dims[0][4:6]}-{dims[0][6:]}"
        daily.setdefault(d, {})["lookups"] = int(mets[0])
    data["daily"] = [{"date": d, "active": v.get("active", 0), "lookups": v.get("lookups", 0)} for d, v in sorted(daily.items())]

    # lookup breakdown by the registered custom parameters
    def by_param(event, param, quiet=False):
        try:
            return {k: {"cur": int(v["cur"]), "prev": int(v["prev"])}
                    for k, v in _split(_report(c, prop, [cur, prev], [f"customEvent:{param}"], ["eventCount"], event=event), 1).items()}
        except Exception as e:
            if not quiet: notes.append(f"הפרמטר {param} של {event} לא זמין בשבוע זה. ייתכן שעוד לא נרשם ב-GA4 או שאין עדיין נתונים.")
            return {}
    E = cfg["events"]
    data["lookup_kind"] = by_param(E["lookup"], "kind")
    data["lookup_dur"] = by_param(E["lookup"], "dur")
    data["lookup_partial"] = by_param(E["lookup"], "partial")
    data["failed_kind"] = by_param(E["lookup_failed"], "kind")
    data["share_kind"] = by_param(E["share"], "kind")
    data["make"] = by_param(E["lookup"], "make", quiet=True)    # new in 1.25, silent until the custom dimension exists
    data["model"] = by_param(E["lookup"], "model", quiet=True)    # new in 1.25, silent until the custom dimension exists
    data["fuel"] = by_param(E["lookup"], "fuel", quiet=True)    # new in 1.25, silent until the custom dimension exists
    data["tabs"] = by_param(E["tab"], "tab")
    data["upgrade_from"] = by_param(E["upgrade_open"], "from")
    data["screenshot_tab"] = by_param(E["screenshot"], "tab")

    # app versions in use
    try:
        data["versions"] = {k: int(v["cur"]) for k, v in _split(_report(c, prop, [cur, prev], ["appVersion"], ["activeUsers"]), 1).items() if k not in ("(not set)", "")}
    except Exception as e:
        data["versions"] = {}; notes.append("גרסאות האפליקציה לא היו זמינות השבוע.")
    # returning users
    try:
        nvr = _split(_report(c, prop, [cur, prev], ["newVsReturning"], ["activeUsers"]), 1)
        data["returning"] = {"cur": int(nvr.get("returning", {}).get("cur", 0)), "prev": int(nvr.get("returning", {}).get("prev", 0))}
    except Exception as e:
        data["returning"] = {"cur": 0, "prev": 0}; notes.append("נתוני משתמשים חוזרים לא היו זמינים השבוע.")
    return data
