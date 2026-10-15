// luchit-live: a private "right now" page for the owner. GET /live is the page, GET /live/data the numbers (GA4 Realtime + Cloudflare Web Analytics).
// Protected twice: Cloudflare Access in front (route luchit.app/live*), and this Worker verifies the Access JWT itself, so a misconfigured Access policy cannot leak data.
// Returns only aggregate counts, never anything personal. Secrets: GA_SERVICE_ACCOUNT_JSON, CF_API_TOKEN. Vars: see wrangler.toml.
const CF_TAG = "9bb0e756882c478a808d95596e0deade";
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const BUILD = "live-7";   // shown in /live/data so the running version is visible
const HEAD = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...HEAD, "content-type": "application/json; charset=utf-8" } });

let jwks = null, jwksAt = 0;
async function verifyAccess(req, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;          // not configured: refuse
  const tok = req.headers.get("cf-access-jwt-assertion"); if (!tok) return false;
  const [h, p, s] = tok.split("."); if (!s) return false;
  const head = JSON.parse(new TextDecoder().decode(unb64u(h))), pay = JSON.parse(new TextDecoder().decode(unb64u(p)));
  if (Date.now() - jwksAt > 3600e3 || !jwks) { jwks = (await (await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`)).json()).keys; jwksAt = Date.now(); }
  const jwk = jwks.find(k => k.kid === head.kid); if (!jwk) return false;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64u(s), new TextEncoder().encode(h + "." + p));
  const aud = Array.isArray(pay.aud) ? pay.aud : [pay.aud];
  return ok && aud.includes(env.ACCESS_AUD) && pay.exp * 1000 > Date.now() && pay.iss === `https://${env.ACCESS_TEAM_DOMAIN}`;
}

let gtok = null, gexp = 0;
async function googleToken(env) {
  if (gtok && Date.now() < gexp) return gtok;
  const sa = JSON.parse(env.GA_SERVICE_ACCOUNT_JSON), now = Math.floor(Date.now() / 1000);
  const enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: "RS256", typ: "JWT" }) + "." + enc({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 });
  const pem = sa.private_key.replace(/-----[^-]+-----|\s/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = b64u(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig }) });
  if (!r.ok) throw new Error("google auth " + r.status);
  gtok = (await r.json()).access_token; gexp = Date.now() + 2900e3; return gtok;
}
const realtime = async (env, body) => {
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${env.GA_PROPERTY_ID}:runRealtimeReport`, { method: "POST", headers: { authorization: "Bearer " + await googleToken(env), "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("ga4 " + r.status + " " + (await r.text()).replace(/\s+/g, " ").slice(0, 120));
  return (await r.json()).rows || [];
};
const report = async (env, body) => {
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${env.GA_PROPERTY_ID}:runReport`, { method: "POST", headers: { authorization: "Bearer " + await googleToken(env), "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("ga4 report " + r.status + " " + (await r.text()).replace(/\s+/g, " ").slice(0, 120));
  return (await r.json()).rows || [];
};
const cleanToken = t => String(t || "").replace(/^[\s"']*(bearer\s+)?/i, "").replace(/[\s"']+$/, "").replace(/[^\x21-\x7e]/g, "");   // pasted secrets often carry a newline, quotes or the word Bearer
// "today" means the Israel calendar day (GA4 uses the property time zone; Cloudflare is queried with the same boundaries)
const ilDay = t => new Date(t).toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
function ilStart(day) {
  for (const h of [3, 2]) { const t = Date.parse(day + "T00:00:00Z") - h * 3600e3; if (ilDay(t) === day && ilDay(t - 1) !== day) return new Date(t).toISOString(); }
  return day + "T00:00:00Z";
}
const addDays = (day, k) => new Date(Date.parse(day + "T12:00:00Z") + k * 864e5).toISOString().slice(0, 10);
async function cfQuery(env, day, dim, limit) {
  const token = cleanToken(env.CF_API_TOKEN), account = String(env.CF_ACCOUNT_ID || "").trim();
  if (!token || !account) return null;
  const dims = dim ? `dimensions{${dim}}` : "";
  const q = `query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){rumPageloadEventsAdaptiveGroups(filter:$f,limit:${limit},orderBy:[sum_visits_DESC]){count sum{visits} ${dims}}}}}`;
  const f = { AND: [{ datetime_geq: ilStart(day), datetime_lt: ilStart(addDays(day, 1)) }, { siteTag: CF_TAG }] };
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: { acc: account, f } }) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.errors) throw new Error("cloudflare " + r.status + " " + JSON.stringify(j?.errors || j).slice(0, 140));
  return j?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];
}
async function cfVisits(env, day) {
  const g = await cfQuery(env, day, "", 1); if (g == null) return null;
  return g[0] ? { visits: Math.round(g[0].sum.visits), views: g[0].count } : { visits: 0, views: 0 };
}
async function cfTop(env, day, dim) {
  const g = await cfQuery(env, day, dim, 12); if (g == null) return null;
  return g.map(x => [x.dimensions[dim] || "", Math.round(x.sum.visits), x.count]);
}

let daily = null, dailyAt = 0;
async function collectDaily(env, today, yday) {
  if (daily && Date.now() - dailyAt < 300e3) return daily;
  const errors = {}, safe = (p, k) => p.catch(e => { errors[k] = String(e.message || e).slice(0, 200); return null; });
  const dr = [{ startDate: "today", endDate: "today" }, { startDate: "yesterday", endDate: "yesterday" }];
  const [kpi, evs, vers, src, pages, countries] = await Promise.all([
    safe(report(env, { dateRanges: dr, metrics: ["activeUsers", "newUsers", "sessions", "userEngagementDuration", "screenPageViews"].map(name => ({ name })) }), "ga4 daily"),
    safe(report(env, { dateRanges: dr, dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], limit: 100 }), "ga4 events"),
    safe(report(env, { dateRanges: [dr[0]], dimensions: [{ name: "appVersion" }], metrics: [{ name: "activeUsers" }], orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }], limit: 8 }), "ga4 versions"),
    safe(cfTop(env, today, "refererHost"), "site sources"), safe(cfTop(env, today, "requestPath"), "site pages"), safe(cfTop(env, today, "countryName"), "site countries")]);
  const range = r => r.dimensionValues[r.dimensionValues.length - 1].value;   // "date_range_0" (today) or "date_range_1"
  const k = { today: null, yesterday: null };
  for (const r of kpi || []) { const o = {}; ["activeUsers", "newUsers", "sessions", "engageSec", "views"].forEach((n, i) => o[n] = Number(r.metricValues[i].value)); k[range(r) === "date_range_0" ? "today" : "yesterday"] = o; }
  const ev = { today: {}, yesterday: {} };
  for (const r of evs || []) ev[range(r) === "date_range_0" ? "today" : "yesterday"][r.dimensionValues[0].value] = [Number(r.metricValues[0].value), Number(r.metricValues[1].value)];
  daily = { errors, kpi: kpi ? k : null, events: evs ? ev : null, versions: vers ? vers.map(r => [r.dimensionValues[0].value, Number(r.metricValues[0].value)]) : null, sources: src, pages, countries };
  dailyAt = Date.now(); return daily;
}

let cache = null, cacheAt = 0, backoffUntil = 0;
async function collect(env) {
  // GA4 realtime has an hourly token quota: answer from cache for a minute, and after a 429 stop asking for 5 minutes (serve the last good numbers)
  if (cache && (Date.now() - cacheAt < 60e3 || Date.now() < backoffUntil)) return cache;
  const today = ilDay(Date.now()), yday = addDays(today, -1);
  const errors = {};
  const safe = (p, k) => p.catch(e => { errors[k] = String(e.message || e).slice(0, 200); return null; });
  const [series, events, vers, vToday, vYday, dly] = await Promise.all([
    safe(realtime(env, { dimensions: [{ name: "minutesAgo" }], metrics: [{ name: "eventCount" }] }), "series"),
    safe(realtime(env, { dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }], limit: 40 }), "events"),
    safe(realtime(env, { dimensions: [{ name: "appVersion" }], metrics: [{ name: "activeUsers" }], limit: 6 }), "versions"),
    safe(cfVisits(env, today), "visitsToday"), safe(cfVisits(env, yday), "visitsYesterday"), safe(collectDaily(env, today, yday), "daily")]);
  Object.assign(errors, dly?.errors || {});
  const perMin = Array(30).fill(0);
  for (const r of series || []) perMin[29 - Number(r.dimensionValues[0].value)] = Number(r.metricValues[0].value);
  const quota = Object.values(errors).some(m => /429|quota|Exhausted/i.test(m));
  if (quota) backoffUntil = Date.now() + 300e3;
  const prev = cache || {};
  const activeUsers = vers ? vers.reduce((t, r) => t + Number(r.metricValues[0].value || 0), 0) : (quota ? prev.activeUsers ?? null : null);
  cache = { build: BUILD, errors: quota ? { ga4: "מכסת Google מלאה, מוצגים נתונים אחרונים ויתעדכנו בעוד כמה דקות" } : errors, stale: quota, at: quota && prev.at ? prev.at : new Date().toISOString(), activeUsers, perMinute: series ? perMin : (quota ? prev.perMinute ?? null : null),
    events: events ? events.map(r => [r.dimensionValues[0].value, Number(r.metricValues[0].value)]).sort((a, b) => b[1] - a[1]) : (quota ? prev.events ?? null : null), versions: vers ? vers.map(r => [r.dimensionValues[0].value, Number(r.metricValues[0].value)]) : (quota ? prev.versions ?? null : null), visitsToday: vToday?.visits ?? null, visitsYesterday: vYday?.visits ?? null, viewsToday: vToday?.views ?? null, viewsYesterday: vYday?.views ?? null, daily: dly ? { ...dly, errors: undefined } : (quota ? prev.daily ?? null : null) };
  cacheAt = Date.now(); return cache;
}

const PAGE = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><link rel="icon" type="image/png" href="https://luchit.app/icon-192.png"><link rel="apple-touch-icon" href="https://luchit.app/apple-touch-icon.png"><title>לוחית, מצב עכשיו</title>
<style>:root{--bg:#f4f6fa;--card:#fff;--fg:#151a24;--muted:#5d6676;--line:#dfe4ec;--accent:#2457c5;--ok:#1a7f4b;--bad:#b3261e;--badbg:#fdecea}@media(prefers-color-scheme:dark){:root{--bg:#0e121a;--card:#171d28;--fg:#e9edf3;--muted:#98a2b4;--line:#262e3c;--accent:#7ea3f2;--ok:#5bd08a;--bad:#ff8a80;--badbg:#3a1f1f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,"Assistant",sans-serif;line-height:1.5}main{max-width:620px;margin:0 auto;padding:16px}h1{font-size:1.15rem;margin:0}h2{font-size:.85rem;margin:0 0 6px;color:var(--muted);font-weight:600}.top{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px}.muted{color:var(--muted);font-size:.8rem}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:8px}@media(min-width:520px){.grid{grid-template-columns:repeat(4,1fr)}}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;min-width:0;margin-bottom:8px}.grid .card{margin:0}
.num{font-size:1.8rem;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.2}.lbl{font-size:.78rem;color:var(--muted)}.sub{font-size:.72rem;color:var(--muted);margin-top:2px}.bad .num{color:var(--bad)}.bad{background:var(--badbg)}
ul{list-style:none;margin:0;padding:0}li{display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-top:1px solid var(--line)}li:first-child{border-top:0}li b{font-variant-numeric:tabular-nums}.dot{color:var(--ok)}details summary{cursor:pointer;font-size:.8rem;color:var(--muted)}.axis{display:flex;justify-content:space-between;font-size:.7rem;color:var(--muted);margin-top:2px}
.sec{font-size:.8rem;color:var(--accent);margin:14px 0 6px;font-weight:700}.pill{display:inline-block;background:var(--line);border-radius:999px;padding:2px 10px;font-size:.8rem;margin:0 0 4px 6px}</style></head><body><main>
<div class="top"><h1>לוחית · מצב עכשיו</h1><div class="muted"><span class="dot">●</span> עודכן <span id="t">טוען</span></div></div>
<h2 class="sec">עכשיו (30 הדקות האחרונות)</h2>
<div class="grid">
<div class="card"><div class="lbl">פעילים באפליקציה</div><div class="num" id="a">-</div><div class="sub">משתמשים ייחודיים</div></div>
<div class="card"><div class="lbl">בדיקות רכב</div><div class="num" id="l">-</div><div class="sub">מספר בדיקות</div></div>
<div class="card" id="pc"><div class="lbl">בעיות</div><div class="num" id="p">-</div><div class="sub" id="ps">כשלים, האטות וקריסות</div></div>
<div class="card"><div class="lbl">פעולות באפליקציה</div><div class="num" id="ac">-</div><div class="sub">סך אירועים (כמות, לא דקות)</div></div></div>
<div class="card"><h2>פעילות לפי דקה (מספר אירועים בכל דקה)</h2><svg id="s" viewBox="0 0 300 64" width="100%" height="64" role="img" aria-label="פעילות לפי דקה"></svg><div class="axis"><span>עכשיו</span><span>לפני 30 דקות</span></div></div>
<h2 class="sec">היום עד עכשיו, מול אתמול</h2>
<div class="grid" id="dg"></div>
<p class="muted" id="dnote">נתוני היום מגוגל אנליטיקס מתעדכנים בעיכוב של שעה עד כמה שעות, ולכן יכולים להיות נמוכים מהמציאות.</p>
<div class="card"><h2>מסלול השימוש היום (משתמשים ייחודיים בכל שלב)</h2><ul id="fn"></ul></div>
<div class="card" id="vc"><h2>גרסאות בשימוש היום (משתמשים פעילים)</h2><div id="vv"></div></div>
<h2 class="sec">האתר luchit.app (Cloudflare, כל מקורות התנועה)</h2>
<div class="grid"><div class="card"><div class="lbl">ביקורים היום</div><div class="num" id="v">-</div><div class="sub">אתמול: <span id="y">-</span></div></div>
<div class="card"><div class="lbl">צפיות בדפים היום</div><div class="num" id="pv">-</div><div class="sub">אתמול: <span id="pvy">-</span></div></div></div>
<div class="card"><h2>מאיפה מגיעים לאתר היום (ביקורים)</h2><ul id="so"></ul></div>
<div class="card"><h2>הדפים הנצפים ביותר היום (ביקורים)</h2><ul id="pg"></ul></div>
<div class="card"><h2>מדינות היום (ביקורים)</h2><ul id="co"></ul></div>
<h2 class="sec">פירוט הפעולות באפליקציה (30 הדקות האחרונות)</h2>
<div class="card"><h2>מה עושים באפליקציה (מספר פעמים)</h2><ul id="e"></ul></div>
<div class="card"><details><summary>פעילות טכנית של האפליקציה (מספר אירועים)</summary><ul id="tec" style="margin-top:6px"></ul></details></div>
<p class="muted" id="er" style="color:var(--bad);direction:rtl;text-align:right"></p><p class="muted">נתוני החיפוש בגוגל (Search Console) מתעכבים 2 עד 3 ימים, וקריסות ב-Play ביום או יומיים, ולכן הם לא כאן. הדף מתרענן כל 30 שניות.</p></main>
<script>
const N={car_lookup:"בדיקת רכב",tab_view:"פתיחת לשונית",share:"שיתוף",compare_open:"פתיחת השוואה",car_save:"שמירת רכב",link_out:"מעבר לקישור חיצוני",alerts_toggle:"שינוי התראות",alert_kind:"בחירת סוג התראה",upgrade_open:"פתיחת מסך שדרוג",upgrade_purchase_start:"התחלת רכישה",upgrade_purchase_done:"רכישה הושלמה",trial_start:"התחלת תקופת ניסיון",trial_end_shown:"סיום ניסיון הוצג",voice_search:"חיפוש קולי",bulk_check:"בדיקת כמה רכבים",camera_scan:"סריקה במצלמה",buy_card_open:"פתיחת כרטיס קנייה",settlement_shown:"הצגת הסדר פשרה",checklist_pdf:"הורדת רשימת בדיקה",doc_add:"הוספת מסמך",simple_view:"תצוגה פשוטה",simple_more:"עוד בתצוגה פשוטה",search_no_result:"חיפוש בלי תוצאה",lookup_from_cache:"בדיקה מהמטמון",user_screenshot:"צילום מסך",update_prompt:"הצעת עדכון",update_start:"התחלת עדכון",update_done:"עדכון הושלם",first_open:"התקנה חדשה",notification_open:"פתיחת התראה",notification_receive:"קבלת התראה",web_hint_click:"לחיצה על רמז מהאתר"};
const BAD={lookup_failed:"בדיקה שנכשלה",lookup_slow:"בדיקה איטית",lookup_abort:"בדיקה שבוטלה",lookup_timeout:"בדיקה שפגה",app_exception:"קריסה",crash:"קריסה"};
const TEC={user_engagement:"אירועי שימוש פעיל (כמות אירועים, לא דקות)",screen_view:"מעברים בין מסכים (כמות)",session_start:"כניסות חדשות לאפליקציה (כמות)",app_update:"עדכון האפליקציה במכשיר",os_update:"עדכון מערכת ההפעלה",app_clear_data:"ניקוי נתוני אפליקציה",app_remove:"הסרת האפליקציה",firebase_campaign:"הגעה מקמפיין",app_store_refund:"החזר כספי",in_app_purchase:"רכישה בחנות"};
const $=i=>document.getElementById(i),n=x=>x==null?"-":Number(x).toLocaleString("en-US"),esc=t=>String(t).replace(/[<>&]/g,"");
const row=(k,v,m)=>"<li><span>"+esc(m||k)+(m&&m!==k?"":"")+"</span><b>"+n(v)+"</b></li>";
async function go(){try{const r=await fetch("/live/data",{cache:"no-store"});if(!r.ok)throw 0;const d=await r.json(),ev=d.events||[];
const get=k=>(ev.find(e=>e[0]===k)||[0,0])[1];
$("a").textContent=n(d.activeUsers);$("l").textContent=d.events?n(get("car_lookup")):"-";
const bad=Object.keys(BAD).reduce((s,k)=>s+get(k),0);$("p").textContent=d.events?n(bad):"-";$("pc").className="card"+(bad>0?" bad":"");
$("ps").textContent=bad>0?ev.filter(e=>BAD[e[0]]).map(e=>BAD[e[0]]+" "+e[1]).join(", "):"אין בעיות";
$("ac").textContent=d.events?n(ev.reduce((t,e)=>t+e[1],0)):"-";
$("v").textContent=d.visitsToday==null?"-":n(d.visitsToday);$("y").textContent=d.visitsYesterday==null?"אין נתונים":n(d.visitsYesterday);
$("pv").textContent=d.viewsToday==null?"-":n(d.viewsToday);$("pvy").textContent=d.viewsYesterday==null?"אין נתונים":n(d.viewsYesterday);
const dl=d.daily||{},K=dl.kpi,E=dl.events;
const pct=(a,b)=>b>0?(Math.round(a/b*1000)/10).toLocaleString("en-US")+"%":"-",mins=x=>x==null||!isFinite(x)?"-":(Math.round(x/6)/10).toLocaleString("en-US");
const card=(l,v,y,h)=>'<div class="card"><div class="lbl">'+l+'</div><div class="num">'+v+'</div><div class="sub">אתמול: '+y+'</div><div class="sub">'+h+'</div></div>';
if(K&&K.today){const t=K.today,y=K.yesterday||{},ge=(o,k)=>o&&o[k]?o[k][0]:0,gu=(o,k)=>o&&o[k]?o[k][1]:0;
const fail=o=>["lookup_failed","lookup_timeout","lookup_abort"].reduce((s,k)=>s+ge(o,k),0);
$("dg").innerHTML=card("משתמשים פעילים",n(t.activeUsers),n(y.activeUsers),"משתמשים ייחודיים")+card("משתמשים חדשים",n(t.newUsers),n(y.newUsers),"נכנסו לראשונה")+card("כניסות לאפליקציה",n(t.sessions),n(y.sessions),"פתיחה חדשה, אחרי 30 דקות בלי פעילות")+card("זמן שימוש ממוצע למשתמש",mins(t.engageSec/Math.max(1,t.activeUsers))+" דק'",mins(y.engageSec/Math.max(1,y.activeUsers))+" דק'","(בדקות) רק זמן שהאפליקציה בחזית")+card("זמן ממוצע לכניסה",mins(t.engageSec/Math.max(1,t.sessions))+" דק'",mins(y.engageSec/Math.max(1,y.sessions))+" דק'","(בדקות) משך כל כניסה")+card("בדיקות רכב",n(ge(E&&E.today,"car_lookup")),n(ge(E&&E.yesterday,"car_lookup")),"מספר בדיקות")+card("שיעור כשלים",pct(fail(E&&E.today),ge(E&&E.today,"car_lookup")),pct(fail(E&&E.yesterday),ge(E&&E.yesterday,"car_lookup")),"כשלים ביחס למספר הבדיקות; נמוך עדיף")+card("מסכים שנצפו",n(t.views),n(y.views),"מספר צפיות במסכים");
const steps=[["car_lookup","בדק רכב"],["car_save","שמר רכב"],["share","שיתף"],["compare_open","פתח השוואה"],["upgrade_open","פתח מסך שדרוג"],["upgrade_purchase_start","התחיל רכישה"],["upgrade_purchase_done","רכש"]];
$("fn").innerHTML=steps.map(s=>'<li><span>'+s[1]+'</span><b>'+n(gu(E&&E.today,s[0]))+'</b></li>').join("")+'<li><span class="muted">מתוך משתמשים פעילים היום</span><b>'+n(t.activeUsers)+'</b></li>';
}else{$("dg").innerHTML='<div class="card"><div class="lbl">אין עדיין נתוני היום</div></div>';$("fn").innerHTML=""}
const vs2=dl.versions||[];$("vc").style.display=vs2.length?"":"none";$("vv").innerHTML=vs2.map(v=>'<span class="pill">גרסה '+esc(v[0])+": "+n(v[1])+"</span>").join("");
const SRC=h=>!h?"כניסה ישירה":/google\\./.test(h)?"גוגל":/bing\\.|duckduckgo|yahoo|ecosia/.test(h)?"מנועי חיפוש אחרים":/facebook|instagram|t\\.co|twitter|x\\.com|linkedin|whatsapp|telegram|t\\.me|tiktok|youtube/.test(h)?"רשתות חברתיות ופלטפורמות ("+h+")":h;
const agg=(arr,f)=>{const m={};(arr||[]).forEach(r=>{const k=f(r[0]);m[k]=(m[k]||0)+r[1]});return Object.entries(m).sort((a,b)=>b[1]-a[1])};
const lst=(id,arr)=>{$(id).innerHTML=arr&&arr.length?arr.map(r=>'<li><span>'+esc(r[0])+'</span><b>'+n(r[1])+'</b></li>').join(""):'<li><span class="muted">אין נתונים</span><b></b></li>'};
lst("so",dl.sources?agg(dl.sources,SRC):null);lst("pg",dl.pages?agg(dl.pages,h=>h||"/"):null);lst("co",dl.countries?agg(dl.countries,h=>h||"לא ידוע"):null);
const pm=d.perMinute||[],m=Math.max(1,...pm);
$("s").innerHTML='<line x1="0" x2="300" y1="62" y2="62" stroke="var(--line)"/>'+pm.map((v,i)=>{const h=v?Math.max(3,v/m*56):0;return '<rect x="'+(i*10+2)+'" y="'+(62-h)+'" width="7" height="'+h+'" fill="var(--accent)" rx="1.5"/>'}).join("");
const known=ev.filter(e=>N[e[0]]).sort((a,b)=>b[1]-a[1]);
$("e").innerHTML=known.map(e=>row(e[0],e[1],N[e[0]])).join("")||'<li><span class="muted">אין פעילות ב-30 הדקות האחרונות</span><b></b></li>';
const other=ev.filter(e=>!N[e[0]]&&!BAD[e[0]]).sort((a,b)=>b[1]-a[1]);
$("tec").innerHTML=other.map(e=>row(e[0],e[1],TEC[e[0]]||e[0])).join("")||'<li><span class="muted">אין</span><b></b></li>';
$("er").textContent=Object.entries(d.errors||{}).map(e=>e[0]+": "+e[1]).join(" | ");$("t").textContent=new Date(d.at).toLocaleTimeString("he-IL")}catch{$("t").textContent="אין חיבור"}}
go();setInterval(()=>{if(!document.hidden)go()},60000)</script></body></html>`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!(await verifyAccess(req, env).catch(() => false))) return new Response("forbidden", { status: 403, headers: HEAD });
    if (url.pathname === "/live/data") { try { return json(await collect(env)); } catch (e) { return json({ error: "unavailable" }, 502); } }
    if (url.pathname === "/live" || url.pathname === "/live/") return new Response(PAGE, { headers: { ...HEAD, "content-type": "text/html; charset=utf-8" } });
    return new Response("not found", { status: 404, headers: HEAD });
  }
};
