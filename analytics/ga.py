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


def _report(client, prop, ranges, dims, metrics, event=None, limit=1000, app_only=False):
    """app_only: the Android stream only. Web beacons (/api/e) carry a fresh client_id per page load, so property-wide user counts would count page loads as people."""
    from google.analytics.data_v1beta.types import (DateRange, Dimension, Filter, FilterExpression, FilterExpressionList, Metric, RunReportRequest)
    req = RunReportRequest(
        property=f"properties/{prop}",
        date_ranges=[DateRange(start_date=a.isoformat(), end_date=b.isoformat()) for a, b in ranges],
        dimensions=[Dimension(name=d) for d in dims],
        metrics=[Metric(name=m) for m in metrics],
        limit=limit)
    flt = []
    if event:
        flt.append(FilterExpression(filter=Filter(field_name="eventName", string_filter=Filter.StringFilter(value=event, match_type=Filter.StringFilter.MatchType.EXACT))))
    if app_only:
        flt.append(FilterExpression(filter=Filter(field_name="platform", string_filter=Filter.StringFilter(value="Android", match_type=Filter.StringFilter.MatchType.EXACT))))
    if len(flt) == 1: req.dimension_filter = flt[0]
    elif flt: req.dimension_filter = FilterExpression(and_group=FilterExpressionList(expressions=flt))
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


def _email_traffic(c, prop, cur, prev):
    """Sessions, users and installs that carry email attribution (utm_medium=email or utm_source=newsletter).
    Only what GA4 sees: the Android app (Firebase). Web visits are not sent to GA4; clicks to the site come from Brevo."""
    from google.analytics.data_v1beta.types import (DateRange, Filter, FilterExpression, FilterExpressionList, Metric, RunReportRequest, Dimension)
    def f(field, value): return FilterExpression(filter=Filter(field_name=field, string_filter=Filter.StringFilter(value=value, match_type=Filter.StringFilter.MatchType.EXACT)))
    def run(metrics, flt):
        req = RunReportRequest(property=f"properties/{prop}", date_ranges=[DateRange(start_date=a.isoformat(), end_date=b.isoformat()) for a, b in (cur, prev)],
                               metrics=[Metric(name=m) for m in metrics], dimension_filter=flt)
        out = {m: {"cur": 0, "prev": 0} for m in metrics}
        for r in c.run_report(req).rows:
            slot = "cur" if r.dimension_values and r.dimension_values[-1].value == "date_range_0" else "prev"
            for m, v in zip(metrics, r.metric_values): out[m][slot] = int(float(v.value or 0))
        return out
    email = FilterExpression(or_group=FilterExpressionList(expressions=[f("sessionMedium", "email"), f("sessionSource", "newsletter")]))
    t = run(["sessions", "totalUsers"], email)
    inst = run(["eventCount"], FilterExpression(and_group=FilterExpressionList(expressions=[f("eventName", "first_open"), f("firstUserMedium", "email")])))
    return {"sessions": t["sessions"], "users": t["totalUsers"], "installs": inst["eventCount"]}


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
        for dims, mets in _report(c, prop, [cur, prev], [], [name], app_only=True):
            vals["cur" if dims[-1] == "date_range_0" else "prev"] = int(mets[0])
        u[name] = vals
    data["users"] = u

    # daily series: 28 days, active users and lookups
    start28 = period["end"] - timedelta(days=27)
    daily = {}
    for dims, mets in _report(c, prop, [(start28, period["end"])], ["date"], ["activeUsers"], app_only=True):
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
    data["nores_kind"] = by_param(E["no_result"], "kind", quiet=True)
    data["nores_term"] = by_param(E["no_result"], "term", quiet=True)    # new in 1.26, silent until the custom dimension `term` exists
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
        nvr = _split(_report(c, prop, [cur, prev], ["newVsReturning"], ["activeUsers"], app_only=True), 1)
        data["returning"] = {"cur": int(nvr.get("returning", {}).get("cur", 0)), "prev": int(nvr.get("returning", {}).get("prev", 0))}
    except Exception as e:
        data["returning"] = {"cur": 0, "prev": 0}; notes.append("נתוני משתמשים חוזרים לא היו זמינים השבוע.")
    try:
        data["email"] = _email_traffic(c, prop, cur, prev)
    except Exception as e:
        import sys; print(f"email attribution failed: {type(e).__name__}: {str(e)[:200]}", file=sys.stderr)
        data["email"] = None
    return data
