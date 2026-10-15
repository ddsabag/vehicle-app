// luchit-live: a private "right now" page for the owner. GET /live is the page, GET /live/data the numbers (GA4 Realtime + Cloudflare Web Analytics).
// Protected twice: Cloudflare Access in front (route luchit.app/live*), and this Worker verifies the Access JWT itself, so a misconfigured Access policy cannot leak data.
// Returns only aggregate counts, never anything personal. Secrets: GA_SERVICE_ACCOUNT_JSON, CF_API_TOKEN. Vars: see wrangler.toml.
const CF_TAG = "9bb0e756882c478a808d95596e0deade";
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const BUILD = "live-10";   // shown in /live/data so the running version is visible
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

const gtoks = {};
async function googleToken(env, scope = "https://www.googleapis.com/auth/analytics.readonly") {
  const c = gtoks[scope]; if (c && Date.now() < c.exp) return c.tok;
  const sa = JSON.parse(env.GA_SERVICE_ACCOUNT_JSON), now = Math.floor(Date.now() / 1000);
  const enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: "RS256", typ: "JWT" }) + "." + enc({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 });
  const pem = sa.private_key.replace(/-----[^-]+-----|\s/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = b64u(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig }) });
  if (!r.ok) throw new Error("google auth " + r.status);
  const tok = (await r.json()).access_token; gtoks[scope] = { tok, exp: Date.now() + 2900e3 }; return tok;
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
  const [kpi, evs, vers, src, pages] = await Promise.all([
    safe(report(env, { dateRanges: dr, metrics: ["activeUsers", "newUsers", "sessions", "userEngagementDuration", "screenPageViews"].map(name => ({ name })) }), "ga4 daily"),
    safe(report(env, { dateRanges: dr, dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], limit: 100 }), "ga4 events"),
    safe(report(env, { dateRanges: [dr[0]], dimensions: [{ name: "appVersion" }], metrics: [{ name: "activeUsers" }], orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }], limit: 8 }), "ga4 versions"),
    safe(cfTop(env, today, "refererHost"), "site sources"), safe(cfTop(env, today, "requestPath"), "site pages")]);
  const range = r => r.dimensionValues[r.dimensionValues.length - 1].value;   // "date_range_0" (today) or "date_range_1"
  const k = { today: null, yesterday: null };
  for (const r of kpi || []) { const o = {}; ["activeUsers", "newUsers", "sessions", "engageSec", "views"].forEach((n, i) => o[n] = Number(r.metricValues[i].value)); k[range(r) === "date_range_0" ? "today" : "yesterday"] = o; }
  const ev = { today: {}, yesterday: {} };
  for (const r of evs || []) ev[range(r) === "date_range_0" ? "today" : "yesterday"][r.dimensionValues[0].value] = [Number(r.metricValues[0].value), Number(r.metricValues[1].value)];
  daily = { errors, kpi: kpi ? k : null, events: evs ? ev : null, versions: vers ? vers.map(r => [r.dimensionValues[0].value, Number(r.metricValues[0].value)]) : null, sources: src, pages };
  dailyAt = Date.now(); return daily;
}

const SC = "sc-domain:luchit.app", SCOPE_SC = "https://www.googleapis.com/auth/webmasters.readonly";
let seo = null, seoAt = 0;
async function collectSeo(env, today) {
  if (seo && Date.now() - seoAt < 1800e3) return seo;
  const t = await googleToken(env, SCOPE_SC), base = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SC)}`;
  const errors = {}, safe = (p, k) => p.catch(e => { errors[k] = String(e.message || e).slice(0, 160); return null; });
  const q = async body => { const r = await fetch(base + "/searchAnalytics/query", { method: "POST", headers: { authorization: "Bearer " + t, "content-type": "application/json" }, body: JSON.stringify(body) }); if (!r.ok) throw new Error("search console " + r.status + " " + (await r.text()).replace(/\s+/g, " ").slice(0, 100)); return (await r.json()).rows || []; };
  const end = addDays(today, -3), w1 = [addDays(end, -6), end], w0 = [addDays(end, -13), addDays(end, -7)], d28 = [addDays(end, -27), end];
  const win = w => ({ startDate: w[0], endDate: w[1] });
  const [cur, prev, days, queries, pages, sm] = await Promise.all([
    safe(q({ ...win(w1) }), "seo totals"), safe(q({ ...win(w0) }), "seo prev"),
    safe(q({ ...win(d28), dimensions: ["date"], rowLimit: 40 }), "seo days"),
    safe(q({ ...win(d28), dimensions: ["query"], rowLimit: 250 }), "seo queries"),
    safe(q({ ...win(d28), dimensions: ["page"], rowLimit: 25 }), "seo pages"),
    safe(fetch(base + "/sitemaps", { headers: { authorization: "Bearer " + t } }).then(async r => { if (!r.ok) throw new Error("sitemaps " + r.status); return (await r.json()).sitemap || []; }), "seo sitemaps")]);
  const tot = r => r && r[0] ? { clicks: r[0].clicks, imps: r[0].impressions, ctr: r[0].ctr, pos: r[0].position } : null;
  const row = r => [r.keys[0], r.clicks, r.impressions, r.ctr, r.position];
  seo = { errors, range: w1, cur: tot(cur), prev: tot(prev), days: days ? days.map(r => [r.keys[0], r.clicks, r.impressions]).sort() : null,
    queries: queries ? queries.map(row) : null, pages: pages ? pages.map(row) : null,
    sitemaps: sm ? sm.map(x => ({ path: x.path, submitted: (x.contents || []).reduce((a, c) => a + Number(c.submitted || 0), 0), errors: Number(x.errors || 0), warnings: Number(x.warnings || 0), last: x.lastDownloaded || null })) : null };
  seoAt = Date.now(); return seo;
}

// agent news (same items as Telegram, public-safe) written by .github/scripts/flash.mjs to branch "flashes"
let flashes = null, flashesAt = 0;
async function getFlashes() {
  if (flashes && Date.now() - flashesAt < 300e3) return flashes;
  try { const r = await fetch("https://raw.githubusercontent.com/ddsabag/vehicle-app/flashes/flashes.json", { cf: { cacheTtl: 120 } }); flashes = r.ok ? await r.json() : (flashes || []); } catch { flashes = flashes || []; }
  flashesAt = Date.now(); return flashes;
}

// aggregate numbers published by the workflows (branch "flashes", metrics.json), e.g. how many pages Google reports as indexed
let metrics = null, metricsAt = 0;
async function getMetrics() {
  if (metrics && Date.now() - metricsAt < 300e3) return metrics;
  try { const r = await fetch("https://raw.githubusercontent.com/ddsabag/vehicle-app/flashes/metrics.json", { cf: { cacheTtl: 120 } }); metrics = r.ok ? await r.json() : (metrics || {}); } catch { metrics = metrics || {}; }
  metricsAt = Date.now(); return metrics;
}

let cache = null, cacheAt = 0, backoffUntil = 0;
async function collect(env) {
  // GA4 realtime has an hourly token quota: answer from cache for a minute, and after a 429 stop asking for 5 minutes (serve the last good numbers)
  if (cache && (Date.now() - cacheAt < 60e3 || Date.now() < backoffUntil)) return cache;
  const today = ilDay(Date.now()), yday = addDays(today, -1);
  const errors = {};
  const safe = (p, k) => p.catch(e => { errors[k] = String(e.message || e).slice(0, 200); return null; });
  const [series, events, vers, vToday, vYday, dly, sc] = await Promise.all([
    safe(realtime(env, { dimensions: [{ name: "minutesAgo" }], metrics: [{ name: "eventCount" }] }), "series"),
    safe(realtime(env, { dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }], limit: 40 }), "events"),
    safe(realtime(env, { dimensions: [{ name: "appVersion" }], metrics: [{ name: "activeUsers" }], limit: 6 }), "versions"),
    safe(cfVisits(env, today), "visitsToday"), safe(cfVisits(env, yday), "visitsYesterday"), safe(collectDaily(env, today, yday), "daily"), safe(collectSeo(env, today), "seo")]);
  Object.assign(errors, dly?.errors || {}, sc?.errors || {});
  const perMin = Array(30).fill(0);
  for (const r of series || []) perMin[29 - Number(r.dimensionValues[0].value)] = Number(r.metricValues[0].value);
  const quota = Object.values(errors).some(m => /429|quota|Exhausted/i.test(m));
  if (quota) backoffUntil = Date.now() + 300e3;
  const prev = cache || {};
  const activeUsers = vers ? vers.reduce((t, r) => t + Number(r.metricValues[0].value || 0), 0) : (quota ? prev.activeUsers ?? null : null);
  cache = { build: BUILD, errors: quota ? { ga4: "מכסת Google מלאה, מוצגים נתונים אחרונים ויתעדכנו בעוד כמה דקות" } : errors, stale: quota, at: quota && prev.at ? prev.at : new Date().toISOString(), activeUsers, perMinute: series ? perMin : (quota ? prev.perMinute ?? null : null),
    events: events ? events.map(r => [r.dimensionValues[0].value, Number(r.metricValues[0].value)]).sort((a, b) => b[1] - a[1]) : (quota ? prev.events ?? null : null), versions: vers ? vers.map(r => [r.dimensionValues[0].value, Number(r.metricValues[0].value)]) : (quota ? prev.versions ?? null : null), visitsToday: vToday?.visits ?? null, visitsYesterday: vYday?.visits ?? null, viewsToday: vToday?.views ?? null, viewsYesterday: vYday?.views ?? null, seo: sc ? { ...sc, errors: undefined } : (quota ? prev.seo ?? null : null), daily: dly ? { ...dly, errors: undefined } : (quota ? prev.daily ?? null : null) };
  cacheAt = Date.now(); return cache;
}

const PAGE = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><link rel="icon" type="image/png" href="https://luchit.app/icon-192.png"><link rel="apple-touch-icon" href="https://luchit.app/apple-touch-icon.png"><title>לוחית, מצב עכשיו</title>
<style>:root{--bg:#f4f6fa;--card:#fff;--fg:#151a24;--muted:#5d6676;--line:#dfe4ec;--accent:#2457c5;--ok:#1a7f4b;--bad:#b3261e;--warn:#a15c00;--badbg:#fdecea}@media(prefers-color-scheme:dark){:root{--warn:#e5a13a;--bg:#0e121a;--card:#171d28;--fg:#e9edf3;--muted:#98a2b4;--line:#262e3c;--accent:#7ea3f2;--ok:#5bd08a;--bad:#ff8a80;--badbg:#3a1f1f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,"Assistant",sans-serif;line-height:1.5}main{max-width:1120px;margin:0 auto;padding:20px}h1{font-size:1.15rem;margin:0}h2{font-size:.85rem;margin:0 0 6px;color:var(--muted);font-weight:600}.top{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px}.muted{color:var(--muted);font-size:.8rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:10px}.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:10px;align-items:start}.cols .card{margin:0}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;min-width:0;margin-bottom:8px}.grid .card{margin:0}
.num{font-size:1.8rem;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.2}.lbl{font-size:.78rem;color:var(--muted)}.sub{font-size:.72rem;color:var(--muted);margin-top:2px}.bad .num{color:var(--bad)}.bad{background:var(--badbg)}
ul{list-style:none;margin:0;padding:0}li{display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-top:1px solid var(--line)}li:first-child{border-top:0}li b{font-variant-numeric:tabular-nums}.dot{color:var(--ok)}details summary{cursor:pointer;font-size:.8rem;color:var(--muted)}.axis{display:flex;justify-content:space-between;font-size:.7rem;color:var(--muted);margin-top:2px}
table.q{width:100%;border-collapse:collapse;font-size:.85rem}.q th{font-weight:500;color:var(--muted);font-size:.72rem;text-align:start;padding:2px 6px 4px}.q td{padding:5px 6px;border-top:1px solid var(--line)}.q td.n{text-align:end;font-variant-numeric:tabular-nums;white-space:nowrap}.q td.w{word-break:break-word}.fl .lv{color:var(--muted)}.fl .lv.alert{color:var(--bad)}.fl small{color:var(--muted);white-space:nowrap}.tg{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}.tgc .lbl{display:flex;justify-content:space-between;gap:8px}.tgc .st{font-weight:700}.tgc .st.ok{color:var(--ok)}.tgc .st.warn{color:var(--warn)}.tgc .st.bad{color:var(--bad)}.bar{height:8px;background:var(--line);border-radius:999px;overflow:hidden;margin:8px 0 4px}.bar i{display:block;height:100%;border-radius:999px;background:var(--ok)}.bar i.warn{background:var(--warn)}.bar i.bad{background:var(--bad)}.hint{font-size:.75rem;color:var(--muted);margin:0 0 6px}.sec{font-size:.8rem;color:var(--accent);margin:14px 0 6px;font-weight:700}.pill{display:inline-block;background:var(--line);border-radius:999px;padding:2px 10px;font-size:.8rem;margin:0 0 4px 6px}</style></head><body><main>
<div class="top"><h1>לוחית · מצב עכשיו</h1><div class="muted"><span class="dot">●</span> עודכן <span id="t">טוען</span></div></div>
<h2 class="sec">מבזקים מהסוכנים (אותן הודעות שמגיעות לטלגרם, בלי הדוח השבועי)</h2>
<div class="card fl"><ul id="fl"></ul></div>
<h2 class="sec">יעדים לחודש הקרוב: מול ביצוע</h2>
<div class="tg" id="tg"></div>
<p class="muted" id="tgn"></p>
<h2 class="sec">עכשיו (30 הדקות האחרונות)</h2>
<div class="grid">
<div class="card"><div class="lbl">פעילים באפליקציה</div><div class="num" id="a">-</div><div class="sub">משתמשים ייחודיים</div></div>
<div class="card"><div class="lbl">בדיקות רכב</div><div class="num" id="l">-</div><div class="sub">מספר בדיקות</div></div>
<div class="card" id="pc"><div class="lbl">בעיות</div><div class="num" id="p">-</div><div class="sub" id="ps">כשלים, האטות וקריסות</div></div>
<div class="card"><div class="lbl">פעולות באפליקציה</div><div class="num" id="ac">-</div><div class="sub">סך אירועים (כמות, לא דקות)</div></div></div>
<div class="cols"><div class="card"><h2>פעילות לפי דקה (מספר אירועים בכל דקה)</h2><svg id="s" viewBox="0 0 300 64" width="100%" height="90" preserveAspectRatio="none" role="img" aria-label="פעילות לפי דקה"></svg><div class="axis"><span>עכשיו</span><span>לפני 30 דקות</span></div></div>
<div class="card"><h2>מה עושים באפליקציה (מספר פעמים)</h2><ul id="e"></ul></div></div>
<h2 class="sec">היום עד עכשיו, מול אתמול</h2>
<div class="grid" id="dg"></div>
<p class="muted" id="dnote">נתוני היום מגוגל אנליטיקס מתעדכנים בעיכוב של שעה עד כמה שעות, ולכן יכולים להיות נמוכים מהמציאות.</p>
<div class="cols"><div class="card"><h2>מסלול השימוש היום (משתמשים ייחודיים בכל שלב)</h2><ul id="fn"></ul></div>
<div class="card" id="vc"><h2>גרסאות בשימוש היום (משתמשים פעילים)</h2><div id="vv"></div></div></div>
<h2 class="sec">האתר luchit.app (Cloudflare, כל מקורות התנועה)</h2>
<div class="grid"><div class="card"><div class="lbl">ביקורים היום</div><div class="num" id="v">-</div><div class="sub">אתמול: <span id="y">-</span></div></div>
<div class="card"><div class="lbl">צפיות בדפים היום</div><div class="num" id="pv">-</div><div class="sub">אתמול: <span id="pvy">-</span></div></div></div>
<div class="cols"><div class="card"><h2>מאיפה מגיעים לאתר היום (ביקורים)</h2><ul id="so"></ul></div>
<div class="card"><h2>הדפים הנצפים ביותר היום (ביקורים)</h2><ul id="pg"></ul></div></div>
<h2 class="sec">SEO, חיפוש בגוגל (Search Console)</h2>
<p class="muted" id="seonote">טוען</p>
<div class="grid" id="sg"></div>
<div class="cols"><div class="card"><h2>קליקים מגוגל ב-28 ימים (כל עמודה יום)</h2><svg id="sd" viewBox="0 0 280 64" width="100%" height="90" preserveAspectRatio="none" role="img" aria-label="קליקים מגוגל לפי יום"></svg><div class="axis"><span>היום</span><span>לפני 28 ימים</span></div></div>
<div class="card"><h2>דפי האתר שגוגל מציג (28 ימים)</h2><ul id="sp"></ul></div></div>
<div class="cols"><div class="card"><h2>מה אנשים חיפשו כדי להגיע אלינו (28 ימים, לפי קליקים)</h2><div id="sq"></div></div>
<div class="card"><h2>קרובים לצמרת: חיפושים שאנחנו כבר מופיעים בהם, אבל לא בראש</h2><p class="hint">מקום 1 עד 10 הוא העמוד הראשון בגוגל. כאן מוצגים חיפושים שבהם האתר במקום 8 עד 20, ולכן קידום קטן של העמוד (כותרת, תוכן, קישורים פנימיים) יכול להביא קליקים. ממוינים לפי חשיפות.</p><div id="ss"></div></div></div>
<div class="card"><h2>מפת האתר (sitemap)</h2><ul id="sm"></ul></div>
<details class="card"><summary>איך לקרוא את נתוני ה-SEO</summary><ul style="margin-top:6px"><li><span>חשיפות</span><span>כמה פעמים האתר הופיע בתוצאות</span></li><li><span>קליקים</span><span>כמה לחצו מהתוצאות</span></li><li><span>CTR</span><span>קליקים חלקי חשיפות, באחוזים; גבוה עדיף</span></li><li><span>מיקום ממוצע</span><span>מקום בתוצאות: 1 הכי גבוה, 10 סוף העמוד הראשון; נמוך עדיף</span></li></ul></details>
<details class="card"><summary>פעילות טכנית של האפליקציה (מספר אירועים)</summary><ul id="tec" style="margin-top:6px"></ul></details>
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
lst("so",dl.sources?agg(dl.sources,SRC):null);lst("pg",dl.pages?agg(dl.pages,h=>h||"/"):null);
const S=d.seo;
if(S&&S.cur){const c=S.cur,p=S.prev||{},df=(a,b,inv)=>b?((a-b)/b*100):null,ar=v=>v==null?"אין מידע לשבוע קודם":(v>=0?"+":"")+(Math.round(v*10)/10)+"% לעומת שבוע קודם",pc=x=>(Math.round(x*1000)/10)+"%";
const sc=(l,v,pv,h)=>'<div class="card"><div class="lbl">'+l+'</div><div class="num">'+v+'</div><div class="sub">'+pv+'</div><div class="sub">'+h+'</div></div>';
$("sg").innerHTML=sc("קליקים מגוגל",n(Math.round(c.clicks)),ar(df(c.clicks,p.clicks)),"7 ימים")+sc("חשיפות בגוגל",n(Math.round(c.imps)),ar(df(c.imps,p.imps)),"כמה פעמים הופענו")+sc("CTR",pc(c.ctr),p.ctr!=null?"שבוע קודם: "+pc(p.ctr):"","קליקים חלקי חשיפות")+sc("מיקום ממוצע",(Math.round(c.pos*10)/10),p.pos!=null?"שבוע קודם: "+(Math.round(p.pos*10)/10):"","נמוך עדיף");
$("seonote").textContent="7 ימים עד "+S.range[1]+" (גוגל מעכב נתונים 2 עד 3 ימים, לכן אין כאן את הימים האחרונים).";
const dd=S.days||[],mx=Math.max(1,...dd.map(x=>x[1]));$("sd").innerHTML='<line x1="0" x2="280" y1="62" y2="62" stroke="var(--line)"/>'+dd.slice(-28).reverse().map((x,i)=>{const h=x[1]?Math.max(3,x[1]/mx*56):0;return '<rect x="'+(i*10)+'" y="'+(62-h)+'" width="7" height="'+h+'" fill="var(--accent)" rx="1.5"/>'}).join("");
const f3=r=>n(Math.round(r[1]))+" קליקים · "+n(Math.round(r[2]))+" חשיפות";
const L=(id,arr,fn)=>{$(id).innerHTML=arr&&arr.length?arr.map(fn).join(""):'<li><span class="muted">אין נתונים</span><b></b></li>'};
const path=u=>esc(u.replace(/^https?:\\/\\/[^/]+/,"")||"/");
L("sp",S.pages&&S.pages.slice(0,10),r=>'<li><span dir="ltr">'+path(r[0])+'</span><b>'+f3(r)+'</b></li>');
const qs=S.queries||[];
const TB=(id,heads,rows)=>{$(id).innerHTML=rows.length?'<table class="q"><thead><tr>'+heads.map(h=>'<th>'+h+'</th>').join("")+'</tr></thead><tbody>'+rows.map(r=>'<tr><td class="w">'+esc(r[0])+'</td>'+r.slice(1).map(x=>'<td class="n">'+x+'</td>').join("")+'</tr>').join("")+'</tbody></table>':'<p class="muted">אין נתונים</p>'};
const ps=x=>(Math.round(x*10)/10).toLocaleString("en-US");
TB("sq",["חיפוש","קליקים","חשיפות","מקום"],qs.slice().sort((a,b)=>b[1]-a[1]||b[2]-a[2]).slice(0,10).map(r=>[r[0],n(Math.round(r[1])),n(Math.round(r[2])),ps(r[4])]));
TB("ss",["חיפוש","חשיפות","מקום","קליקים"],qs.filter(r=>r[4]>=8&&r[4]<=20&&r[2]>=3).sort((a,b)=>b[2]-a[2]).slice(0,10).map(r=>[r[0],n(Math.round(r[2])),ps(r[4]),n(Math.round(r[1]))]));
L("sm",S.sitemaps,r=>'<li><span dir="ltr">'+path(r.path)+'</span><b>'+n(r.submitted)+" כתובות"+(r.errors||r.warnings?" ("+r.errors+" שגיאות, "+r.warnings+" אזהרות)":"")+'</b></li>');
}else{$("sg").innerHTML="";$("seonote").textContent=S?"אין עדיין נתוני חיפוש":"טוען או לא זמין (ראה שגיאות בתחתית הדף)"}
/* targets: set in this list (value, date) and edit when the plan changes. Cumulative goals (pages, clicks) are judged against a straight line from the starting value to the target date, a rate (share) against the target itself. */
const TARGETS=[
{id:"index",label:"דפים באינדקס של גוגל",unit:"",start:51,startDate:"2026-10-14",goal:75,due:"2026-11-15",hint:"מתוך 207 דפים במפת האתר. מתעדכן פעם ביום."},
{id:"clicks",label:"קליקים מגוגל בשבוע",unit:"",start:0,startDate:"2026-10-14",goal:5,due:"2026-11-15",hint:"7 ימים, עם עיכוב של 2 עד 3 ימים בנתוני גוגל."},
{id:"share",label:"אחוז המשתמשים שמשתפים",unit:"%",goal:10,rate:true,hint:"משתמשים ששיתפו מתוך אלה שבדקו רכב, אתמול. היעד נקבע בלי נתון קודם, ויתוקן אחרי שבועיים."}];
const st=(a,e)=>a>=e?"ok":e<2?"warn":a>=0.7*e?"warn":"bad";   // while the expected amount is still under 2 the data is too thin to show red
const SL={ok:"בקצב או מעליו",warn:"קצת מאחור",bad:"מאחור"};
const actuals={index:d.metrics&&d.metrics.index?d.metrics.index.indexed:null,clicks:d.seo&&d.seo.cur?Math.round(d.seo.cur.clicks):null,share:null};
{const Y=(dl.events&&dl.events.yesterday)||{},lk=Y.car_lookup?Y.car_lookup[1]:0,sh=Y.share?Y.share[1]:0;if(lk>=10)actuals.share=Math.round(sh/lk*1000)/10}
$("tg").innerHTML=TARGETS.map(t=>{const a=actuals[t.id];let exp=t.goal,state="warn",pct=0,note=t.hint;
if(a==null){return '<div class="card tgc"><div class="lbl"><span>'+t.label+'</span></div><div class="num">-</div><div class="sub">אין עדיין נתון. '+t.hint+'</div></div>'}
if(!t.rate){const s0=Date.parse(t.startDate),e0=Date.parse(t.due),f=Math.min(1,Math.max(0,(Date.now()-s0)/(e0-s0)));exp=t.start+(t.goal-t.start)*f;state=st(a-t.start,exp-t.start);pct=(a-t.start)/(t.goal-t.start)*100;note="אמור להיות היום: "+n(Math.round(exp*10)/10)+" · עד "+t.due.split("-").reverse().slice(0,2).join("/")+". "+t.hint}
else{state=st(a,t.goal);pct=a/t.goal*100}
return '<div class="card tgc"><div class="lbl"><span>'+t.label+'</span><span class="st '+state+'">'+SL[state]+'</span></div><div class="num">'+n(a)+t.unit+' <span class="muted" style="font-size:.9rem;font-weight:400">מתוך יעד '+n(t.goal)+t.unit+'</span></div><div class="bar" role="img" aria-label="התקדמות"><i class="'+state+'" style="width:'+Math.max(2,Math.min(100,pct))+'%"></i></div><div class="sub">'+note+'</div></div>'}).join("");
$("tgn").textContent="ירוק: בקצב או מעליו. כתום: עד 30% מאחורי הקצב. אדום: יותר מזה.";
const FK={data:"נתונים",infra:"תשתית",content:"תוכן",market:"שוק",release:"שחרור",experiment:"ניסוי",reviews:"ביקורות"};
$("fl").innerHTML=(d.flashes||[]).slice(0,12).map(f=>'<li><span><span class="lv '+(f.l==="alert"?"alert":"")+'">'+(f.l==="alert"?"●":"○")+'</span> <b style="font-variant-numeric:normal">'+esc(FK[f.k]||f.k)+':</b> '+esc(f.x)+(f.u&&/^https:\\/\\//.test(f.u)?' <a href="'+esc(f.u)+'" target="_blank" rel="noopener">קישור</a>':'')+'</span><small>'+new Date(f.t).toLocaleString("he-IL",{timeZone:"Asia/Jerusalem",day:"numeric",month:"numeric",hour:"2-digit",minute:"2-digit"})+'</small></li>').join("")||'<li><span class="muted">אין מבזקים עדיין. הם יופיעו כשהסוכנים ידווחו על משהו.</span></li>';
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
    if (url.pathname === "/live/data") { try { return json({ ...(await collect(env)), flashes: (await getFlashes()).slice(0, 15), metrics: await getMetrics() }); } catch (e) { return json({ error: "unavailable" }, 502); } }
    if (url.pathname === "/live" || url.pathname === "/live/") return new Response(PAGE, { headers: { ...HEAD, "content-type": "text/html; charset=utf-8" } });
    return new Response("not found", { status: 404, headers: HEAD });
  }
};
