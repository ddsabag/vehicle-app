#!/usr/bin/env python3
"""Weekly analytics pipeline: collect from GA4, analyse, render the dashboard, send a short brief.
  python analytics/run.py --sample            layout test with synthetic numbers, nothing is sent
  python analytics/run.py --gate --send       what the Sunday workflow runs (sends only at 08:00 Jerusalem time)
"""
import argparse, json, os, sys
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import analyze, insights, notify, render, sample  # noqa: E402


def scheduled_at(cron, now_utc):
    """The UTC time a "M H * * D" schedule line asked for: its latest occurrence up to now (5 minutes of clock slack). GitHub starts
    scheduled runs late (20-40 minutes is normal), so the send check uses this instead of the clock. None for any other line."""
    f = (cron or "").split()
    try: t = now_utc.replace(hour=int(f[1]), minute=int(f[0]), second=0, microsecond=0)
    except (IndexError, ValueError): return None
    return t if t <= now_utc + timedelta(minutes=5) else t - timedelta(days=1)


def periods(today):
    end = today - timedelta(days=1)            # GA4 numbers for today are incomplete
    return {"start": end - timedelta(days=6), "end": end, "prev_start": end - timedelta(days=13), "prev_end": end - timedelta(days=7)}


def brief(d, a, link, ins=None):
    em = {"green": "🟢", "yellow": "🟡", "red": "🔴"}[a["status"]]
    k = {x["key"]: x for g in a["kpis"].values() for x in g}
    def c(x):
        if x["cur"] is None or not x["prev"]: return ""
        dlt = round(x["cur"] - x["prev"], 1) if x["fmt"] == "pct" else round((x["cur"] - x["prev"]) / x["prev"] * 100, 1)
        return f" ({'▲' if dlt > 0 else '▼'}{abs(dlt):g}{' נק׳' if x['fmt'] == 'pct' else '%'})" if dlt else ""   # no plus/minus sign: it flips inside Hebrew text
    lines = [f"{em} לוחית, דוח שבועי {d['period']['start']} עד {d['period']['end']}", "",
             f"חיפושים: {k['searches']['cur']:,}{c(k['searches'])}", f"פעילים בשבוע: {k['wau']['cur']:,}{c(k['wau'])}",
             f"איטיים: {k['slow']['cur'] if k['slow']['cur'] is not None else '—'}%  ביטולים: {k['abort']['cur'] if k['abort']['cur'] is not None else '—'}%  כשלים: {k['fail']['cur'] if k['fail']['cur'] is not None else '—'}%",
             f"שיתופים: {k['share']['cur']:,}{c(k['share'])}  השוואות: {k['compare']['cur']:,}{c(k['compare'])}",
             "", "ויראליות: " + f"צילומי מסך {k['shots']['cur']:,}{c(k['shots'])}" + (f", {k['ratio']['cur']:g} צילומים לכל שיתוף" if k['ratio']['cur'] is not None else ""), a["shot_insight"]]
    bv = (a.get("extra") or {}).get("brevo")
    if bv:
        L = bv.get("last"); n = bv["new"]["cur"]
        lines += ["", f"רשימת תפוצה: {bv['total']:,} מנויים [{'+' if n >= 0 else ''}{n} השבוע]" + (f" | פתיחות קמפיין אחרון: {L['open_pct']:g}%" if L and L["open_pct"] is not None else "")]
    flags = [x for x in a["anomalies"] if x["level"] in ("red", "yellow")]
    if flags:
        lines += ["", "חריגות:"] + [f"{'🔴' if x['level'] == 'red' else '🟡'} {x['title']}" for x in flags[:4]]
    else:
        lines += ["", "אין חריגות."]
    if ins and ins["lines"]:
        lines += ["", "תובנות:"] + ins["lines"]
    lines += ["", "המלצות:"] + [f"{i}. {r}" for i, r in enumerate(a["recommendations"], 1)]
    if link: lines += ["", link]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", nargs="?", const="busy", help="use synthetic data: busy or incident")
    ap.add_argument("--send", action="store_true"); ap.add_argument("--gate", action="store_true", help="exit quietly unless it is Sunday 08:00 in Jerusalem")
    ap.add_argument("--out", default=os.path.join(HERE, "out")); a_ = ap.parse_args()
    cfg = json.load(open(os.path.join(HERE, "config.json"), encoding="utf-8"))
    tz = ZoneInfo(cfg["timezone"]); now = datetime.now(tz)
    # the Sunday workflow has two lines (UTC+2/UTC+3); exactly one of them is 08:xx in Jerusalem, whenever GitHub starts it
    sch = scheduled_at(os.environ.get("SCHEDULE"), datetime.now(timezone.utc))
    when = sch.astimezone(tz) if sch else now
    if a_.gate and not (when.weekday() == 6 and when.hour == cfg["send_hour_local"]):
        print(f"not the send time ({when:%A %H:%M} {cfg['timezone']}{', scheduled' if sch else ''}), nothing to do"); return 0
    per = periods(when.date())
    if a_.sample: data = sample.make(per, a_.sample)
    else:
        import ga
        data = ga.collect(per, cfg)
    if a_.sample: extra = sample.extras(a_.sample)
    else:
        import sources
        extra, more = sources.collect_all(per, cfg); data.setdefault("notes", []).extend(more)
    res = analyze.analyze(data, cfg, extra)
    ins = insights.build(data, extra)
    os.makedirs(a_.out, exist_ok=True)
    name = f"luchit-weekly-{per['end'].isoformat()}"
    html_path = os.path.join(a_.out, name + ".html")
    open(html_path, "w", encoding="utf-8").write(render.page(data, res))
    json.dump({"insights": ins, "data": data, "analysis": {k: v for k, v in res.items() if k != "daily"}}, open(os.path.join(a_.out, name + ".json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1, default=str)
    link = (f"{os.environ['GITHUB_SERVER_URL']}/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}" if os.environ.get("GITHUB_RUN_ID") else "")
    text = brief(data, res, ("הדשבורד המלא בקובץ המצורף, ובהרצה: " + link) if link else "")
    if os.environ.get("GITHUB_RUN_ID"): print("report built:", html_path, "| status:", res["status"])   # the public job log gets no numbers
    else: print(text); print("\nreport:", html_path, "| status:", res["status"])
    if a_.send and not a_.sample:
        sent, errs = notify.send_all(f"לוחית, דוח שבועי {per['end']}", text, html_path)
        print("sent via:", sent or "nothing (no channel configured)")
        for e in errs: print("delivery error:", e)
        if not sent: return 1   # nothing delivered (no channel or every channel failed): make the run red instead of quietly green
    return 0


if __name__ == "__main__":
    sys.exit(main())
