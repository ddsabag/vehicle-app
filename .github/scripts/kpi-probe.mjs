// Weekly KPI snapshot for the CEO thread (26.10, private file ceo/kpis.json): the /live dashboard's own code (worker/live/worker.js as it is
// on main) runs here on the whole week Sunday to Saturday that ended last Saturday, and the numbers are taken from its data the way the
// screen takes them (same events, same formulas, same targets), so the file and /live never tell two stories. probe-perf branch only, never
// main. Business numbers never reach the log or a branch in clear: the JSON is encrypted with .github/seo-data.pub.pem, the log says only
// which part answered. KPI_END=YYYY-MM-DD picks another week (its Saturday); KPI_TEST_DATA=<file> maps a saved /live data JSON instead of
// running the worker (local test of the mapping; prints in clear, never set in Actions).
//   node kpi-probe.mjs encrypt <in.json> <out.enc.json>   only encrypts a file (the weekly report's JSON in the same run)
import crypto from "node:crypto";
import fs from "node:fs";
function encryptTo(data, file) {
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(data), c.final()]);
  const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  fs.mkdirSync(file.replace(/[^/]*$/, "") || ".", { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
}
if (process.argv[2] === "encrypt") { encryptTo(fs.readFileSync(process.argv[3]), process.argv[4]); console.log("encrypted"); process.exit(0); }
const E = process.env, log = (part, ok, why = "") => console.log(part, ok ? "ok" : "failed " + String(why).replace(/\d/g, "#").slice(0, 160));
const WJS = fs.readFileSync(E.W_JS || "worker/live/worker.js", "utf8");
const addD = (d, k) => new Date(Date.parse(d + "T12:00:00Z") + k * 864e5).toISOString().slice(0, 10);
const ilToday = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
// the last whole Sunday-to-Saturday week: on Sunday it ended yesterday
const lastSat = d => { const w = new Date(d + "T12:00:00Z").getUTCDay(); return addD(d, -((w + 1) % 7 || 7)); };
const END = E.KPI_END || lastSat(ilToday);

// the screen's targets: GOALS and goal() as the page has them (pure lines of the page script, read from the same file)
function screenGoals(src) {
  const pick = re => { const m = re.exec(src); if (!m) throw new Error("not found: " + re.source.slice(0, 40)); return m[0]; };
  const code = [/const CAL_END="[^"]+";/, /const SITE_FROM="[^"]+";/, /const GOALS=\{[\s\S]*?\}\};/, /const addD=\(d,k\)=>[^\n]*;/, /const between=\(a,b\)=>[^\n]*;/,
    /const pois=\(a,lam\)=>\{[^\n]*?return s\};/, /const mEnd=m=>[^\n]*;/, /const MONTHS=GOALS[^\n]*;/, /function goal\(key,day,r\)\{[\s\S]*?return v\.map\(x=>x\*\(r\|\|1\)\)\}/,
    /function band\(a,g,lower,small\)\{[^\n]*\}/].map(pick).join("\n");
  return new Function(code + "\nreturn { CAL_END, SITE_FROM, GOALS, goal, band, addD };")();
}

async function runWorker() {
  // the worker as a module: its default export kept aside, collect() exported; the week's last day set to END instead of "yesterday after noon"
  const ORIG = "const end = addDays(today, ilHour(Date.now()) >= 12 ? -1 : -2);";
  if (!WJS.includes(ORIG)) throw new Error("the week line of collectWeekly changed: update kpi-probe.mjs");
  const src = WJS.replace("export default", "const _d =").replace(ORIG, "const end = " + JSON.stringify(END) + ";") + "\nexport { collect };";
  const tmp = E.W_TMP || "/tmp/kpi-worker.mjs";
  fs.writeFileSync(tmp, src);
  const toml = fs.existsSync(E.W_TOML || "") ? fs.readFileSync(E.W_TOML, "utf8") : "";
  const tv = (k, dflt) => (new RegExp("^" + k + '\\s*=\\s*"([^"]+)"', "m").exec(toml) || [0, dflt])[1];
  // Workers KV read through Cloudflare's API (the tallies and closed months /live keeps); nothing is written from here
  // the secret may hold Cloudflare's whole test command (curl ... -H "Authorization: Bearer <token>"): the token is taken from it, as
  // workers-deploy.mjs cleanToken does, or fetch cannot send the header and its error would carry the secret
  const rawTok = String(E.CLOUDFLARE_API_TOKEN || E.CF_API_TOKEN || ""), bt = /\bBearer\s+([A-Za-z0-9_-]{20,})(?![A-Za-z0-9_-])/.exec(rawTok);
  const kvTok = bt ? bt[1] : rawTok.replace(/[^A-Za-z0-9_-]/g, ""), acc = String(E.CF_ACCOUNT_ID || "").trim();
  const cf = p => fetch("https://api.cloudflare.com/client/v4/accounts/" + acc + p, { headers: { authorization: "Bearer " + kvTok }, signal: AbortSignal.timeout(15e3) });
  let ns = null;
  const nsId = async () => ns ??= ((await (await cf("/storage/kv/namespaces?per_page=100")).json()).result || []).find(x => x.title === "luchit-alerts")?.id || "";
  const ALERTS = {
    get: async (k, type) => { const id = await nsId(); if (!id) return null; const r = await cf("/storage/kv/namespaces/" + id + "/values/" + encodeURIComponent(k)); if (r.status === 404) return null; if (!r.ok) throw new Error("kv " + r.status); return type === "json" ? r.json() : r.text(); },
    put: async () => {}, list: async () => ({ keys: [] }),
  };
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  const env = { ALERTS, GA_PROPERTY_ID: tv("GA_PROPERTY_ID", "557990379"), PLAY_REPORTS_BUCKET: tv("PLAY_REPORTS_BUCKET", "pubsite_prod_4688106336294834537"),
    GA_SERVICE_ACCOUNT_JSON: E.GA_SERVICE_ACCOUNT_JSON, CF_API_TOKEN: E.CF_API_TOKEN, CF_ACCOUNT_ID: acc };
  const { collect } = await import(tmp);
  return collect(env);
}

// what each field means, in the file itself (the reader is the CEO thread, not this code)
const FIELDS = {
  week: "השבוע המדווח, ראשון עד שבת; prev_week: השבוע שלפניו. בכל מדד: week מול prev.",
  status: "ok עומד ביעד, warn קרוב ליעד, bad רחוק מהיעד, cal שבוע כיול (אין שיפוט), early מעט מדי נתונים לשפוט, nodata אין נתון. כמו בלוח /live.",
  weekly_checks: "בדיקות רכב בשבוע (car_lookup): האפליקציה בישראל והאתר; app ו-web הם הפיצול. plan: יעד התוכנית לפני הכיול. target: היעד אחרי הכיול (base והטווח), מהשבוע שאחרי שבוע הבסיס. calib_ratio: יחס הכיול.",
  installs: "התקנות חדשות בישראל לפי גוגל אנליטיקס (משתמשי אנדרואיד חדשים, פתיחה ראשונה). plan: יעד התוכנית. play: המספרים של Google Play עצמו, באיחור של כמה ימים ובחלון שלו (window).",
  return_7d: "מתוך ההתקנות של שבוע, כמה חזרו לאפליקציה תוך 7 ימים (app_return). week הוא שבוע ההתקנות שלפני השבוע המדווח, כדי שיעברו 7 ימים. savers: מי ששמר רכב ביום ההתקנה; non_savers: מי שלא.",
  new_savers: "התקנות חדשות ששמרו רכב ביום ההתקנה (first_save), לפי יום ההתקנה. devices_saved_a_car: מכשירים ששמרו רכב כלשהו בשבוע.",
  share: "שיתופים (share: דוח רכב או השוואה) ופתיחות חלון השיתוף (share_open). per_100_checks: שיתופים ל-100 בדיקות; target_per_100: היעד. arrived_from_share: כניסות מקישור ששותף; installs_from_share: התקנות מקישור ששותף.",
  play_rating: "הדירוג הממוצע ב-Google Play (לכל הזמנים, נכון ל-as_of), מספר הדירוגים (count) ומספר הביקורות עם טקסט (with_text).",
  organic_q1: "שאלה 1 של החודש: אחוז הבדיקות באתר שהגיעו ממקורות שאינם קישורי קמפיין (גוגל, ישיר, שיתוף ועוד), מתוך בדיקות באתר שהמקור שלהן ידוע. האפליקציה לא נכללת.",
  b2b_leads: "פניות עסקיות מהטופס בדף העסקים (b2b_lead_submit) בשבוע ומאז 1.10; newsletter: אישורי הרשמה למגזין.",
  failure_pct: "אחוז הבדיקות שנכשלו מצד המערכת (משרד התחבורה לא ענה, אין רשת, תקלה אצלנו) מתוך כל הניסיונות. target_max: הרף העליון.",
  slow_pct: "אחוז הבדיקות שלקחו יותר מ-5 שניות, מתוך בדיקות שהזמן שלהן ידוע. מעל 10% דורש תשומת לב.",
  notes: "הסבר לכל מדד ריק או חלקי. errors: מקור שלא ענה בהרצה.",
};

// the numbers, as the screen reads them (render() in the page script: tiles 1-4, health, slow, the month's questions, milestones)
function kpis(d, S) {
  const W = d.weekly || null, ev = W && W.ev, E0 = ev ? ev[0] : null, E1 = ev ? ev[1] : null, ge = (o, k, i) => o && o[k] ? o[k][i || 0] : 0;
  const end = W ? W.end : null, prevEnd = end ? S.addD(end, -7) : null, cal = !end || end < S.CAL_END, days = W && W.days, notes = {};
  const week = e => { if (!days) return null; let s = 0; for (let i = 0; i < 7; i++) s += days[S.addD(e, -i)] || 0; return s; };
  const wsum = (k, e) => { const o = W && W.series && W.series[k]; if (!o) return null; let s = 0; for (let i = 0; i < 7; i++) s += o[S.addD(e, -i)] || 0; return s; };
  const dm = x => +x.slice(8, 10) + "." + +x.slice(5, 7), r1 = x => x == null || !isFinite(x) ? null : Math.round(x * 10) / 10, rg = g => g ? { base: r1(g[1]), range: [r1(g[0]), r1(g[2])] } : null;
  const CB = S.GOALS.calib, cw = days && end >= CB.end ? week(CB.end) : null, RC = cw ? Math.min(CB.hi, Math.max(CB.lo, cw / CB.model)) : 1;
  const out = {};
  if (!ev) notes.ga4 = "גוגל אנליטיקס לא ענה על השבוע: " + Object.keys(W && W.errors || d.errors || {}).join(", ");

  // 1. weekly car checks (north star): app + site, the week's target after the base week
  { const L = ev ? ge(E0, "car_lookup") : null, Lp = ev ? ge(E1, "car_lookup") : null, site = wsum("site_lookup", end), sitep = wsum("site_lookup", prevEnd);
    const G = end && !cal ? S.goal("weekly_checks", end, RC) : null;
    let s = !ev ? "nodata" : cal ? "cal" : S.band(L, G, false, true); if (s === "ok" && Lp >= 30 && L < .8 * Lp) s = "warn";
    const P = end ? S.goal("weekly_checks", end, 1) : null, pace = L != null && CB.model ? L / CB.model : null;
    out.weekly_checks = { week: L, prev: Lp, plan: rg(P), app: site != null && L != null ? Math.max(0, week(end) - site) : null, web: site, app_prev: sitep != null && Lp != null ? Math.max(0, week(prevEnd) - sitep) : null, web_prev: sitep,
      target: rg(G), pct_of_target: G && L != null ? Math.round(L / G[1] * 100) : null, calib_ratio: cw ? r1(RC * 100) / 100 : null, status: s };
    if (!G) notes.weekly_checks_target = "שבוע הבסיס הוא " + dm(S.addD(CB.end, -6)) + "–" + dm(CB.end) + ": לפיו נקבע היעד (התוכנית צפתה " + CB.model + "), ומהשבוע שאחריו יש יעד לכל שבוע. plan הוא יעד התוכנית לפני הכיול.";
    if (pace != null && end < CB.end && pace > CB.hi) notes.weekly_checks_calibration = "השבוע היה פי " + r1(pace) + " מצפי התוכנית לשבוע הבסיס (" + CB.model + "), והכיול מוגבל עד פי " + CB.hi + ": אם שבוע הבסיס ייצא כך, היעד מ-" + dm(S.addD(CB.end, 1)) + " יהיה נמוך בהרבה מהקצב בפועל.";
    if (prevEnd && S.addD(prevEnd, -6) < S.SITE_FROM) notes.weekly_checks_web = "באתר הבדיקות נספרות מ-15.10, לכן שבוע שמתחיל לפני כן חלקי באתר."; }

  // 2. new installs: first opens in Israel (GA4 new Android users in IL), the target once the app is live and the base week is over; Google
  // Play's own count (a few days late, its own window) beside it
  { const A = W && W.app, a = A ? A[0].newUsers : null, ap = A ? A[1].newUsers : null, live = d.play === "live", GI = end ? S.goal("installs_week", end) : null, tg = live && !cal ? GI : null;
    const PS = d.stats && d.stats.ok && d.stats.cur ? d.stats : null;
    out.installs = { week: a, prev: ap, plan: rg(GI), target: rg(tg), status: a == null ? "nodata" : !live ? "early" : cal ? "cal" : S.band(a, GI, false, true),
      play: PS ? { window: PS.W, users: PS.cur.users, prev_window: PS.P, prev: PS.prev.users, uninstalls: PS.cur.uninstalls,
      store_visitors: PS.store && (PS.cur.visitors || PS.prev.visitors) ? PS.cur.visitors : null, store_acquisitions: PS.store && (PS.cur.acquisitions || PS.prev.acquisitions) ? PS.cur.acquisitions : null, installed_now: PS.active, installed_day: PS.activeDay } : null };
    if (!PS) notes.installs_play = "דוחות Google Play לא נקראו: " + String(d.stats && d.stats.why || d.stats && d.stats.error || "אין נתון").slice(0, 120);
    else { notes.installs_play = "Google Play מוסר באיחור של כמה ימים ובחלון שלו (window), ולכן הוא לא אותו שבוע כמו week.";
      if (out.installs.play.store_visitors == null) notes.installs_store = "ביקורים בדף החנות: הדוח של Google Play לא נמצא או ריק, כמו בלוח."; }
    if (!tg) notes.installs_target = !live ? "האפליקציה עוד לא בחנות: אין יעד." : "יעד ההתקנות נשפט מהשבוע שאחרי שבוע הבסיס; plan הוא יעד התוכנית (לא מכויל לפי הבדיקות)."; }

  // 3. 7-day return of new installs (from 1.36, 21.10): the install week whose 7 days are over, and the week before it; saver vs non-saver as Q2
  { const C = W && W.coh, QF = "2026-10-21";
    const cohort = (a, b) => { if (!C) return null; let I = 0, Sv = 0, R1 = 0, R0 = 0, Est = 0, n = 0;
      for (const [day, o] of Object.entries(C)) if (day >= a && day <= b && day >= QF) { n++; I += o[0]; Sv += o[1]; R1 += o[2]; R0 += o[3]; Est += o[4] || 0; }
      if (!n) return null; const N0 = Math.max(0, I - Sv);
      return { installs_from: a < QF ? QF : a, installs_to: b, installs: I, returned: R1 + R0, rate_pct: I ? r1((R1 + R0) / I * 100) : null,
        savers: Sv, savers_returned: R1, savers_rate_pct: Sv ? r1(R1 / Sv * 100) : null, non_savers: N0, non_savers_returned: R0, non_savers_rate_pct: N0 ? r1(R0 / N0 * 100) : null, estimated: Est }; };
    const c0 = end ? cohort(S.addD(end, -13), S.addD(end, -7)) : null, c1 = end ? cohort(S.addD(end, -20), S.addD(end, -14)) : null;
    out.return_7d = { week: c0, prev: c1 };
    if (!C) notes.return_7d = "גוגל אנליטיקס לא ענה על חזרות.";
    else { if (!c0) notes.return_7d = "עוד אין שבוע התקנות שעברו עליו 7 ימים: החזרה נמדדת מהתקנות של 21.10 ואילך (1.36), וכל יום התקנות נספר שבוע אחריו.";
      if (!c1) notes.return_7d_prev = "נמדד מ-21.10 (גרסה 1.36): לשבוע ההתקנות הזה אין נתון."; if (c0 && c0.installs_from > S.addD(end, -13)) notes.return_7d = "שבוע ההתקנות חלקי: נמדד מ-21.10.";
      if ((c0 && c0.estimated) || (c1 && c1.estimated)) notes.return_7d_estimated = "חלק מהשמירות והחזרות שויכו ליום ההתקנה לפי התאריך שלהן (האפליקציה לא שלחה את יום ההתקנה לפני 1.38): הערכה."; } }

  // 4. new savers: new installs that saved a car on the install day (first_save), by install day in the week; devices that saved any car
  { const C = W && W.coh, sum = (a, b) => { if (!C) return null; let s = 0, n = 0; for (const [day, o] of Object.entries(C)) if (day >= a && day <= b) { s += o[1]; n++; } return n ? s : null; };
    out.new_savers = { week: end ? sum(S.addD(end, -6), end) : null, prev: end ? sum(S.addD(end, -13), prevEnd) : null,
      devices_saved_a_car: W && W.savers ? W.savers.car_save ?? 0 : null, devices_saved_a_car_prev: W && W.saversP ? W.saversP.car_save ?? 0 : null, first_save_events: ev ? ge(E0, "first_save") : null, first_save_events_prev: ev ? ge(E1, "first_save") : null };
    if (end && S.addD(end, -6) < "2026-10-21") notes.new_savers = "שמירה ביום ההתקנה נמדדת מ-21.10 (1.36): שבוע שמתחיל לפני כן חלקי, ושבוע שכולו לפני כן ריק.";
    else if (end && S.addD(end, -13) < "2026-10-21") notes.new_savers_prev = "שמירה ביום ההתקנה נמדדת מ-21.10 (1.36): השבוע הקודם חלקי."; }

  // 5. shares: shares and share-sheet opens, per 100 checks, arrivals and installs that came from a shared link
  { const L = ge(E0, "car_lookup"), Lp = ge(E1, "car_lookup"), Lm = ge(ev && ev[2], "car_lookup"), sh = W && W.shared, GS = end ? S.goal("share_per_100", end) : null, rate = ev && L ? ge(E0, "share") / L * 100 : null;
    const rate28 = ev && Lm ? ge(ev[2], "share") / Lm * 100 : null, judged = L >= 100 ? rate : Lm >= 100 ? rate28 : null;
    out.share = { week: ev ? ge(E0, "share") : null, prev: ev ? ge(E1, "share") : null, share_open: ev ? ge(E0, "share_open") : null, share_open_prev: ev ? ge(E1, "share_open") : null,
      per_100_checks: r1(rate), per_100_checks_prev: ev && Lp ? r1(ge(E1, "share") / Lp * 100) : null, per_100_checks_28d: r1(rate28), target_per_100: rg(GS),
      status: !ev ? "nodata" : judged == null ? "early" : cal ? "cal" : S.band(judged, GS, false, false),
      arrived_from_share: sh ? sh[0].web + sh[0].app : null, arrived_from_share_prev: sh ? sh[1].web + sh[1].app : null, installs_from_share: sh ? sh[0].inst ?? null : null };
    if (ev && L < 100) notes.share = "פחות מ-100 בדיקות בשבוע: הלוח שופט את הקצב על 28 ימים עד שיש 100."; }

  // 6. store rating: the lifetime average of the newest day in Play's ratings report, and every rating counted in its reviews reports
  { const RA = d.rating && d.rating.ok ? d.rating : null;
    out.play_rating = RA ? { avg: RA.avg, count: RA.n, with_text: RA.txt, as_of: RA.avgDay || RA.last, own_average: !!RA.own, milestone_m3: "4.5 עם 21 דירוגים" } : null;
    if (!RA) notes.play_rating = "דוחות הדירוג של Google Play לא נקראו: " + String(d.rating && (d.rating.why || d.rating.error) || "אין נתון").slice(0, 120); }

  // 7. organic share (question 1): site checks from sources that are not our campaign links, out of site checks with a known source
  { const ORG = ["google", "search", "direct", "site", "share", "other"], B = W && W.bySource, seen = W && W.srcSeen || [false, false];
    const sc = (o, ks) => ks.reduce((a, k) => a + ((o && o[k] || [0, 0])[1]), 0), known = o => Object.keys(o || {}).filter(k => k !== "app" && k !== "unknown");
    const o0 = B ? sc(B[0], ORG) : null, m0 = B ? sc(B[0], known(B[0])) : null, o1 = B && seen[1] ? sc(B[1], ORG) : null, m1 = B && seen[1] ? sc(B[1], known(B[1])) : null;
    out.organic_q1 = { week_pct: m0 ? r1(o0 / m0 * 100) : null, prev_pct: m1 ? r1(o1 / m1 * 100) : null, organic_site_checks: o0, known_source_site_checks: m0, organic_site_checks_prev: o1,
      growth_pct: o1 ? r1((o0 - o1) / o1 * 100) : null, thresholds: "חלק 25% ומעלה, וצמיחה של 20% בשבוע", app_not_included: true };
    if (!m1) notes.organic_q1_prev = "המקור נמדד באתר מ-20.10: לשבוע הקודם אין מקור ידוע, ולכן גם אין צמיחה."; }

  // 8. business leads (the business page's form, b2b_lead_submit) and magazine sign-ups
  { const M = W && W.money;
    out.b2b_leads = { week: ev ? ge(E0, "b2b_lead_submit") : null, prev: ev ? ge(E1, "b2b_lead_submit") : null, since_2026_10_01: M ? M.leads : null,
      newsletter_week: ev ? ge(E0, "newsletter_confirm") : null, newsletter_since_2026_10_01: M ? M.subscribers : null }; }

  // 9. failures and slow checks (health): failures = ministry not answering, no answer, network error, our code, out of all attempts;
  // slow = over 5 seconds, of checks with a known duration
  { const fk = W && W.fails, t = o => o ? (o.source_down || 0) + (o.offline || 0) + (o.net_err || 0) + (o.js_err || 0) : null, at = E => ev ? ge(E, "car_lookup") + ge(E, "lookup_failed") : null;
    const f0 = fk ? t(fk[0]) : null, f1 = fk ? t(fk[1]) : null, a0 = at(E0), a1 = at(E1), GF = end ? S.goal("failures_pct", end) : null, r = f0 != null && a0 ? f0 / a0 * 100 : null;
    let s = f0 == null || !ev ? "nodata" : a0 < 50 ? "early" : S.band(r, GF, true); if (s === "bad" && f0 < 5) s = "warn";
    out.failure_pct = { week: r1(r), prev: f1 != null && a1 ? r1(f1 / a1 * 100) : null, failed: f0, attempts: a0, target_max: GF ? r1(GF[1]) : null, status: s };
    const DU = W && W.dur, sl = o => { if (!o) return null; const k = (o.lt2 || 0) + (o["2to5"] || 0) + (o["5to10"] || 0) + (o.gt10 || 0); return k ? { k, p: ((o["5to10"] || 0) + (o.gt10 || 0)) / k * 100 } : null; };
    const s0 = DU ? sl(DU[0]) : null, s1 = DU ? sl(DU[1]) : null;
    out.slow_pct = { week: s0 ? r1(s0.p) : null, prev: s1 ? r1(s1.p) : null, checks_with_duration: s0 ? s0.k : null, attention_above: 10, status: !s0 ? "nodata" : s0.k < 50 ? "early" : s0.p > 10 ? "warn" : "ok" }; }

  return { out, notes, end };
}

// error texts go into the file without anything that looks like a key (a long run of letters, digits, - and _)
const scrub = v => String(v).replace(/[A-Za-z0-9_-]{20,}/g, "***").slice(0, 300), scrubAll = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, scrub(v)]));
let raw = null;
const result = { generated: new Date().toISOString(), week: { from: addD(END, -6), to: END }, prev_week: { from: addD(END, -13), to: addD(END, -7) } };
try {
  const S = screenGoals(WJS); log("goals", true);
  let d;
  if (E.KPI_TEST_DATA) d = JSON.parse(fs.readFileSync(E.KPI_TEST_DATA, "utf8"));
  else { d = raw = await runWorker(); log("worker", true); }
  const k = kpis(d, S);
  if (k.end && k.end !== END && !E.KPI_TEST_DATA) throw new Error("the worker's week is not the week asked for");
  Object.assign(result, { source: { worker_build: d.build || null, main_sha: E.MAIN_SHA || null, how: "קוד לוח /live עצמו, על השבוע ראשון–שבת שהסתיים ב-" + END },
    kpis: k.out, notes: scrubAll(k.notes), fields: FIELDS, errors: scrubAll(d.errors), play_status: d.play || null });
  for (const [kk, v] of Object.entries(k.out)) console.log("kpi." + kk, v == null ? "empty" : "ok");
} catch (e) { result.error = scrub(e.message || e); log("kpis", false, scrub(e.message || e)); }

if (E.KPI_TEST_DATA) { console.log(JSON.stringify(result, null, 1)); process.exit(0); }
encryptTo(Buffer.from(JSON.stringify(result, null, 1)), "out/kpi.enc.json");
// the part of /live's data the numbers came from (encrypted), to check the mapping offline (KPI_TEST_DATA)
if (raw) encryptTo(Buffer.from(JSON.stringify({ build: raw.build, play: raw.play, stats: raw.stats, rating: raw.rating, weekly: raw.weekly, errors: scrubAll(raw.errors) })), "out/live.enc.json");
console.log("written, encrypted", result.error ? "(with an error)" : "");
