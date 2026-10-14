"""Optional extra sources. Each one runs only when its secret exists, and a failure is a note in the report, never a crash.
  Search Console (clicks, impressions, queries)   needs GA_SERVICE_ACCOUNT_JSON added as a user of the property
  Cloudflare Web Analytics (site visits, paths)    needs CF_API_TOKEN + CF_ACCOUNT_ID
  PageSpeed Insights (speed of the site)           works without a key, PSI_API_KEY is optional
  Google Play vitals (crash and ANR rate)          needs the same service account added in Play Console
  Brevo (mailing list size, signups, last campaign) needs BREVO_API_KEY (or BREVO_KEY) + BREVO_LIST_ID
"""
import json, os, time, urllib.parse, urllib.request
from datetime import date, datetime, timedelta


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
        if not rows: return {"clicks": 0, "impressions": 0, "position": None, "ctr": None}
        c, i = int(rows[0]["clicks"]), int(rows[0]["impressions"])
        return {"clicks": c, "impressions": i, "position": round(rows[0]["position"], 1), "ctr": round(c / i * 100, 1) if i else None}
    top = [{"query": r["keys"][0], "clicks": int(r["clicks"]), "impressions": int(r["impressions"])} for r in q(per["start"], per["end"], ["query"], 8)]
    pages = [{"page": r["keys"][0], "clicks": int(r["clicks"]), "impressions": int(r["impressions"])} for r in q(per["start"], per["end"], ["page"], 6)]
    sections = {"home": 0, "model": 0, "magazine": 0, "guide": 0, "other": 0}   # impressions by page type
    for r in q(per["start"], per["end"], ["page"], 1000):
        p = urllib.parse.urlparse(r["keys"][0]).path or "/"
        k = "magazine" if p.startswith("/magazine") else "model" if p.startswith("/model") else "guide" if p.startswith("/guide") else "home" if p in ("/", "/index.html") else "other"
        sections[k] += int(r["impressions"])
    return {"cur": tot(per["start"], per["end"]), "prev": tot(per["prev_start"], per["prev_end"]), "queries": top, "pages": pages, "sections": sections}


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


def brevo(per, cfg):
    """Mailing list size and growth, plus the most recent sent campaign. Numbers only: no addresses leave Brevo."""
    key = os.environ.get("BREVO_API_KEY") or os.environ.get("BREVO_KEY"); lst = os.environ["BREVO_LIST_ID"].strip()
    H = {"api-key": key, "accept": "application/json"}; B = "https://api.brevo.com/v3"
    info = _http(f"{B}/contacts/lists/{lst}", headers=H)
    total = int(info.get("uniqueSubscribers", info.get("totalSubscribers", 0)) or 0)
    # signups: contacts of the list, newest first, stop once older than the previous week
    new_cur = new_prev = offset = 0; done = False
    while not done and offset < 10000:
        rows = _http(f"{B}/contacts/lists/{lst}/contacts?limit=500&offset={offset}&sort=desc", headers=H).get("contacts", [])
        for c in rows:
            d = (c.get("createdAt") or "")[:10]
            if not d: continue
            d = date.fromisoformat(d)
            if per["start"] <= d <= per["end"]: new_cur += 1
            elif per["prev_start"] <= d <= per["prev_end"]: new_prev += 1
            elif d < per["prev_start"]: done = True; break
        if len(rows) < 500: break
        offset += 500
    camps = _http(f"{B}/emailCampaigns?status=sent&statistics=globalStats&limit=10&sort=desc", headers=H).get("campaigns", [])
    def stats(c):
        g = (c.get("statistics") or {}).get("globalStats") or {}
        deliv = int(g.get("delivered") or 0)
        pc = lambda n: round(int(n or 0) / deliv * 100, 1) if deliv else None
        return {"name": c.get("name", ""), "sent_date": (c.get("sentDate") or "")[:10], "delivered": deliv, "opens": int(g.get("uniqueViews") or 0), "clicks": int(g.get("uniqueClicks") or 0),
                "unsubs": int(g.get("unsubscriptions") or 0), "bounces": int(g.get("hardBounces") or 0) + int(g.get("softBounces") or 0),
                "open_pct": pc(g.get("uniqueViews")), "ctr_pct": pc(g.get("uniqueClicks")), "unsub_pct": pc(g.get("unsubscriptions"))}
    cs = [stats(c) for c in camps if (c.get("sentDate") or "")]
    last = cs[0] if cs else None
    if last: last["age_days"] = (per["end"] - date.fromisoformat(last["sent_date"])).days
    def lost(a, b):   # unsubscribes + bounces of campaigns sent inside a window
        return sum(c["unsubs"] + c["bounces"] for c in cs if a <= date.fromisoformat(c["sent_date"]) <= b)
    return {"total": total, "new": {"cur": new_cur, "prev": new_prev}, "lost": {"cur": lost(per["start"], per["end"]), "prev": lost(per["prev_start"], per["prev_end"])}, "last": last}


def collect_all(per, cfg):
    """Returns ({source: data}, [notes]) for every source whose secrets are present."""
    res, notes = {}, []
    have_sa = bool(os.environ.get("GA_SERVICE_ACCOUNT_JSON"))
    plan = [("search_console", search_console, have_sa), ("cloudflare", cloudflare, bool(os.environ.get("CF_API_TOKEN") and os.environ.get("CF_ACCOUNT_ID"))),
            ("psi", psi, True), ("brevo", brevo, bool((os.environ.get("BREVO_API_KEY") or os.environ.get("BREVO_KEY")) and os.environ.get("BREVO_LIST_ID"))), ("play", play_vitals, have_sa and os.environ.get("PLAY_VITALS", "1") != "0")]
    for name, fn, on in plan:
        if not on: (notes.append(f"המקור {name} לא הוגדר, ולכן לא נכלל.") if name != "brevo" else None); continue
        try: res[name] = fn(per, cfg)
        except Exception as e:
            import sys; print(f"source {name} failed: {type(e).__name__}: {str(e)[:200]}", file=sys.stderr)    # technical detail stays in the Actions log, never in the report
            notes.append(f"{name}|⚠️ הנתונים מהמקור הזה לא היו זמינים השבוע. פרטים טכניים בלוג של ההרצה.")
    return res, notes
