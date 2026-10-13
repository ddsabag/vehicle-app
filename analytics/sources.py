"""Optional extra sources. Each one runs only when its secret exists, and a failure is a note in the report, never a crash.
  Search Console (clicks, impressions, queries)   needs GA_SERVICE_ACCOUNT_JSON added as a user of the property
  Cloudflare Web Analytics (site visits, paths)    needs CF_API_TOKEN + CF_ACCOUNT_ID
  PageSpeed Insights (speed of the site)           works without a key, PSI_API_KEY is optional
  Google Play vitals (crash and ANR rate)          needs the same service account added in Play Console
"""
import json, os, time, urllib.parse, urllib.request
from datetime import timedelta


def _http(url, data=None, headers=None, timeout=60):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method="POST" if data is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _google_session(scopes):
    from google.auth.transport.requests import AuthorizedSession
    from google.oauth2 import service_account
    info = json.loads(os.environ["GA_SERVICE_ACCOUNT_JSON"])
    return AuthorizedSession(service_account.Credentials.from_service_account_info(info, scopes=scopes))


def search_console(per, cfg):
    site = cfg["sources"]["search_console_site"]
    s = _google_session(["https://www.googleapis.com/auth/webmasters.readonly"])
    url = f"https://www.googleapis.com/webmasters/v3/sites/{urllib.parse.quote(site, safe='')}/searchAnalytics/query"
    lag = timedelta(days=3)   # Search Console numbers arrive 2-3 days late
    def q(a, b, dims=None, limit=10):
        body = {"startDate": (a - lag).isoformat(), "endDate": (b - lag).isoformat(), "rowLimit": limit}
        if dims: body["dimensions"] = dims
        r = s.post(url, json=body, timeout=60); r.raise_for_status(); return r.json().get("rows", [])
    def tot(a, b):
        rows = q(a, b)
        return {"clicks": int(rows[0]["clicks"]), "impressions": int(rows[0]["impressions"]), "position": round(rows[0]["position"], 1)} if rows else {"clicks": 0, "impressions": 0, "position": None}
    top = [{"query": r["keys"][0], "clicks": int(r["clicks"]), "impressions": int(r["impressions"])} for r in q(per["start"], per["end"], ["query"], 8)]
    pages = [{"page": r["keys"][0], "clicks": int(r["clicks"]), "impressions": int(r["impressions"])} for r in q(per["start"], per["end"], ["page"], 6)]
    return {"cur": tot(per["start"], per["end"]), "prev": tot(per["prev_start"], per["prev_end"]), "queries": top, "pages": pages}


def cloudflare(per, cfg):
    tok, acc, tag = os.environ["CF_API_TOKEN"], os.environ["CF_ACCOUNT_ID"], cfg["sources"]["cloudflare_site_tag"]
    def gql(a, b, grouped):
        dim = "dimensions{requestPath}" if grouped else ""
        qry = ("query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){"
               f"rumPageloadEventsAdaptiveGroups(filter:$f,limit:{300 if grouped else 1},orderBy:[count_DESC]){{count sum{{visits}} {dim}}}}}}}}}")
        f = {"AND": [{"datetime_geq": a.isoformat() + "T00:00:00Z", "datetime_leq": (b + timedelta(days=1)).isoformat() + "T00:00:00Z"}, {"siteTag": tag}]}
        r = _http("https://api.cloudflare.com/client/v4/graphql", json.dumps({"query": qry, "variables": {"acc": acc, "f": f}}).encode(),
                  {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
        if r.get("errors"): raise RuntimeError(str(r["errors"])[:160])
        return r["data"]["viewer"]["accounts"][0]["rumPageloadEventsAdaptiveGroups"]
    def total(a, b):
        g = gql(a, b, False)
        return {"views": int(g[0]["count"]), "visits": int(g[0]["sum"]["visits"])} if g else {"views": 0, "visits": 0}
    parts = {"home": 0, "model": 0, "magazine": 0, "guide": 0, "other": 0}
    for row in gql(per["start"], per["end"], True):
        p = row["dimensions"]["requestPath"]; n = int(row["count"])
        k = "magazine" if p.startswith("/magazine") else "model" if p.startswith("/model") else "guide" if p.startswith("/guide") else "home" if p in ("/", "/index.html") else "other"
        parts[k] += n
    return {"cur": total(per["start"], per["end"]), "prev": total(per["prev_start"], per["prev_end"]), "sections": parts}


def psi(per, cfg):
    out = []
    for u in cfg["sources"]["psi_urls"]:
        q = {"url": u, "strategy": "mobile", "category": "performance"}
        if os.environ.get("PSI_API_KEY"): q["key"] = os.environ["PSI_API_KEY"]
        j = None
        for wait in (0, 20, 45):    # PageSpeed answers 429 when called without a key; a short backoff usually gets through
            time.sleep(wait)
            try: j = _http("https://www.googleapis.com/pagespeedonline/v5/runPagespeed?" + urllib.parse.urlencode(q), timeout=120); break
            except Exception as e:
                if "429" not in str(e): raise
        if j is None: raise RuntimeError("PageSpeed מגביל בקשות בלי מפתח (429). הוסיפו סוד PSI_API_KEY, בחינם")
        lh = j["lighthouseResult"]; a = lh["audits"]
        out.append({"url": u, "score": round(lh["categories"]["performance"]["score"] * 100), "lcp": round(a["largest-contentful-paint"]["numericValue"] / 1000, 1),
                    "cls": round(a["cumulative-layout-shift"]["numericValue"], 3), "tbt": round(a["total-blocking-time"]["numericValue"])})
    return out


def play_vitals(per, cfg):
    pkg = os.environ.get("PLAY_PACKAGE") or cfg["sources"]["play_package"]
    s = _google_session(["https://www.googleapis.com/auth/playdeveloperreporting"])
    def day(d): return {"year": d.year, "month": d.month, "day": d.day}
    end = per["end"] - timedelta(days=2)    # vitals arrive a couple of days late
    def metric(kind, names):
        body = {"timelineSpec": {"aggregationPeriod": "DAILY", "startTime": {**day(end - timedelta(days=6)), "timeZone": {"id": "America/Los_Angeles"}},
                                 "endTime": {**day(end + timedelta(days=1)), "timeZone": {"id": "America/Los_Angeles"}}}, "metrics": names + ["distinctUsers"]}
        r = s.post(f"https://playdeveloperreporting.googleapis.com/v1beta1/apps/{pkg}/{kind}:query", json=body, timeout=60); r.raise_for_status()
        w = u = 0.0
        for row in r.json().get("rows", []):
            m = {x["metric"]: float(x["decimalValue"]["value"]) for x in row.get("metrics", []) if "decimalValue" in x}
            if names[0] in m and m.get("distinctUsers"): w += m[names[0]] * m["distinctUsers"]; u += m["distinctUsers"]
        return round(w / u * 100, 2) if u else None
    return {"crash_pct": metric("crashRateMetricSet", ["userPerceivedCrashRate"]), "anr_pct": metric("anrRateMetricSet", ["userPerceivedAnrRate"])}


def collect_all(per, cfg):
    """Returns ({source: data}, [notes]) for every source whose secrets are present."""
    res, notes = {}, []
    have_sa = bool(os.environ.get("GA_SERVICE_ACCOUNT_JSON"))
    plan = [("search_console", search_console, have_sa), ("cloudflare", cloudflare, bool(os.environ.get("CF_API_TOKEN") and os.environ.get("CF_ACCOUNT_ID"))),
            ("psi", psi, True), ("play", play_vitals, have_sa and os.environ.get("PLAY_VITALS", "1") != "0")]
    for name, fn, on in plan:
        if not on: notes.append(f"המקור {name} לא הוגדר, ולכן לא נכלל."); continue
        try: res[name] = fn(per, cfg)
        except Exception as e:
            import sys; print(f"source {name} failed: {type(e).__name__}: {str(e)[:200]}", file=sys.stderr)    # technical detail stays in the Actions log, never in the report
            notes.append(f"{name}|⚠️ הנתונים מהמקור הזה לא היו זמינים השבוע. פרטים טכניים בלוג של ההרצה.")
    return res, notes
