"""Weekly product and search-intent insights. Quiet by design: returns lines only when something is worth acting on.
Joins three sources: what users searched in the app and did not find (GA4), what Google shows for the site (Search Console)
and what the model catalogue holds (models.json). The same output is saved as JSON so SEO decisions can use it."""
import json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _catalog():
    try:
        rows = json.load(open(os.path.join(ROOT, "models.json"), encoding="utf-8"))["rows"]
    except Exception:
        return []
    return sorted({(str(r[0]) + " " + str(r[1])).lower() for r in rows})


def _in_catalog(term, cat):
    toks = [t for t in re.split(r"[\s\-_/]+", term.lower()) if len(t) >= 2]
    return bool(toks) and any(all(t in c for t in toks) for c in cat)


def build(data, extra):
    lines, seo = [], {"unserved_terms": [], "striking_distance": [], "low_ctr": [], "topic_candidates": []}
    # 1. searches inside the app that found nothing
    terms = sorted(((k, v["cur"]) for k, v in data.get("nores_term", {}).items() if k not in ("(not set)", "") and v["cur"] > 0), key=lambda x: -x[1])
    cat = _catalog()
    for t, n in terms[:10]:
        seo["unserved_terms"].append({"term": t, "count": int(n), "in_catalog": _in_catalog(t, cat)})
    miss = [x for x in seo["unserved_terms"] if not x["in_catalog"]]
    fuzzy = [x for x in seo["unserved_terms"] if x["in_catalog"]]
    if miss:
        lines.append("🔎 חיפשו ולא מצאו (לא במאגר): " + ", ".join(f"{x['term']} ({x['count']})" for x in miss[:4]) + ". שווה לבדוק הוספה למאגר או כתבה.")
    if fuzzy:
        lines.append("🔎 קיים במאגר אבל החיפוש לא מצא: " + ", ".join(f"{x['term']} ({x['count']})" for x in fuzzy[:3]) + ". לשפר התאמה.")
    nk = data.get("nores_kind", {})
    tot_c, tot_p = sum(v["cur"] for v in nk.values()), sum(v["prev"] for v in nk.values())
    if tot_c >= 10 and tot_c >= 2 * max(tot_p, 1):
        lines.append(f"🔎 חיפושים ללא תוצאה: {tot_c} השבוע לעומת {tot_p} בשבוע שעבר.")
    # 2. buy card: opened but not followed by a share
    ev = data.get("events", {})
    bo = ev.get("buy_card_open", {}).get("cur", 0); sh = ev.get("share", {}).get("cur", 0)
    if bo >= 20 and sh < bo * 0.15:
        lines.append(f"🛒 כרטיס הקנייה נפתח {bo} פעמים, אבל רק {sh} שיתופים בסך הכול. ההמשך חלש.")
    # 3. search opportunities from Search Console (28 days)
    wide = (extra.get("search_console") or {}).get("wide") or []
    for r in wide:
        ctr = r["clicks"] / r["impressions"] * 100 if r["impressions"] else 0
        if 8 <= r["position"] <= 20 and r["impressions"] >= 5:
            seo["striking_distance"].append({**r, "ctr": round(ctr, 1)})
        elif r["position"] < 10 and r["impressions"] >= 20 and ctr < 2:
            seo["low_ctr"].append({**r, "ctr": round(ctr, 1)})
        if r["clicks"] == 0 and r["impressions"] >= 10:
            seo["topic_candidates"].append(r["query"])
    seo["striking_distance"].sort(key=lambda r: -r["impressions"]); seo["low_ctr"].sort(key=lambda r: -r["impressions"])
    if seo["striking_distance"]:
        top = seo["striking_distance"][:3]
        lines.append("📈 קרובים לעמוד הראשון: " + ", ".join(f"{r['query']} (מקום {r['position']:g})" for r in top) + ". מועמדים לחיזוק קישורים פנימיים.")
    if seo["low_ctr"]:
        r = seo["low_ctr"][0]
        lines.append(f"✏️ «{r['query']}»: {r['impressions']} חשיפות ו-{r['ctr']:g}% הקלקות במקום {r['position']:g}. מועמד לשינוי כותרת, כפוף לחלון 21 הימים.")
    if seo["topic_candidates"]:
        lines.append("📝 נושאים לכתבה (חשיפות בלי הקלקות): " + ", ".join(seo["topic_candidates"][:3]))
    return {"lines": lines, "seo": seo}
