// luchit-live: a private business dashboard for the owner. GET /live is the page, GET /live/data the numbers (GA4, Cloudflare Web Analytics, Search Console, Google Play store page, Play Console releases and its statistics reports).
// Protected twice: Cloudflare Access in front (route luchit.app/live*), and this Worker verifies the Access JWT itself, so a misconfigured Access policy cannot leak data.
// Returns only aggregate counts, never anything personal. Secrets: GA_SERVICE_ACCOUNT_JSON, CF_API_TOKEN. Vars: see wrangler.toml.
const CF_TAG = "9bb0e756882c478a808d95596e0deade";
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const BUILD = "live-24";   // shown in /live/data so the running version is visible
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

// one token for every Google API the screen reads (a Worker request may make only 50 outside calls, so no token per API)
const SCOPES = ["analytics.readonly", "webmasters.readonly", "androidpublisher", "devstorage.read_only"].map(x => "https://www.googleapis.com/auth/" + x).join(" ");
const gtoks = {};
async function googleToken(env) {
  const scope = SCOPES, c = gtoks[scope]; if (c && Date.now() < c.exp) return c.tok;
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
async function cfQuery(env, day, dim, limit, lastDay = day) {   // Israel days day..lastDay
  const token = cleanToken(env.CF_API_TOKEN), account = String(env.CF_ACCOUNT_ID || "").trim();
  if (!token || !account) return null;
  const dims = dim ? `dimensions{${dim}}` : "";
  const q = `query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){rumPageloadEventsAdaptiveGroups(filter:$f,limit:${limit},orderBy:[sum_visits_DESC]){count sum{visits} ${dims}}}}}`;
  const f = { AND: [{ datetime_geq: ilStart(day), datetime_lt: ilStart(addDays(lastDay, 1)) }, { siteTag: CF_TAG }] };
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: { acc: account, f } }) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.errors) throw new Error("cloudflare " + r.status + " " + JSON.stringify(j?.errors || j).slice(0, 140));
  return j?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];
}
async function cfVisits(env, day) {
  const g = await cfQuery(env, day, "", 1); if (g == null) return null;
  return g[0] ? { visits: Math.round(g[0].sum.visits), views: g[0].count } : { visits: 0, views: 0 };
}
async function cfTop(env, day, dim, lastDay = day) {
  const g = await cfQuery(env, day, dim, 12, lastDay); if (g == null) return null;
  return g.map(x => [x.dimensions[dim] || "", Math.round(x.sum.visits), x.count]);
}

// Google Play's pre-launch report installs every uploaded build on test devices abroad, so app numbers count only devices in Israel; the site keeps every visitor
const REAL = { orGroup: { expressions: [{ filter: { fieldName: "platform", stringFilter: { value: "web" } } }, { filter: { fieldName: "countryId", stringFilter: { value: "IL" } } }] } };
const withReal = f => ({ andGroup: { expressions: [f, REAL] } });
// app devices in Israel only: on the site every page load is a new GA4 "user" (the web client id is never saved), so user counts come from the app
const APP = { andGroup: { expressions: [{ filter: { fieldName: "platform", stringFilter: { value: "Android" } } }, { filter: { fieldName: "countryId", stringFilter: { value: "IL" } } }] } };

let daily = null, dailyAt = 0;
async function collectDaily(env, today, yday) {
  if (daily && Date.now() - dailyAt < 300e3) return daily;
  const errors = {}, safe = (p, k) => p.catch(e => { errors[k] = String(e.message || e).slice(0, 200); return null; });
  const dr = [{ startDate: "today", endDate: "today" }, { startDate: "yesterday", endDate: "yesterday" }];
  const [kpi, evs, vers, src, pages] = await Promise.all([
    safe(report(env, { dateRanges: dr, metrics: ["activeUsers", "newUsers", "sessions", "userEngagementDuration", "screenPageViews"].map(name => ({ name })), dimensionFilter: REAL }), "ga4 daily"),
    safe(report(env, { dateRanges: dr, dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: REAL, limit: 100 }), "ga4 events"),
    safe(report(env, { dateRanges: [dr[0]], dimensions: [{ name: "appVersion" }], metrics: [{ name: "activeUsers" }], dimensionFilter: APP, orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }], limit: 8 }), "ga4 versions"),
    safe(cfTop(env, today, "refererHost"), "site sources"), safe(cfTop(env, today, "requestPath"), "site pages")]);
  const range = r => r.dimensionValues[r.dimensionValues.length - 1].value;   // "date_range_0" (today) or "date_range_1"
  const k = { today: null, yesterday: null };
  for (const r of kpi || []) { const o = {}; ["activeUsers", "newUsers", "sessions", "engageSec", "views"].forEach((n, i) => o[n] = Number(r.metricValues[i].value)); k[range(r) === "date_range_0" ? "today" : "yesterday"] = o; }
  const ev = { today: {}, yesterday: {} };
  for (const r of evs || []) ev[range(r) === "date_range_0" ? "today" : "yesterday"][r.dimensionValues[0].value] = [Number(r.metricValues[0].value), Number(r.metricValues[1].value)];
  daily = { errors, kpi: kpi ? k : null, events: evs ? ev : null, versions: vers ? vers.map(r => [r.dimensionValues[0].value, Number(r.metricValues[0].value)]) : null, sources: src, pages };
  dailyAt = Date.now(); return daily;
}

// Where a visit came from, in the buckets of the marketing plan. The site's events reach GA4 through the Measurement Protocol, without a
// session, so their session source is always "(not set)": the page sends the source itself with every event (src, index.html LAND): the
// utm_source of the /go/ short links, "share" for a shared report, else the referring site (google, search, facebook..., site = another page
// of luchit.app, direct). The app is one bucket, because a session inside the app carries no source worth reading. Site events from before
// src existed (19.10.2026) are "unknown".
const GO_SOURCES = ["tiktok", "instagram", "facebook", "linkedin", "youtube", "whatsapp", "newsletter", "press", "dealer", "qr", "share"];
const WEB_SOURCES = ["google", "search", "direct", "site"];
function srcBucket(platform, src) {
  if (platform !== "web") return "app";
  const s = String(src || "").toLowerCase();
  if (GO_SOURCES.includes(s) || WEB_SOURCES.includes(s)) return s;
  if (s === "luchitapp") return "app";   // a link from inside the app to the site
  return !s || s === "(not set)" ? "unknown" : "other";
}

// The business view: whole weeks, not "right now". GA4 needs about a day to finish counting, so the week ends yesterday after noon and the day before until then.
const ilHour = t => Number(new Date(t).toLocaleString("en-US", { timeZone: "Asia/Jerusalem", hour: "2-digit", hourCycle: "h23" }));
let weekly = null, weeklyAt = 0;
async function collectWeekly(env, today) {
  if (weekly && Date.now() - weeklyAt < 900e3) return weekly;
  const errors = {}, safe = (p, k) => p.catch(e => { errors[k] = String(e.message || e).slice(0, 200); return null; });
  const end = addDays(today, ilHour(Date.now()) >= 12 ? -1 : -2);
  const W = [addDays(end, -6), end], P = [addDays(end, -13), addDays(end, -7)], M = [addDays(end, -27), end];
  const dr = w => ({ startDate: w[0], endDate: w[1] }), only = v => ({ filter: { fieldName: "eventName", stringFilter: { value: v } } }), any = vs => ({ filter: { fieldName: "eventName", inListFilter: { values: vs } } });
  const histFrom = [addDays(end, -62), "2026-10-04"].sort()[0];   // the growth target is chained from the week of 18-24.10, so keep that week in reach
  const CW = [addDays(today, -7), addDays(today, -1)];            // Cloudflare counts in real time: the last 7 whole days
  const [evs, fails, links, hist, app, money, src, pages, saveU, bySrc] = await Promise.all([
    safe(report(env, { dateRanges: [dr(W), dr(P), dr(M)], dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: REAL, limit: 250 }), "ga4 week"),
    safe(report(env, { dateRanges: [dr(W), dr(P)], dimensions: [{ name: "customEvent:kind" }], metrics: [{ name: "eventCount" }], dimensionFilter: withReal(only("lookup_failed")), limit: 20 }), "ga4 failures"),
    safe(report(env, { dateRanges: [dr(W), dr(P)], dimensions: [{ name: "eventName" }, { name: "customEvent:kind" }, { name: "customEvent:via" }], metrics: [{ name: "eventCount" }], dimensionFilter: withReal(any(["link_landing", "link_open", "referral_open"])), limit: 200 }), "ga4 shared links"),
    safe(report(env, { dateRanges: [{ startDate: histFrom, endDate: end }], dimensions: [{ name: "date" }], metrics: [{ name: "eventCount" }], dimensionFilter: withReal(only("car_lookup")), limit: 1000 }), "ga4 history"),
    safe(report(env, { dateRanges: [dr(W), dr(P), dr(M)], dimensions: [{ name: "countryId" }], metrics: [{ name: "newUsers" }, { name: "activeUsers" }], dimensionFilter: { filter: { fieldName: "platform", stringFilter: { value: "Android" } } }, limit: 250 }), "ga4 app"),
    safe(report(env, { dateRanges: [{ startDate: "2026-10-01", endDate: "today" }], dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: any(["b2b_lead_submit", "newsletter_confirm"]) }), "ga4 money"),
    safe(cfTop(env, CW[0], "refererHost", CW[1]), "site week sources"), safe(cfTop(env, CW[0], "requestPath", CW[1]), "site week pages"),
    safe(report(env, { dateRanges: [dr(W)], dimensions: [{ name: "eventName" }], metrics: [{ name: "totalUsers" }], dimensionFilter: { andGroup: { expressions: [APP, any(["car_lookup", "car_save"])] } } }), "ga4 app savers"),
    safe(report(env, { dateRanges: [dr(W), dr(P)], dimensions: [{ name: "platform" }, { name: "customEvent:src" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: withReal(any(["session_start", "web_visit", "car_lookup"])), limit: 2000 }), "ga4 sources")]);
  const ri = r => { const v = r.dimensionValues[r.dimensionValues.length - 1].value; return /^date_range_\d$/.test(v) ? Number(v.slice(-1)) : 0; };
  const ev = [{}, {}, {}];
  for (const r of evs || []) ev[ri(r)][r.dimensionValues[0].value] = [Number(r.metricValues[0].value), Number(r.metricValues[1].value)];
  const fk = [{}, {}];
  for (const r of fails || []) fk[ri(r)][r.dimensionValues[0].value] = Number(r.metricValues[0].value);
  // arrivals from a shared report: web landings and app opens whose link carried s=img|full|pdf|txt|qr (campaign links are counted apart)
  const shared = [{ web: 0, app: 0, by: {} }, { web: 0, app: 0, by: {} }];
  for (const r of links || []) {
    const [name, kind, via] = r.dimensionValues.map(x => x.value), c = Number(r.metricValues[0].value), o = shared[ri(r)];
    if (kind === "campaign" || !via || via === "none" || via === "(not set)") continue;
    o[name === "link_landing" ? "web" : "app"] += c; o.by[via] = (o.by[via] || 0) + c;
  }
  // first opens (new devices) and active devices of the app, in Israel and abroad (abroad is mostly Google's pre-launch test devices)
  const appU = [0, 1, 2].map(i => { const o = { newUsers: 0, activeUsers: 0, abroadNew: 0, abroadActive: 0 };
    for (const r of app || []) if (ri(r) === i) { const il = r.dimensionValues[0].value === "IL"; o[il ? "newUsers" : "abroadNew"] += Number(r.metricValues[0].value); o[il ? "activeUsers" : "abroadActive"] += Number(r.metricValues[1].value); }
    return o; });
  const m = {}; for (const r of money || []) m[r.dimensionValues[0].value] = Number(r.metricValues[0].value);
  // visits (app: session_start, site: web_visit, once per opening of the page) and car checks by where the visit came from, this week [0] and
  // the week before [1]: { bucket: [visits, checks] }
  const bs = [{}, {}];
  for (const r of bySrc || []) { const [pf, so, name] = r.dimensionValues.map(x => x.value), o = bs[ri(r)], k = srcBucket(pf, so); (o[k] ||= [0, 0])[name === "car_lookup" ? 1 : 0] += Number(r.metricValues[0].value); }
  weekly = { errors, end, W, P, M, CW, ev: evs ? ev : null, fails: fails ? fk : null, shared: links ? shared : null,
    days: hist ? Object.fromEntries(hist.map(r => { const d = r.dimensionValues[0].value; return [d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6), Number(r.metricValues[0].value)]; })) : null,
    app: app ? appU : null, savers: saveU ? Object.fromEntries(saveU.map(r => [r.dimensionValues[0].value, Number(r.metricValues[0].value)])) : null, money: money ? { leads: m.b2b_lead_submit || 0, subscribers: m.newsletter_confirm || 0 } : null, sources: src, pages, bySource: bySrc ? bs : null };
  weeklyAt = Date.now(); return weekly;
}

// Is the app public on Google Play? The store page answers 404 until the app is published to everyone; it flips to "live" only when anyone
// can install. Checked hourly with a time limit; playSeen is the last answer that counted. A request that comes while a check is running gets
// the last known answer (sharing the running check could leave later requests waiting forever if the first one is cancelled).
let play = null, playAt = 0, playSeen = null;
async function playStatus() {
  if (Date.now() - playAt < (play ? 3600e3 : 600e3)) return play;
  playAt = Date.now();
  try {
    const r = await fetch("https://play.google.com/store/apps/details?id=com.ddsabag.pratirechev&hl=he", { redirect: "manual", cf: { cacheTtl: 900 }, signal: AbortSignal.timeout(8e3) });
    if (r.status === 200 && (await r.text()).includes("com.ddsabag.pratirechev")) { play = "live"; playSeen = new Date().toISOString(); }
    else if (r.status === 404) { play = "review"; playSeen = new Date().toISOString(); }
  } catch {}
  return play;
}

// Where the production release stands, straight from Play Console (Play Developer API, a read-only list that needs no edit): in review,
// approved, rejected, published. Needs the Google Play Android Developer API enabled in the service account's Cloud project and the account
// invited in Play Console; until then { ok: false, why } and the screen keeps the store page check alone. Never throws.
let rel = null, relAt = 0;
async function playRelease(env) {
  if (rel && Date.now() - relAt < 900e3) return rel;
  relAt = Date.now();
  try {
    const r = await fetch("https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.ddsabag.pratirechev/tracks/production/releases",
      { headers: { authorization: "Bearer " + await googleToken(env) }, signal: AbortSignal.timeout(8e3) });
    if (!r.ok) { const t = await r.text(); let m = t; try { m = JSON.parse(t).error.message || t; } catch {} rel = { ok: false, why: r.status + " " + String(m).replace(/\s+/g, " ").slice(0, 160) }; }
    else {
      const list = ((await r.json()).releases || []).map(x => ({ name: String(x.releaseName || "").slice(0, 40), state: String(x.releaseLifecycleState || "").replace("RELEASE_LIFECYCLE_STATE_", "").toLowerCase(),
        code: Math.max(0, ...(x.activeArtifacts || []).map(a => Number(a.versionCode) || 0)) }));
      list.sort((a, b) => b.code - a.code);   // newest build first
      rel = { ok: true, at: new Date().toISOString(), list: list.slice(0, 3) };
    }
  } catch (e) { rel = { ok: false, why: String(e.message || e).slice(0, 160) }; }
  return rel;
}

// Exact installs from Google Play's own statistics: the monthly reports Play Console writes to its Cloud Storage bucket (stats/installs and
// stats/store_performance, by country), read with the same service account. Needs the bucket name (var PLAY_REPORTS_BUCKET, "pubsite_prod_..."
// from Download reports > Statistics) and the account-level Play Console permission "View app information and download bulk reports".
// Google posts each day a few days late, so the week here is the last 7 days that have data. Until then { ok: false, why }. Never throws.
const PKG = "com.ddsabag.pratirechev";
const csvText = b => {   // Play writes UTF-16LE with a byte order mark; anything else is read as UTF-8
  const u = new Uint8Array(b), le = u[0] === 0xff && u[1] === 0xfe;
  if (!le && !(u.length > 1 && u[0] !== 0 && u[1] === 0)) return new TextDecoder().decode(u);
  const c = []; for (let i = le ? 2 : 0; i + 1 < u.length; i += 2) c.push(u[i] | u[i + 1] << 8);
  let s = ""; for (let i = 0; i < c.length; i += 8192) s += String.fromCharCode(...c.slice(i, i + 8192));
  return s;
};
const csvRows = t => {   // rows as objects keyed by the header in lower case letters only ("Daily User Installs" -> dailyuserinstalls)
  const split = l => { const o = []; let c = "", q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { o.push(c.trim()); c = ""; } else c += ch; } o.push(c.trim()); return o; };
  const lines = t.split(/\r?\n/).filter(l => l.trim()), head = split(lines[0] || "").map(h => h.toLowerCase().replace(/[^a-z]/g, ""));
  return lines.slice(1).map(l => { const v = split(l), r = {}; head.forEach((h, i) => { r[h] = v[i]; }); return r; });
};
const isoDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : (t => isNaN(t) ? "" : new Date(t).toISOString().slice(0, 10))(Date.parse(s + " UTC"));
let pst = null, pstAt = 0;
async function playStats(env, today) {
  const bucket = String(env.PLAY_REPORTS_BUCKET || "").trim().replace(/^gs:\/\//, "").split("/")[0];
  if (!bucket) return { ok: false, why: "no bucket" };
  if (pst && Date.now() - pstAt < (pst.ok ? 3 * 3600e3 : 900e3)) return pst;
  pstAt = Date.now();
  try {
    const tok = await googleToken(env);
    const month = k => { const d = new Date(Date.parse(today.slice(0, 7) + "-15T12:00:00Z")); d.setUTCMonth(d.getUTCMonth() + k); return d.toISOString().slice(0, 7).replace("-", ""); };
    const get = async (kind, m) => {
      const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(`stats/${kind}/${kind}_${PKG}_${m}_country.csv`)}?alt=media`,
        { headers: { authorization: "Bearer " + tok }, signal: AbortSignal.timeout(8e3) });
      if (r.status === 404) return null;   // this month's file does not exist yet
      if (!r.ok) { const t = await r.text(); let msg = t; try { msg = JSON.parse(t).error.message || t; } catch {} throw new Error(r.status + " " + String(msg).replace(/\s+/g, " ").slice(0, 140)); }
      return csvRows(csvText(await r.arrayBuffer()));
    };
    const [i0, i1, s0, s1] = await Promise.all([get("installs", month(-1)), get("installs", month(0)), get("store_performance", month(-1)), get("store_performance", month(0))]);
    if (!i0 && !i1) throw new Error("404 no installs report in the bucket for " + month(-1) + " or " + month(0));
    // per day: new users in Israel, new users abroad, users who uninstalled (Israel), all install events incl. reinstalls (Israel), store listing visitors and acquisitions (Israel)
    const day = {}, at = d => day[d] || (day[d] = [0, 0, 0, 0, 0, 0]), num = v => Number(String(v || "").replace(/,/g, "")) || 0, cc = r => r.country ?? r.countryregion ?? "";
    let total = 0, totalDay = "";
    for (const r of [...(i0 || []), ...(i1 || [])]) {
      const d = isoDay(r.date || ""); if (!d) continue;
      const a = at(d);
      if (cc(r) === "IL") { a[0] += num(r.dailyuserinstalls); a[2] += num(r.dailyuseruninstalls); a[3] += num(r.installevents); if (d >= totalDay && num(r.totaluserinstalls)) { total = num(r.totaluserinstalls); totalDay = d; } }
      else a[1] += num(r.dailyuserinstalls);
    }
    for (const r of [...(s0 || []), ...(s1 || [])]) { const d = isoDay(r.date || ""); if (d && cc(r) === "IL") { const a = at(d); a[4] += num(r.storelistingvisitors); a[5] += num(r.storelistingacquisitions); } }
    const last = Object.keys(day).sort().pop();   // the newest day Google has posted
    if (!last) throw new Error("the installs report has no rows");
    const sum = w => { const o = [0, 0, 0, 0, 0, 0]; for (const [d, a] of Object.entries(day)) if (d >= w[0] && d <= w[1]) a.forEach((v, i) => { o[i] += v; });
      return { users: o[0], abroad: o[1], uninstalls: o[2], events: o[3], visitors: o[4], acquisitions: o[5] }; };
    const W = [addDays(last, -6), last], P = [addDays(last, -13), addDays(last, -7)];
    pst = { ok: true, at: new Date().toISOString(), last, W, P, cur: sum(W), prev: sum(P), total: total || null, store: !!(s0 || s1) };
  } catch (e) { pst = { ok: false, why: String(e.message || e).slice(0, 160) }; }
  return pst;
}

// GA4 counts days in the property's time zone; the screen assumes Israel, so the technical drawer shows it (Admin API, read-only, daily). Never throws.
let gaTz = null, gaTzAt = 0;
async function gaTimeZone(env) {
  if (Date.now() - gaTzAt < (gaTz && gaTz.ok ? 864e5 : 3600e3)) return gaTz;
  gaTzAt = Date.now();
  try {
    const r = await fetch(`https://analyticsadmin.googleapis.com/v1beta/properties/${env.GA_PROPERTY_ID}`, { headers: { authorization: "Bearer " + await googleToken(env) }, signal: AbortSignal.timeout(8e3) });
    if (!r.ok) { const t = await r.text(); let m = t; try { m = JSON.parse(t).error.message || t; } catch {} gaTz = { ok: false, why: r.status + " " + String(m).replace(/\s+/g, " ").slice(0, 140) }; }
    else gaTz = { ok: true, tz: (await r.json()).timeZone || "" };
  } catch (e) { gaTz = { ok: false, why: String(e.message || e).slice(0, 140) }; }
  return gaTz;
}

const SC = "sc-domain:luchit.app";
let seo = null, seoAt = 0;
async function collectSeo(env, today) {
  if (seo && Date.now() - seoAt < 1800e3) return seo;
  const t = await googleToken(env), base = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SC)}`;
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
  // a Worker request may make only 50 outside calls: get the token once, before the parallel calls, or each of them fetches its own
  await googleToken(env).catch(() => {});
  const [series, events, vers, vToday, vYday, dly, sc, wk, ps, rl, pls, tz, plats] = await Promise.all([
    safe(realtime(env, { dimensions: [{ name: "minutesAgo" }], metrics: [{ name: "eventCount" }], dimensionFilter: REAL }), "series"),
    safe(realtime(env, { dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: REAL, limit: 40 }), "events"),
    safe(realtime(env, { dimensions: [{ name: "appVersion" }], metrics: [{ name: "activeUsers" }], dimensionFilter: APP, limit: 6 }), "versions"),
    safe(cfVisits(env, today), "visitsToday"), safe(cfVisits(env, yday), "visitsYesterday"), safe(collectDaily(env, today, yday), "daily"), safe(collectSeo(env, today), "seo"),
    safe(collectWeekly(env, today), "weekly"), playStatus(), playRelease(env), playStats(env, today), gaTimeZone(env),
    safe(realtime(env, { dimensions: [{ name: "platform" }], metrics: [{ name: "activeUsers" }], dimensionFilter: REAL }), "platforms")]);
  Object.assign(errors, dly?.errors || {}, sc?.errors || {}, wk?.errors || {});
  const perMin = Array(30).fill(0);
  for (const r of series || []) perMin[29 - Number(r.dimensionValues[0].value)] = Number(r.metricValues[0].value);
  const quota = Object.values(errors).some(m => /429|quota|Exhausted/i.test(m));
  if (quota) backoffUntil = Date.now() + 300e3;
  const prev = cache || {};
  const activeUsers = vers ? vers.reduce((t, r) => t + Number(r.metricValues[0].value || 0), 0) : (quota ? prev.activeUsers ?? null : null);
  // the site in the last 30 minutes: each opening of the page is its own "user" (no cookies, no stored id), so this counts openings
  const webUsers = plats ? plats.filter(r => r.dimensionValues[0].value === "web").reduce((t, r) => t + Number(r.metricValues[0].value || 0), 0) : (quota ? prev.webUsers ?? null : null);
  cache = { build: BUILD, errors: quota ? { ga4: "מכסת Google מלאה, מוצגים נתונים אחרונים ויתעדכנו בעוד כמה דקות" } : errors, stale: quota, at: quota && prev.at ? prev.at : new Date().toISOString(), activeUsers, webUsers, perMinute: series ? perMin : (quota ? prev.perMinute ?? null : null),
    events: events ? events.map(r => [r.dimensionValues[0].value, Number(r.metricValues[0].value)]).sort((a, b) => b[1] - a[1]) : (quota ? prev.events ?? null : null), versions: vers ? vers.map(r => [r.dimensionValues[0].value, Number(r.metricValues[0].value)]) : (quota ? prev.versions ?? null : null), visitsToday: vToday?.visits ?? null, visitsYesterday: vYday?.visits ?? null, viewsToday: vToday?.views ?? null, viewsYesterday: vYday?.views ?? null, seo: sc ? { ...sc, errors: undefined } : (quota ? prev.seo ?? null : null), daily: dly ? { ...dly, errors: undefined } : (quota ? prev.daily ?? null : null),
    weekly: wk ? { ...wk, errors: undefined } : (quota ? prev.weekly ?? null : null), play: ps, playAt: playSeen, release: rl, stats: pls, gaTz: tz };
  cacheAt = Date.now(); return cache;
}

const PAGE = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><link rel="icon" type="image/png" href="https://luchit.app/icon-192.png"><link rel="apple-touch-icon" href="https://luchit.app/apple-touch-icon.png"><title>לוחית, מצב העסק</title>
<style>
:root{--bg:#f5f6f8;--card:#fff;--fg:#141922;--muted:#5b6474;--line:#e2e6ec;--soft:#f1f3f6;--accent:#2f5bb7;--ok:#1d7a4c;--ok-bg:#e7f3ec;--warn:#985a00;--warn-bg:#fbf0de;--bad:#ad2f29;--bad-bg:#fbe9e8;--nt:#626b7b;--nt-bg:#eef0f3}
@media(prefers-color-scheme:dark){:root{--bg:#0f131a;--card:#171c25;--fg:#e8ecf2;--muted:#a0a9b8;--line:#283142;--soft:#1d2330;--accent:#8fadf2;--ok:#6fcb97;--ok-bg:#15281e;--warn:#e3a957;--warn-bg:#2b2316;--bad:#f2908a;--bad-bg:#2f1c1c;--nt:#a0a9b8;--nt-bg:#222a36}}
*{box-sizing:border-box}html{direction:rtl}body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui,"Assistant","Segoe UI",sans-serif;line-height:1.5;text-align:right}
main{max-width:1280px;margin:0 auto;padding:20px 24px 32px}h1,h2,h3,p{margin:0}a{color:var(--accent)}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}.brand{display:flex;align-items:center;gap:10px}.brand img{width:36px;height:36px;border-radius:9px;display:block}.brand h1{font-size:1.15rem}
.meta{font-size:.82rem;color:var(--muted)}.meta .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--nt);margin-inline-end:6px;vertical-align:middle}.meta.stale{color:var(--warn)}.meta.stale .dot{background:var(--warn)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;min-width:0}
h2{font-size:.95rem;font-weight:700;margin-bottom:10px}
.s-ok{--s:var(--ok);--sb:var(--ok-bg)}.s-warn{--s:var(--warn);--sb:var(--warn-bg)}.s-bad{--s:var(--bad);--sb:var(--bad-bg)}.s-early,.s-nodata,.s-cal,.s-wait{--s:var(--nt);--sb:var(--nt-bg)}
.chip{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;font-size:.76rem;font-weight:600;color:var(--s);background:var(--sb);border-radius:999px;padding:2px 10px 2px 9px}.chip i{font-style:normal;font-weight:700}
.r1{display:grid;grid-template-columns:2fr 1fr;gap:14px}
.verdict{border-inline-start:5px solid var(--s)}.verdict .vh{display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap}.verdict .vh span.lbl{font-size:.8rem;color:var(--muted)}
.verdict .vs{font-size:1.3rem;font-weight:600;line-height:1.55}.verdict .vn{font-size:.8rem;color:var(--muted);margin-top:10px}
.att ol{margin:0;padding:0;list-style:none;display:grid;gap:8px}.att li{display:flex;gap:8px;align-items:flex-start;font-size:.9rem}.att li .chip{flex:none}.att .none{color:var(--muted);font-size:.88rem}
.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-top:14px}
.tile{border-inline-start:4px solid var(--s);display:flex;flex-direction:column;gap:4px}.tile .th{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}.tile h3{font-size:.9rem;font-weight:600;color:var(--muted)}
.tile .big{font-size:2.6rem;font-weight:700;line-height:1.15;font-variant-numeric:tabular-nums;margin:4px 0 2px}.tile .big small{font-size:.95rem;font-weight:500;color:var(--muted);margin-inline-start:6px}
.tile p{font-size:.86rem}.tile p.m{color:var(--muted)}.tile .foot{margin-top:auto;padding-top:8px;font-size:.74rem;color:var(--muted)}
.mini{display:inline-flex;align-items:center;gap:4px;font-size:.74rem;font-weight:600;color:var(--s)}
.up{color:var(--ok)}.down{color:var(--bad)}.flat{color:var(--muted)}
.r3{display:grid;grid-template-columns:1fr 2fr;gap:14px;margin-top:14px}
.ms{list-style:none;margin:0;padding:0;display:grid;gap:14px}.ms li{display:grid;gap:4px}.ms .k{font-size:.8rem;color:var(--muted)}.ms .v{font-size:.95rem;font-weight:600}
.bar{height:8px;background:var(--soft);border-radius:999px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent);border-radius:999px}
.trend svg{width:100%;height:auto;display:block}.trend .t-lbl{fill:var(--muted);font-size:12px}.trend .t-val{fill:var(--fg);font-size:13px;font-weight:600}.trend .t-bar{fill:var(--accent);opacity:.85}.trend .t-goal{stroke:var(--muted);stroke-width:1.5;stroke-dasharray:4 3}.trend .t-mark{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3}.trend .t-base{stroke:var(--line)}
.note{font-size:.78rem;color:var(--muted);margin-top:8px}
.drs{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px;align-items:start}
details.dr>summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:10px}details.dr>summary::-webkit-details-marker{display:none}
details.dr>summary b{font-size:.95rem}details.dr>summary span{font-size:.8rem;color:var(--muted);flex:1}details.dr>summary:after{content:"▾";color:var(--muted);transition:transform .2s}details.dr[open]>summary:after{transform:rotate(180deg)}
details.dr[open]>summary{margin-bottom:12px}.dr h4{font-size:.85rem;margin:14px 0 6px}.dr h4:first-of-type{margin-top:0}
table.t{width:100%;border-collapse:collapse;font-size:.86rem}.t th{font-weight:500;color:var(--muted);font-size:.74rem;text-align:right;padding:2px 6px 5px}.t td{text-align:right;padding:6px;border-top:1px solid var(--line);vertical-align:top}.t td.n,.t th.n{width:5.5rem;font-variant-numeric:tabular-nums;white-space:nowrap}.t td.w{word-break:break-word}.tg td.n,.tg th.n{width:auto}.tg td.w{min-width:8.5rem;word-break:normal}
.kv{list-style:none;margin:0;padding:0}.kv li{display:grid;grid-template-columns:1fr auto;gap:10px;padding:6px 0;border-top:1px solid var(--line);font-size:.86rem}.kv li:first-child{border-top:0}.kv b{font-variant-numeric:tabular-nums;text-align:right}.kv small{display:block;color:var(--muted);font-size:.74rem}
.fl li{grid-template-columns:auto 1fr}.fl .ft{font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}.fl .lv{color:var(--muted)}.fl .lv.alert{color:var(--bad)}.fl small{white-space:nowrap}
.spark{display:block;width:100%;height:auto}.spark rect{fill:var(--accent);opacity:.8}.axis{display:flex;justify-content:space-between;direction:ltr;font-size:.72rem;color:var(--muted);margin-top:2px}
.foot{font-size:.76rem;color:var(--muted);margin-top:16px}#er{color:var(--bad);margin-top:6px}
@media(max-width:1023px){.r1,.r3{grid-template-columns:1fr}.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.drs{grid-template-columns:1fr}}
@media(max-width:560px){main{padding:14px 12px 24px}.t td.n,.t th.n{width:3.4rem}.tiles{grid-template-columns:1fr}.verdict .vs{font-size:1.12rem}.tile .big{font-size:2.2rem}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
@media print{details.dr{display:none}body{background:#fff}}
</style></head><body><main>
<header class="top"><div class="brand"><img src="https://luchit.app/icon-192.png" alt="" width="36" height="36"><h1>לוחית · מצב העסק</h1></div><p class="meta" id="meta"><span class="dot"></span>טוען</p></header>

<section class="r1">
<div class="card verdict s-cal" id="vd"><div class="vh" id="vh"><span class="lbl">השורה התחתונה</span></div><p class="vs" id="vs">טוען את הנתונים</p><p class="vn" id="vn"></p></div>
<div class="card att"><h2>דורש תשומת לב</h2><ol id="att"><li class="none">טוען</li></ol></div>
</section>

<section class="tiles" id="tiles" aria-label="ארבעת המדדים הראשיים"></section>

<section class="r3">
<div class="card"><h2>אבני דרך</h2><ul class="ms" id="ms"></ul></div>
<div class="card trend"><h2>בדיקות רכב בשבוע, 8 שבועות</h2><div id="tr"></div><p class="note" id="trn"></p></div>
</section>

<section class="drs">
<details class="card dr" id="dr-now"><summary><b>עכשיו</b><span>מי פעיל ברגע זה ומה קרה היום</span></summary><ul class="kv" id="now"></ul><p class="note">נתוני היום חלקיים: גוגל אנליטיקס מעדכן אותם בעיכוב של שעה עד כמה שעות.</p></details>
<details class="card dr" id="dr-goal"><summary><b>יעדים לשנה</b><span>איפה אנחנו מול היעד, עד אוקטובר 2027</span></summary><div id="goal"></div></details>
<details class="card dr" id="dr-src"><summary><b>מקורות</b><span>מאיפה מגיעות בדיקות הרכב, השבוע מול השבוע הקודם</span></summary><div id="src"></div></details>
<details class="card dr" id="dr-use"><summary><b>שימוש</b><span>מה אנשים עושים, השבוע מול השבוע הקודם</span></summary><div id="use"></div></details>
<details class="card dr" id="dr-web"><summary><b>האתר</b><span>ביקורים לפי אתר מפנה, והדפים שהכי ראו</span></summary><div id="web"></div></details>
<details class="card dr" id="dr-seo"><summary><b>חיפוש בגוגל</b><span>חיפושים, דפים והופעות בתוצאות</span></summary><div id="seo"></div></details>
<details class="card dr" id="dr-fl"><summary><b>מבזקים</b><span>הודעות מהסוכנים, אותן הודעות שמגיעות לטלגרם</span></summary><ul class="kv fl" id="fl"></ul><p class="note">● התראה שדורשת תשומת לב. ○ מידע בלבד. אם יש התראה אני מטפל בשגרה, ופונה אליך רק כשנדרשת החלטה שלך.</p></details>
<details class="card dr" id="dr-tec"><summary><b>טכני</b><span>כשלים לפי סיבה, קריסות ומקורות שלא ענו</span></summary><div id="tec"></div></details>
</section>

<p class="foot">מקורות: גוגל אנליטיקס (אפליקציה ואתר), Cloudflare (ביקורים באתר), Search Console (חיפוש בגוגל) ודף האפליקציה ב-Google Play. לכל מספר מצוינים התאריכים שלו, כי לכל מקור יש איחור אחר. הדף מתרענן כל דקה. <span id="build"></span></p>
<p class="foot" id="er"></p>
</main>
<script>
/* Business dashboard. Spec: Claude Doc "לוחית: אפיון דשבורד מנהלים", sections 3 (targets) and 4 (traffic light). */
const CAL_END="2026-10-26";        // until the base week 19-25.10 is over, only health, Google pages and the store get a colour
// Yearly goals from the CMO plan (reports/marketing-goals-2026-10.json): per month [cons, base, opt], the weekly figure or level expected in the
// month's last week, Nov 2026 to Oct 2027. Colour vs base: at or above base ok, between cons and base warn, below cons bad (failures: lower is better).
// Between month ends the target moves in a straight line; "from" gives a starting point where one is known, otherwise the first month holds before it.
const GOALS={first:"2026-11",k:{weekly_checks:[[160,190,240],[190,240,330],[250,330,490],[270,380,600],[320,470,800],[360,550,990],[430,680,1310],[500,820,1670],[560,970,2080],[640,1150,2600],[690,1290,3050],[740,1430,3540]],installs_week:[[30,40,50],[35,50,70],[50,70,105],[50,75,120],[60,90,155],[65,100,185],[75,125,245],[85,145,300],[95,165,360],[105,190,435],[105,200,480],[105,210,525]],google_clicks_week:[[4,5,6],[7,9,13],[11,15,23],[15,22,36],[22,33,57],[29,45,83],[37,60,117],[47,80,165],[60,105,228],[74,135,308],[84,160,383],[95,190,475]],pages_indexed:[[100,120,150],[110,150,180],[120,165,200],[130,180,220],[140,195,240],[145,210,255],[150,220,265],[155,230,275],[160,240,285],[165,250,295],[170,260,300],[175,270,305]],share_per_100:[[2,3,4],[3,4,5],[3,4,6],[3,5,7],[4,6,8],[4,6,9],[4,7,9],[5,7,10],[5,8,11],[5,9,12],[6,9,13],[6,10,14]],app_active_28d:[[110,150,190],[150,200,280],[210,300,450],[240,350,550],[290,430,730],[330,510,900],[410,650,1200],[480,780,1510],[540,910,1860],[620,1080,2300],[670,1200,2650],[720,1320,3030]],failures_pct:[[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5]],subscribers_total:[[5,15,45],[10,30,90],[20,50,150],[30,70,210],[35,90,270],[50,120,360],[60,150,450],[80,200,600],[100,250,750],[120,300,900],[140,350,1050],[160,400,1200]]},
 from:{weekly_checks:["2026-10-25",170],google_clicks_week:["2026-10-14",0],pages_indexed:["2026-10-17",90],app_active_28d:["2026-10-18",23],subscribers_total:["2026-10-01",0]},
 calib:{key:"weekly_checks",end:"2026-10-25",model:170,lo:.5,hi:2}};   // weekly car checks scale by r = actual week 19-25.10 / 170 (0.5 to 2)
const SUBMITTED="2026-10-17";      // production access requested in Play Console
const PRO_MAU=2000;
const N={car_lookup:"בדיקת רכב",car_save:"שמירת רכב ברשימה",share:"שיתוף תוצאה",compare_open:"השוואת רכבים",tab_view:"מעבר בין לשוניות",link_out:"לחיצה על קישור חיצוני",alerts_toggle:"הדלקה או כיבוי של התראות",alert_kind:"בחירת סוג התראה",upgrade_open:"פתיחת חלונית המנוי (PRO)",voice_search:"חיפוש בקול",bulk_check:"בדיקת כמה רכבים יחד",camera_scan:"סריקת לוחית במצלמה",buy_card_open:"פתיחת כרטיס בלשונית קנייה",settlement_shown:"הצגת הסדר פשרה",checklist_pdf:"הורדת רשימת בדיקה",doc_add:"הוספת מסמך לרכב",simple_view:"מעבר לתצוגה פשוטה",search_no_result:"חיפוש דגם בלי תוצאה",user_screenshot:"צילום מסך",first_open:"התקנה חדשה",lookup_repeat:"פתיחה חוזרת של רכב (רענון)",notification_open:"פתיחת התראה",web_hint_click:"לחיצה על הצעה להתקין מהאתר",web_install_click:"מעבר מהאתר להתקנה",calendar_reminder_click:"הוספת תזכורת ליומן",link_landing:"כניסה לאתר מקישור",link_open:"פתיחת קישור באפליקציה"};
const BAD={lookup_failed:"בדיקה שנכשלה",lookup_slow:"בדיקה איטית",lookup_abort:"בדיקה שבוטלה",lookup_timeout:"בדיקה שפגה",app_exception:"קריסה"};
const KIND={source_down:"משרד התחבורה לא ענה",offline:"אין אינטרנט אצל המשתמש",not_found:"מספר שלא קיים (הוקלד לא נכון)","(not set)":"לא ידוע"};
const FK={data:"נתונים",infra:"תשתית",content:"תוכן",market:"שוק",release:"שחרור",experiment:"ניסוי",reviews:"ביקורות"};
const VIA={img:"תמונה",full:"תמונה מלאה",pdf:"PDF",txt:"טקסט",qr:"קוד QR"};
const ST={ok:["תקין","✓"],warn:["דורש תשומת לב","!"],bad:["מתחת ליעד","✕"],early:["מוקדם לשפוט","…"],nodata:["אין נתון","?"],cal:["שבוע כיול","·"],wait:["ממתין","…"]};

const $=i=>document.getElementById(i);
const n=x=>x==null||!isFinite(x)?"-":Math.round(x).toLocaleString("en-US");
const n1=x=>x==null||!isFinite(x)?"-":(Math.round(x*10)/10).toLocaleString("en-US");
const esc=t=>String(t==null?"":t).replace(/[<>&"]/g,"");
const dm=s=>{const p=String(s).slice(0,10).split("-");return Number(p[2])+"."+Number(p[1])};
const rng=w=>w?dm(w[0])+" עד "+dm(w[1]):"";
const addD=(d,k)=>new Date(Date.parse(d+"T12:00:00Z")+k*864e5).toISOString().slice(0,10);
const between=(a,b)=>Math.round((Date.parse(b+"T12:00:00Z")-Date.parse(a+"T12:00:00Z"))/864e5);
const chip=(s,w)=>'<span class="chip s-'+s+'"><i aria-hidden="true">'+ST[s][1]+'</i>'+(w||ST[s][0])+'</span>';
const mini=s=>'<span class="mini s-'+s+'"><i aria-hidden="true">'+ST[s][1]+'</i>'+ST[s][0]+'</span>';
const delta=(a,b,unit)=>{if(a==null||b==null)return "";const d=Math.round(a-b);return d>0?'<span class="up">▲ '+n(d)+'</span> יותר מהשבוע הקודם'+(unit||""):d<0?'<span class="down">▼ '+n(-d)+'</span> פחות מהשבוע הקודם'+(unit||""):'<span class="flat">כמו בשבוע הקודם</span>'};
const pois=(a,lam)=>{let t=Math.exp(-lam),s=t;for(let k=1;k<=a;k++){t*=lam/k;s+=t}return s};   // chance of seeing a or fewer when lam is expected
// one rulebook (spec section 4): at or above pace = ok, 80% (or 70%) and up = warn, below = bad, but with small numbers only when it cannot be bad luck
function judge(a,exp,minExp,warnAt){if(exp==null)return "early";if(exp<minExp)return "early";const r=a/exp;if(r>=1)return "ok";if(r>=warnAt)return "warn";if(exp<20&&pois(a,exp)>=.05)return "warn";return "bad"}
const mEnd=m=>addD((Number(m.slice(5))===12?(Number(m.slice(0,4))+1)+"-01":m.slice(0,5)+String(Number(m.slice(5))+1).padStart(2,"0"))+"-01",-1);
const MONTHS=GOALS.k.weekly_checks.map((x,i)=>{const y=2026+Math.floor((10+i)/12),mo=(10+i)%12+1;return y+"-"+String(mo).padStart(2,"0")});
// [cons, base, opt] on a given day, or null without goals
function goal(key,day,r){const k=GOALS.k[key];if(!k||!day)return null;const pts=MONTHS.map((m,i)=>[mEnd(m),k[i]]),f=GOALS.from[key];if(f)pts.unshift([f[0],[f[1],f[1],f[1]]]);
 let v=pts[0][1];if(day>=pts[pts.length-1][0])v=pts[pts.length-1][1];else for(let i=0;i+1<pts.length;i++)if(day>=pts[i][0]&&day<pts[i+1][0]){const t=between(pts[i][0],day)/between(pts[i][0],pts[i+1][0]);v=pts[i][1].map((a,j)=>a+(pts[i+1][1][j]-a)*t);break}
 return v.map(x=>x*(r||1))}
// at or above base ok, cons to base warn, below cons bad; small counts only bad when it cannot be bad luck; lower=true flips it (failures)
function band(a,g,lower,small){if(a==null)return "nodata";if(!g)return "early";const c=g[0],b=g[1];if(lower)return a<=b?"ok":a<=c?"warn":"bad";if(a>=b)return "ok";if(a>=c)return "warn";if(small&&c<20&&pois(a,c)>=.05)return "warn";return "bad"}
const gtxt=g=>g?"היעד "+n1(g[1])+" (טווח "+n1(g[0])+" עד "+n1(g[2])+")":"";
const RANK={bad:0,nodata:1,warn:2};
// production release states in Play Console: [what it means, status]
const RS={draft:["טיוטה בקונסול","wait"],not_sent_for_review:["מוכנה, עוד לא נשלחה לבדיקה","wait"],in_review:["בבדיקה של גוגל","wait"],approved_not_published:["אושרה, מחכה שתפרסם","wait"],not_approved:["נדחתה בבדיקה","bad"],published:["פורסמה","ok"]};
const hm=ts=>{if(!ts)return "";const o={timeZone:"Asia/Jerusalem"},t=new Date(ts),day=t.toLocaleDateString("en-CA",o);return (day!==new Date().toLocaleDateString("en-CA",o)?dm(day)+" ":"")+t.toLocaleTimeString("he-IL",{...o,hour:"2-digit",minute:"2-digit"})};

function render(d){
const W=d.weekly||null,ev=W&&W.ev,E0=ev?ev[0]:{},E1=ev?ev[1]:{},E2=ev?ev[2]:{},ge=(o,k,i)=>o&&o[k]?o[k][i||0]:0;
const end=W?W.end:null,cal=!end||end<CAL_END,days=W&&W.days;
const week=e=>{if(!days)return null;let s=0;for(let i=0;i<7;i++)s+=days[addD(e,-i)]||0;return s};
const CB=GOALS.calib,cw=days&&end>=CB.end?week(CB.end):null,RC=cw?Math.min(CB.hi,Math.max(CB.lo,cw/CB.model)):1;   // calibration of weekly car checks
const nsGoal=e=>!days||e<CAL_END?null:goal("weekly_checks",e,RC),nsTarget=e=>{const g=nsGoal(e);return g?g[1]:null};
const M={},att=[];
const push=(key,s,prio,ratio,text,short,w)=>{M[key]=s;if(RANK[s]!=null)att.push({s,prio,ratio,text,short,w})};

// 1. weekly car checks (north star)
let t1;{const L=ev?ge(E0,"car_lookup"):null,Lp=ev?ge(E1,"car_lookup"):null,G=end?nsGoal(end):null,tg=G?G[1]:null;let s;
if(!ev)s="nodata";else if(cal)s="cal";else{s=band(L,G,false,true);if(s==="ok"&&Lp>=30&&L<.8*Lp)s="warn"}
push("ns",s,1,tg?L/tg:1,"בדיקות רכב: "+n(L)+(tg?", היעד "+n(tg):""),s==="nodata"?"חסר נתון מגוגל אנליטיקס":"הבדיקות מתחת ליעד");
const l1=!ev?"גוגל אנליטיקס לא ענה":tg?n(L/tg*100)+"% מהיעד ("+n(tg)+", טווח "+n(G[0])+" עד "+n(G[2])+")":"שבוע הבסיס: 19.10 עד 25.10. היעד מתחיל אחריו";
t1={s,title:"בדיקות רכב בשבוע",big:n(L),lines:[l1,delta(L,Lp)],foot:rng(W&&W.W)+" · אפליקציה ואתר",L,Lp,tg}}

// 2. Google clicks, with pages Google knows under it
let t2;{const S=d.seo,c=S&&S.cur,a=c?Math.round(c.clicks):null,sd=S&&S.range?S.range[1]:null,GC=goal("google_clicks_week",sd),exp=GC?GC[1]:null;let s;
if(!c)s="nodata";else if(cal)s="cal";else if(exp<2)s="early";else s=band(a,GC,false,true);
push("clicks",s,2,exp?a/exp:1,"כניסות מגוגל: "+n(a)+(exp!=null?", היעד "+n1(exp):""),s==="nodata"?"חסר נתון מ-Search Console":"הכניסות מגוגל מתחת ליעד");
// pages
const X=d.metrics&&d.metrics.index,today=new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Jerusalem"}),GP2=goal("pages_indexed",today),pexp=GP2[1];let ps;
if(!X||X.indexed==null||Date.now()-Date.parse(X.at)>48*3600e3)ps="nodata";else ps=band(X.indexed,GP2,false,false);
push("pages",ps,3,X&&pexp?X.indexed/pexp:1,"דפים שגוגל מכיר: "+(X?n(X.indexed):"-")+", היעד "+n(pexp),ps==="nodata"?"חסר נתון על הדפים בגוגל":"גוגל מכיר פחות דפים מהיעד");
const imps=c?Math.round(c.imps):null,ip=S&&S.prev?Math.round(S.prev.imps):null;
t2={s,title:"כניסות מגוגל בשבוע",big:n(a),lines:[c?(GC?gtxt(GC):""):"Search Console לא ענה","הופענו בתוצאות "+n(imps)+" פעמים"+(ip!=null?" (שבוע קודם "+n(ip)+")":""),
 'דפים שגוגל מכיר: <b>'+(X?n(X.indexed)+" מתוך "+n(X.inspected||X.total):"-")+"</b> "+mini(ps)],foot:(S&&S.range?rng(S.range):"")+" · גוגל מוסר באיחור של 3 ימים"}}

// 3. arrived from a share
let t3;{const GS=goal("share_per_100",end||new Date().toISOString().slice(0,10)),Lw=ge(E0,"car_lookup"),Sw=ge(E0,"share"),Lm=ge(E2,"car_lookup"),Sm=ge(E2,"share"),sh=W&&W.shared;let rate=null,win="",s;
if(!ev)s="nodata";else{if(Lw>=100){rate=Sw/Lw*100;win=rng(W.W)}else if(Lm>=100){rate=Sm/Lm*100;win=rng(W.M)+" (28 ימים, עד שיש 100 בדיקות בשבוע)"}
 if(rate==null)s="early";else if(cal)s="cal";else s=band(rate,GS,false,false)}
push("share",s,4,rate!=null?rate/GS[1]:1,"שיתופים: "+n1(rate)+" לכל 100 בדיקות, היעד "+n1(GS[1]),s==="nodata"?"חסר נתון על שיתופים":"מעט שיתופים");
const arr=sh?sh[0].web+sh[0].app:null,arrp=sh?sh[1].web+sh[1].app:null;
t3={s,title:"הגיעו משיתוף",big:rate!=null?n1(rate):n(Sw),unit:rate!=null?"לכל 100 בדיקות":"שיתופים",lines:[rate!=null?gtxt(GS)+" לכל 100 בדיקות":"עוד מעט מדי בדיקות כדי לחשב: "+n(Sw)+" שיתופים מתוך "+n(Lw)+" בדיקות","נכנסו מקישור ששותף: <b>"+n(arr)+"</b>"+(arrp!=null?" (שבוע קודם "+n(arrp)+")":"")],foot:(win||rng(W&&W.W))+" · אפליקציה ואתר"}}

// Google Play: the public store page says whether anyone can install; Play Console, when connected, says where the production release stands
const RL=d.release&&d.release.ok?d.release:null,top=RL&&RL.list&&RL.list[0]||null;
// Google Play statistics reports, when connected: exact installs from the store, a few days late
const PS=d.stats&&d.stats.ok&&d.stats.cur?d.stats:null;
const RU={draft:"עדכון בטיוטה",not_sent_for_review:"עדכון שעוד לא נשלח לבדיקה",in_review:"עדכון בבדיקה",approved_not_published:"עדכון שאושר ומחכה שתפרסם",not_approved:"עדכון שנדחה בבדיקה"};
const GP=d.play==="live"?{s:top&&top.state==="not_approved"?"bad":"ok",txt:"באוויר בחנות"+(top&&RU[top.state]?" · "+RU[top.state]:"")}:top?{s:(RS[top.state]||[0,"wait"])[1],txt:(RS[top.state]||[top.state?"מצב "+esc(top.state):"מצב לא ידוע"])[0]}:RL?{s:"wait",txt:"עוד אין גרסת ייצור"}:d.play==="review"?{s:"wait",txt:"עדיין לא פתוח לכולם"}:{s:"wait",txt:"לא הצלחתי לבדוק את דף החנות"};
// 4. new app installs, with the store status: Google Play's own count when its reports are connected, else first opens in Analytics
let t4;{const A=W&&W.app,ga=A?A[0].newUsers:null,a=PS?PS.cur.users:ga,ap=PS?PS.prev.users:A?A[1].newUsers:null,ab=PS?0:A?A[0].abroadNew:0,wEnd=PS?PS.last:end,live=d.play==="live",GI=goal("installs_week",wEnd),tg=live&&GI&&wEnd>=CAL_END?GI[1]:null;let s;
if(a==null)s="nodata";else if(!tg)s="early";else s=band(a,GI,false,true);
push("installs",s,5,tg?a/tg:1,"התקנות חדשות: "+n(a)+(tg?", היעד "+n(tg):""),s==="nodata"?"חסר נתון על התקנות":"מעט התקנות");
push("store",GP.s,0,0,"Google Play: גרסת הייצור נדחתה בבדיקה. הסיבה במייל ובקונסול","גרסת הייצור נדחתה בבדיקה של גוגל","נדחתה");
t4={s,title:"התקנות חדשות",big:n(a),lines:["Google Play: "+GP.txt+(GP.s==="ok"&&GP.txt.indexOf("·")<0?" ✓":"")+(!live&&!top&&d.play==="review"?" (הבקשה הוגשה "+dm(SUBMITTED)+")":""),tg?n(a/tg*100)+"% מהיעד ("+n(tg)+", טווח "+n(GI[0])+" עד "+n(GI[2])+")":live?"היעד נבדק מהשבוע שאחרי שבוע הבסיס":"עד שהאפליקציה בחנות, מתקינים רק בודקים",delta(a,ap),PS?(ga!=null?"פתיחות ראשונות לפי גוגל אנליטיקס: "+n(ga):""):ab?"לא נספרו "+n(ab)+" מכשירים מחוץ לישראל (בדיקות אוטומטיות של גוגל)":""],foot:PS?rng(PS.W)+" · לפי Google Play, בישראל":rng(W&&W.W)+" · פתיחה ראשונה במכשיר בישראל, לפי גוגל אנליטיקס"}}

// health: failures caused by us or the ministry, out of all attempts (a mistyped plate is not a failure)
let H;{const fk=W&&W.fails?W.fails[0]:null,tech=fk?(fk.source_down||0)+(fk.offline||0):null,att2=ev?ge(E0,"car_lookup")+ge(E0,"lookup_failed"):null;let s,r=null;
const GF=goal("failures_pct",end||new Date().toISOString().slice(0,10));
if(!fk||!ev)s="nodata";else if(att2<50)s="early";else{r=tech/att2*100;s=band(r,GF,true);if(s==="bad"&&tech<5)s="warn"}
push("health",s,0,r!=null?GF[1]/Math.max(r,.01):1,"בדיקות שנכשלו: "+n1(r)+"%, היעד עד "+n1(GF[1])+"%","");
H={s,r,tech,att:att2}}

// verdict
att.sort((x,y)=>RANK[x.s]-RANK[y.s]||x.ratio-y.ratio||x.prio-y.prio);
const judged=["health","pages","store"].concat(cal?[]:["ns","clicks","share","installs"]).map(k=>M[k]);
const vs=judged.includes("bad")?"bad":judged.includes("nodata")?"nodata":judged.includes("warn")?"warn":judged.includes("ok")?"ok":cal?"cal":"early";
const head=t1.L==null?"אין עדיין נתון על בדיקות רכב השבוע.":t1.tg?"השבוע: "+n(t1.L)+" בדיקות רכב, "+n(t1.L/t1.tg*100)+"% מהיעד.":"השבוע: "+n(t1.L)+" בדיקות רכב"+(t1.Lp!=null?", "+(t1.L>t1.Lp?n(t1.L-t1.Lp)+" יותר מהשבוע הקודם":t1.L<t1.Lp?n(t1.Lp-t1.L)+" פחות מהשבוע הקודם":"כמו בשבוע הקודם"):"")+".";
const first=att.find(x=>x.short);const mid=first?first.short+".":H.s==="ok"?"אין מה לטפל בו.":"";
const tail=H.s==="ok"?"השירות תקין.":H.s==="warn"?n1(H.r)+"% מהבדיקות נכשלו, מעט מעל הרגיל.":H.s==="bad"?n1(H.r)+"% מהבדיקות נכשלו.":H.s==="early"?"מעט מדי בדיקות כדי לשפוט את תקינות השירות.":"אין נתון על תקינות השירות.";
$("vd").className="card verdict s-"+vs;$("vh").innerHTML=chip(vs,att[0]&&att[0].s===vs?att[0].w:"")+'<span class="lbl">השורה התחתונה</span>';$("vs").textContent=[head,mid,tail].filter(Boolean).join(" ");
$("vn").textContent=cal?"שבוע כיול עד "+dm(addD(CAL_END,-1))+": המספרים מוצגים בלי צבע, חוץ מתקינות השירות, הדפים שגוגל מכיר וסטטוס החנות. בדיקות מהאתר נספרות רק מ-15.10.":"";

// attention list
const alerts=(d.flashes||[]).filter(f=>f.l==="alert"&&Date.now()-Date.parse(f.t)<864e5).length;
$("att").innerHTML=(att.length?att.slice(0,4).map(x=>"<li>"+chip(x.s,x.w)+"<span>"+esc(x.text)+"</span></li>").join(""):'<li class="none">אין כרגע דבר שדורש תשומת לב.</li>')+(alerts?'<li><span class="chip s-warn"><i aria-hidden="true">!</i>מבזקים</span><span>'+alerts+' התראות מהסוכנים ב-24 השעות האחרונות. <a href="#dr-fl" data-open="dr-fl">לפירוט</a></span></li>':"");

// tiles
const tile=t=>'<article class="card tile s-'+t.s+'"><div class="th"><h3>'+t.title+"</h3>"+chip(t.s)+'</div><div class="big">'+t.big+(t.unit?"<small>"+t.unit+"</small>":"")+"</div>"+t.lines.filter(Boolean).map((l,i)=>'<p class="'+(i?"m":"")+'">'+l+"</p>").join("")+'<p class="foot">'+t.foot+"</p></article>";
$("tiles").innerHTML=[t1,t2,t3,t4].map(tile).join("");

// milestones
{const A=W&&W.app,mau=A?A[2].activeUsers:null,mab=A?A[2].abroadActive:0,mo=W&&W.money,pt=hm(d.playAt),td=new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Jerusalem"}),GA=goal("app_active_28d",td),GN=goal("subscribers_total",td);
$("ms").innerHTML='<li><span class="k">Google Play</span><span class="v">'+(GP.s==="ok"?mini("ok")+" ":"")+GP.txt+'</span><span class="k">'+[top?"גרסת הייצור"+(top.name?" "+esc(top.name):"")+", לפי Play Console"+(RL.at?", נבדק ב-"+hm(RL.at):"")+".":RL&&d.play!=="live"?"אחרי אישור הבקשה צריך ליצור גרסת ייצור, ואז יופיע כאן אם היא בבדיקה, אושרה או נדחתה.":"",d.play!=="live"&&!(top||RL)?"הבקשה הוגשה ב-"+dm(SUBMITTED)+". אישור Google מגיע במייל ובקונסול; כאן הסטטוס מתחלף כשהאפליקציה מופיעה בחנות לכולם.":"",d.play==="live"||!(top||RL)?(pt?"דף החנות הציבורי נבדק ב-"+pt+".":"דף החנות הציבורי נבדק כל שעה."):""].filter(Boolean).join(" ")+"</span></li>"
+'<li><span class="k">הדרך ל-PRO: מכשירים פעילים באפליקציה ב-28 ימים, בישראל</span><span class="v">'+n(mau)+" מתוך "+n(PRO_MAU)+'</span><div class="bar" role="img" aria-label="'+n(mau)+" מתוך "+n(PRO_MAU)+'"><i style="width:'+Math.max(1,Math.min(100,(mau||0)/PRO_MAU*100))+'%"></i></div><span class="k">'+(mau!=null&&!cal?mini(band(mau,GA,false,true))+" ":"")+"יעד להיום: "+n(GA[1])+" (טווח "+n(GA[0])+" עד "+n(GA[2])+"). "+'מפעילים מנוי בתשלום רק מ-2,000 עד 3,000 משתמשים בחודש'+(mab?". לא נספרו "+n(mab)+" מכשירים מחוץ לישראל, כנראה מכשירי הבדיקה האוטומטית של גוגל":"")+"</span></li>"
+'<li><span class="k">כסף ועניין (מ-1.10)</span><span class="v">'+(mo?n(mo.leads)+" פניות עסקיות · "+n(mo.subscribers)+" נרשמים למגזין":"אין נתון")+'</span><span class="k">'+(mo&&!cal?mini(band(mo.subscribers,GN,false,true))+" ":"")+"יעד נרשמים להיום: "+n(GN[1])+" (טווח "+n(GN[0])+" עד "+n(GN[2])+"). לפניות עסקיות אין יעד עד שמתחילים למכור."+'</span></li>'}

// trend: 8 weekly totals, oldest on the left so the latest week sits next to the right edge
{const box=$("tr");if(!days||!end){box.innerHTML='<p class="note">אין עדיין נתון היסטורי מגוגל אנליטיקס.</p>';$("trn").textContent=""}else{
const ends=[];for(let i=7;i>=0;i--)ends.push(addD(end,-7*i));const vals=ends.map(week),tgs=ends.map(nsTarget),mx=Math.max(1,...vals,...tgs.filter(Boolean))*1.18;
const X0=24,SW=74,H=150,Y=v=>H-v/mx*(H-28);let g='<line class="t-base" x1="12" x2="628" y1="'+H+'" y2="'+H+'"/>';
ends.forEach((e,i)=>{const x=X0+i*SW,v=vals[i],y=Y(v);g+='<rect class="t-bar" x="'+(x+12)+'" y="'+y+'" width="46" height="'+(H-y)+'" rx="4"/><text class="t-val" x="'+(x+35)+'" y="'+(y-6)+'" text-anchor="middle">'+n(v)+'</text><text class="t-lbl" x="'+(x+35)+'" y="'+(H+18)+'" text-anchor="middle">עד '+dm(e)+"</text>";
 if(tgs[i])g+='<line class="t-goal" x1="'+(x+6)+'" x2="'+(x+64)+'" y1="'+Y(tgs[i])+'" y2="'+Y(tgs[i])+'"/>';
 if(addD(e,-6)<="2026-10-15"&&e>="2026-10-15")g+='<line class="t-mark" x1="'+(x+4)+'" x2="'+(x+4)+'" y1="16" y2="'+H+'"/><text class="t-lbl" x="'+(i>=3?x:x+8)+'" y="12" text-anchor="'+(i>=3?"end":"start")+'">מכאן נספר גם האתר</text>'});
box.innerHTML='<svg viewBox="0 0 640 176" direction="ltr" style="direction:ltr" role="img" aria-label="בדיקות רכב בשבוע: '+vals.map(n).join(", ")+'">'+g+"</svg>";
$("trn").textContent="כל עמודה היא 7 ימים. הקו המקווקו הוא היעד השבועי מתוכנית היעדים לשנה, מותאם לשבוע הבסיס (19.10 עד 25.10), והוא מופיע מהשבוע שאחריו."}}

// drawer: now
{const rt=d.events||[],g=k=>(rt.find(e=>e[0]===k)||[0,0])[1],bad=Object.keys(BAD).reduce((a,k)=>a+g(k),0),dl=d.daily||{},Ed=dl.events||{},T=Ed.today||{},Y=Ed.yesterday||{};
const li=(l,v,s)=>"<li><span>"+l+(s?"<small>"+s+"</small>":"")+"</span><b>"+v+"</b></li>";
$("now").innerHTML=li("באפליקציה, 30 הדקות האחרונות",n(d.activeUsers),"מכשירים פעילים בישראל")+li("באתר, 30 הדקות האחרונות",n(d.webUsers),"כניסות לדף: כל פתיחה נספרת בנפרד, כי האתר לא שומר עוגיות")+li("נכנסו לאתר מקישור, 30 הדקות האחרונות",d.events?n(g("link_landing")):"-","קישור go/ או דוח רכב ששותף")+li("בדיקות רכב, 30 הדקות האחרונות",d.events?n(g("car_lookup")):"-","באפליקציה ובאתר יחד")+li("בעיות, 30 הדקות האחרונות",d.events?n(bad):"-",bad?rt.filter(e=>BAD[e[0]]).map(e=>BAD[e[0]]+" "+e[1]).join(", "):"")
+li("בדיקות רכב היום עד עכשיו",n(T.car_lookup?T.car_lookup[0]:0),"אתמול, יום שלם: "+n(Y.car_lookup?Y.car_lookup[0]:0))+li("ביקורים באתר היום",n(d.visitsToday),"אתמול, יום שלם: "+n(d.visitsYesterday))}

// drawer: the yearly goals, now against the target of the day, and the month-end targets ahead
{const td=new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Jerusalem"}),Ad=W&&W.app,mo=W&&W.money,X2=d.metrics&&d.metrics.index,S2=d.seo&&d.seo.cur,PS2=d.stats&&d.stats.ok&&d.stats.cur?d.stats:null;
const R=[["weekly_checks","בדיקות רכב בשבוע",t1.L,end,RC],["installs_week","התקנות בשבוע",PS2?PS2.cur.users:Ad?Ad[0].newUsers:null,PS2?PS2.last:end],["google_clicks_week","כניסות מגוגל בשבוע",S2?Math.round(S2.clicks):null,d.seo&&d.seo.range?d.seo.range[1]:td],
 ["pages_indexed","דפים שגוגל מכיר",X2?X2.indexed:null,td],["share_per_100","שיתופים לכל 100 בדיקות",t3.big!=null&&t3.unit==="לכל 100 בדיקות"?Number(t3.big):null,end],["app_active_28d","מכשירים פעילים באפליקציה, 28 ימים",Ad?Ad[2].activeUsers:null,td],
 ["failures_pct","בדיקות שנכשלו (%)",H.r,end,1,true],["subscribers_total","נרשמים למגזין",mo?mo.subscribers:null,td]];
const nx=[0,2,5,11].map(i=>MONTHS[i]),ml=m=>Number(m.slice(5))+"."+m.slice(2,4);
$("goal").innerHTML='<div style="overflow-x:auto"><table class="t tg"><thead><tr><th>מדד</th><th class="n">עכשיו</th><th class="n">יעד להיום</th>'+nx.map(m=>'<th class="n">סוף '+ml(m)+"</th>").join("")+"</tr></thead><tbody>"
+R.map(([k,l,v,day,r,lower])=>{const g=goal(k,day||td,k==="weekly_checks"?r:1),st=cal&&(k==="weekly_checks"||k==="installs_week")?"cal":band(v,g,lower,!lower),gf=x=>x!=null&&x>=10?n(Math.round(x)):n1(x);return '<tr><td class="w">'+l+'</td><td class="n">'+(k==="failures_pct"||k==="share_per_100"?n1(v):n(v))+" "+mini(st)+'</td><td class="n">'+gf(g&&g[1])+'</td>'+nx.map(m=>'<td class="n">'+gf(goal(k,mEnd(m),k==="weekly_checks"?r:1)[1])+"</td>").join("")+"</tr>"}).join("")+"</tbody></table></div>"
+'<p class="note">היעדים מתוכנית השיווק (תרחיש בסיס, צמיחה אורגנית בלבד). ירוק: ביעד או מעליו. צהוב: בין התרחיש השמרני ליעד. אדום: מתחת לתרחיש השמרני. יעדי בדיקות הרכב מכוילים לפי שבוע הבסיס 19.10 עד 25.10'+(Math.abs(RC-1)>=.005?" (מקדם "+(Math.round(RC*100)/100)+")":"")+'. בין סופי החודשים היעד עולה בקו ישר. בכשלים, נמוך יותר טוב.</p>'}

// drawer: sources, the plan's North Star (car checks a week) split by where the visit came from
{const B=W&&W.bySource,box=$("src");if(!B){box.innerHTML='<p class="note">'+(W?"גוגל אנליטיקס לא ענה על המקורות.":"אין נתונים")+"</p>"}else{
const SL={google:"חיפוש בגוגל",search:"מנועי חיפוש אחרים",direct:"ישיר (בלי מקור)",site:"מדף אחר באתר (דגמים, מגזין)",unknown:"האתר, לפני שנמדד המקור",app:"בתוך האפליקציה",share:"שיתוף דוח מהאפליקציה",tiktok:"טיקטוק",instagram:"אינסטגרם",facebook:"פייסבוק",linkedin:"לינקדאין",youtube:"יוטיוב",whatsapp:"וואטסאפ",newsletter:"ניוזלטר",press:"כתבות",dealer:"סוחרים",qr:"QR ודפוס",other:"אתרים אחרים"};
const c=B[0],p=B[1],ks=[...new Set([...Object.keys(c),...Object.keys(p)])].sort((a,b)=>((c[b]||[0,0])[1]-(c[a]||[0,0])[1])||((c[b]||[0,0])[0]-(c[a]||[0,0])[0])),tc=ks.reduce((a,k)=>a+(c[k]||[0,0])[1],0),tp=ks.reduce((a,k)=>a+(p[k]||[0,0])[1],0),tv=ks.reduce((a,k)=>a+(c[k]||[0,0])[0],0);
const dl=(x,y)=>{const v=x-y;return v>0?'<small class="up"><bdi dir="ltr">+'+n(v)+"</bdi></small>":v<0?'<small class="down"><bdi dir="ltr">'+n(v)+"</bdi></small>":""};
box.innerHTML="<h4>בדיקות רכב לפי מקור ("+rng(W.W)+")</h4>"+(ks.length?'<div style="overflow-x:auto"><table class="t tg"><thead><tr><th>מקור</th><th class="n">כניסות</th><th class="n">בדיקות רכב</th><th class="n">חלק מהבדיקות</th><th class="n">שבוע קודם</th></tr></thead><tbody>'
+ks.map(k=>{const a=c[k]||[0,0],b=p[k]||[0,0];return '<tr><td class="w">'+esc(SL[k]||k)+'</td><td class="n">'+n(a[0])+'</td><td class="n">'+n(a[1])+" "+dl(a[1],b[1])+'</td><td class="n">'+(tc?Math.round(a[1]*100/tc)+"%":"-")+'</td><td class="n">'+n(b[1])+"</td></tr>"}).join("")
+'<tr><td class="w"><b>סך הכול</b></td><td class="n"><b>'+n(tv)+'</b></td><td class="n"><b>'+n(tc)+"</b> "+dl(tc,tp)+'</td><td class="n"></td><td class="n">'+n(tp)+"</td></tr></tbody></table></div>":'<p class="note" style="margin:0">אין עדיין נתונים לשבוע הזה.</p>')
+'<p class="note">כניסות: באתר כל פתיחה של הדף, ובאפליקציה פתיחות. המקור הוא של הכניסה שבה נעשתה הבדיקה. קישורי <bdi dir="ltr">luchit.app/go/</bdi> נספרים תחת המקור שלהם; קישור בלי תיוג (למשל מוואטסאפ או מאפליקציה אחרת) נספר לרוב כ"ישיר". באפליקציה עצמה אין מקור לכל פתיחה, ולכן היא שורה אחת. האתר מוסר את המקור מ-19.10.2026; מה שנספר לפני כן מופיע כ"לפני שנמדד המקור". גוגל אנליטיקס מסיימת לספור אחרי כיום, ולכן השבוע נגמר אתמול.</p>'}}

// drawer: usage, this week against last week
{const box=$("use");if(!ev){box.innerHTML='<p class="note">אין נתון מגוגל אנליטיקס.</p>'}else{
const rows=Object.keys(N).filter(k=>ge(E0,k)||ge(E1,k)).sort((a,b)=>ge(E0,b)-ge(E0,a)).slice(0,14);
const SV=W.savers,Lu=SV?SV.car_lookup||0:ge(E0,"car_lookup",1),Su=SV?SV.car_save||0:ge(E0,"car_save",1);
box.innerHTML='<h4>שמירת רכב</h4><p class="note" style="margin:0 0 6px">'+(Lu>=50?n1(Su/Lu*100)+"% "+(SV?"מהמכשירים באפליקציה שבדקו רכב שמרו אותו":"ממי שבדק רכב שמר אותו")+" ברשימה (היעד 15%).":"מעט מדי "+(SV?"מכשירים באפליקציה":"אנשים")+" בדקו רכב השבוע כדי לחשב אחוז: "+n(Su)+" שמרו מתוך "+n(Lu)+".")+"</p>"
+'<h4>פעולות ('+rng(W.W)+")</h4>"+'<table class="t"><thead><tr><th>פעולה</th><th class="n">השבוע</th><th class="n">שבוע קודם</th></tr></thead><tbody>'+rows.map(k=>'<tr><td class="w">'+N[k]+'</td><td class="n">'+n(ge(E0,k))+'</td><td class="n">'+n(ge(E1,k))+"</td></tr>").join("")+"</tbody></table>"
+(PS?'<h4>התקנות לפי Google Play ('+rng(PS.W)+")</h4>"+'<ul class="kv">'+[["משתמשים חדשים בישראל",PS.cur.users,PS.prev.users],["הסירו את האפליקציה",PS.cur.uninstalls,PS.prev.uninstalls],["כל ההתקנות, כולל התקנה מחדש",PS.cur.events,PS.prev.events],PS.store?["ביקרו בדף האפליקציה בחנות",PS.cur.visitors,PS.prev.visitors]:null,PS.store?["התקינו מתוך דף החנות",PS.cur.acquisitions,PS.prev.acquisitions]:null,PS.cur.abroad?["משתמשים חדשים מחוץ לישראל או בלי מדינה, לא נספרו",PS.cur.abroad,null]:null,PS.total?["משתמשים בישראל שהתקינו אי פעם",PS.total,null]:null].filter(Boolean).map(r=>"<li><span>"+r[0]+(r[2]!=null?" (שבוע קודם "+n(r[2])+")":"")+"</span><b>"+n(r[1])+"</b></li>").join("")+'</ul><p class="note" style="margin:0 0 6px">זה המספר שמוצג בכרטיס ההתקנות. Google Play סופר כל משתמש חדש פעם אחת, גם אם התקין בכמה מכשירים או מחק והתקין שוב, וסופר גם מי שהתקין ועוד לא פתח. גוגל מוסרת את הנתונים באיחור של כמה ימים, ולכן התקופה כאן מוקדמת מהשבוע של שאר המסך.</p>':"")+(W.app?'<h4>מכשירים באפליקציה, לפי גוגל אנליטיקס</h4><ul class="kv">'+[["פתחו את האפליקציה לראשונה בישראל, השבוע",W.app[0].newUsers],["מכשירים פעילים בישראל, 28 ימים",W.app[2].activeUsers],["מכשירים מחוץ לישראל שלא נספרו, 28 ימים",W.app[2].abroadActive]].map(r=>"<li><span>"+r[0]+"</span><b>"+n(r[1])+"</b></li>").join("")+'</ul><p class="note" style="margin:0 0 6px">כל מכשיר שפתח את האפליקציה נספר פעם אחת. מי שהתקין ועוד לא פתח לא נספר כאן. עדכון גרסה לא נספר כהתקנה, אבל התקנה מחדש או מחיקת נתוני האפליקציה נספרות כמכשיר חדש. גוגל מתקינה כל גרסה שמועלית לחנות על מכשירי בדיקה בחו"ל, ולכן מכשירים מחוץ לישראל לא נספרים במסך.</p>':"")
+(W.shared?'<h4>שיתופים שהביאו אנשים, לפי סוג</h4><p class="note" style="margin:0">'+(Object.entries(W.shared[0].by).map(e=>(VIA[e[0]]||esc(e[0]))+": "+n(e[1])).join(" · ")||"עדיין אין כניסות מקישור ששותף.")+"</p>":"")}}

// drawer: the site
{const SRC=h=>!h?"כניסה ישירה":/google\\./.test(h)?"גוגל":/bing\\.|duckduckgo|yahoo|ecosia/.test(h)?"מנועי חיפוש אחרים":/whatsapp|wa\\.me/.test(h)?"וואטסאפ":/facebook|instagram|t\\.co|twitter|x\\.com|linkedin|telegram|t\\.me|tiktok|youtube/.test(h)?"רשתות חברתיות":/luchit\\.app/.test(h)?"מתוך האתר":h;
const agg=(arr,f)=>{const m={};(arr||[]).forEach(r=>{const k=f(r[0]);m[k]=(m[k]||0)+r[1]});return Object.entries(m).sort((a,b)=>b[1]-a[1])};
const S7=W&&W.sources,tot=S7?S7.reduce((a,r)=>a+r[1],0):null,kv=(a,ltr)=>a&&a.length?'<ul class="kv">'+a.map(r=>"<li><span>"+(ltr?'<bdi dir="ltr">'+esc(r[0])+"</bdi>":esc(r[0]))+"</span><b>"+n(r[1])+"</b></li>").join("")+"</ul>":'<p class="note" style="margin:0">אין נתונים</p>';
$("web").innerHTML='<h4>ביקורים ב-7 ימים ('+rng(W&&W.CW)+"): "+n(tot)+"</h4>"+kv(S7?agg(S7,SRC):null)+(W&&W.CW&&W.CW[0]<"2026-10-18"?'<p class="note">מ-18.10 נספרים גם דפי הדגמים, המגזין ושאר דפי האתר, ולכן עד 24.10 המספר כאן חלקי.</p>':"")
+"<h4>הדפים שהכי ראו</h4>"+kv(W&&W.pages?agg(W.pages,h=>h||"/").slice(0,8):null,true)
+'<p class="note">כניסות מטיקטוק, יוטיוב ושאר המקורות של תוכנית השיווק נמצאות במגירה "מקורות".</p>'}

// drawer: Google search
{const S=d.seo,box=$("seo");if(!S||!S.cur){box.innerHTML='<p class="note">'+(S?"אין עדיין נתוני חיפוש.":"Search Console לא ענה.")+"</p>"}else{
const qs=S.queries||[],ps=x=>n1(x),X=d.metrics&&d.metrics.index;
const TB=(heads,rows)=>rows.length?'<table class="t"><thead><tr>'+heads.map((h,i)=>"<th"+(i?' class="n"':"")+">"+h+"</th>").join("")+"</tr></thead><tbody>"+rows.map(r=>'<tr><td class="w">'+r[0]+"</td>"+r.slice(1).map(x=>'<td class="n">'+x+"</td>").join("")+"</tr>").join("")+"</tbody></table>":'<p class="note" style="margin:0">אין נתונים</p>';
const dd=(S.days||[]).slice(-28),mx=Math.max(1,...dd.map(x=>x[1]));
const path=u=>esc(String(u).replace(/^https?:\\/\\/[^/]+/,"")||"/");
box.innerHTML="<h4>כניסות מגוגל לפי יום, 28 ימים</h4>"+'<svg class="spark" viewBox="0 0 280 60" role="img" aria-label="כניסות מגוגל לפי יום">'+dd.map((x,i)=>{const h=x[1]?Math.max(3,x[1]/mx*52):0;return '<rect x="'+(i*10+1)+'" y="'+(56-h)+'" width="7" height="'+h+'" rx="1.5"/>'}).join("")+"</svg>"+'<div class="axis"><span>'+(dd[0]?dm(dd[0][0]):"")+"</span><span>"+(dd.length?dm(dd[dd.length-1][0]):"")+"</span></div>"
+"<h4>דפים שגוגל מכיר</h4>"+(X?'<ul class="kv"><li><span>נכנסו למאגר של גוגל</span><b>'+n(X.indexed)+"</b></li><li><span>נסרקו ועדיין לא נכנסו</span><b>"+n(X.crawledNotIndexed)+"</b></li><li><span>נבדקו בסך הכול</span><b>"+n(X.inspected)+"</b></li></ul>":'<p class="note" style="margin:0">אין נתון</p>')
+"<h4>מה הקלידו בגוגל (28 ימים)</h4>"+TB(["חיפוש","לחצו","ראו","מקום"],qs.slice().sort((a,b)=>b[1]-a[1]||b[2]-a[2]).slice(0,10).map(r=>[esc(r[0]),n(r[1]),n(r[2]),ps(r[4])]))
+"<h4>חיפושים שקרובים לעמוד הראשון</h4>"+TB(["חיפוש","ראו","מקום"],qs.filter(r=>r[4]>=8&&r[4]<=20&&r[2]>=3).sort((a,b)=>b[2]-a[2]).slice(0,8).map(r=>[esc(r[0]),n(r[2]),ps(r[4])]))
+"<h4>הדפים שגוגל הציג (28 ימים)</h4>"+TB(["דף","לחצו","ראו"],(S.pages||[]).slice(0,8).map(r=>['<bdi dir="ltr">'+path(r[0])+"</bdi>",n(r[1]),n(r[2])]))
+(S.sitemaps&&S.sitemaps.some(r=>r.errors||r.warnings)?'<p class="note">במפת האתר יש שגיאות או אזהרות. אני בודק ומתקן בסקירה השבועית.</p>':"")}}

// drawer: agent news
{const tm=t=>new Date(t).toLocaleTimeString("he-IL",{timeZone:"Asia/Jerusalem",hour:"2-digit",minute:"2-digit"});
$("fl").innerHTML=(d.flashes||[]).slice(0,12).map(f=>'<li><span class="ft">'+dm(new Date(f.t).toLocaleDateString("en-CA",{timeZone:"Asia/Jerusalem"}))+" "+tm(f.t)+'</span><span><span class="lv '+(f.l==="alert"?"alert":"")+'">'+(f.l==="alert"?"●":"○")+"</span> <b>"+esc(FK[f.k]||f.k)+":</b> "+esc(f.x)+(f.u&&/^https:\\/\\//.test(f.u)?' <a href="'+esc(f.u)+'" target="_blank" rel="noopener">קישור</a>':"")+"</span></li>").join("")||'<li><span class="note">אין מבזקים עדיין.</span></li>'}

// drawer: technical
{const fk=W&&W.fails?W.fails[0]:null,rt=d.events||[];
const li=(l,v)=>"<li><span>"+l+"</span><b>"+v+"</b></li>";
$("tec").innerHTML="<h4>בדיקות שלא החזירו תוצאה, לפי סיבה ("+rng(W&&W.W)+")</h4>"+(fk?'<ul class="kv">'+(Object.entries(fk).sort((a,b)=>b[1]-a[1]).map(e=>li(KIND[e[0]]||esc(e[0]),n(e[1]))).join("")||li("אין","0"))+"</ul>":'<p class="note" style="margin:0">אין נתון</p>')
+'<p class="note">'+(H.att!=null?"מתוך "+n(H.att)+" ניסיונות בדיקה. רק שתי הסיבות הראשונות נספרות בתקינות השירות.":"")+"</p>"
+"<h4>עוד סימנים טכניים השבוע</h4>"+'<ul class="kv">'+li("בדיקות איטיות",n(ge(E0,"lookup_slow")))+li("בדיקות שבוטלו באמצע",n(ge(E0,"lookup_abort")))+li("קריסות של האפליקציה",n(ge(E0,"app_exception")))+li("חיפושי דגם בלי תוצאה",n(ge(E0,"search_no_result")))+"</ul>"
+"<h4>אזור הזמן של גוגל אנליטיקס</h4>"+'<p class="note" style="margin:0">'+(!d.gaTz?"לא נבדק":d.gaTz.ok?(d.gaTz.tz==="Asia/Jerusalem"?"שעון ישראל, כמו שהמסך מניח ✓":"<b>"+esc(d.gaTz.tz||"לא ידוע")+"</b>: לא שעון ישראל, ולכן ימים ושבועות במסך נחתכים בשעה אחרת. אפשר לשנות ב-Analytics, בהגדרות הנכס."):"לא נבדק: "+(/not been used|disabled/i.test(d.gaTz.why||"")?"צריך להפעיל את Google Analytics Admin API בפרויקט של חשבון השירות. ":"")+'<bdi dir="ltr">('+esc(d.gaTz.why||"")+")</bdi>")+"</p>"
+"<h4>דוחות Google Play (התקנות)</h4>"+'<p class="note" style="margin:0">'+(PS?"מחובר. היום האחרון שגוגל מסרה: "+dm(PS.last)+".":!d.stats?"לא נבדק":d.stats.why==="no bucket"?"לא מחובר עדיין: חסר שם הדלי של הדוחות. עד אז כרטיס ההתקנות מציג את גוגל אנליטיקס.":"לא מחובר עדיין"+(/^40[13]/.test(d.stats.why||"")?": לחשבון השירות אין עדיין הרשאה להוריד דוחות. צריך הרשאה ברמת החשבון ב-Play Console, והיא יכולה להיכנס לתוקף רק אחרי עד 48 שעות.":/^404/.test(d.stats.why||"")?": לא נמצאו דוחות התקנות. כדאי לבדוק את שם הדלי.":".")+' <bdi dir="ltr">('+esc(d.stats.why||"")+")</bdi>")+"</p>"
+"<h4>Play Console</h4>"+'<p class="note" style="margin:0">'+(d.release?d.release.ok?"מחובר. מצב גרסאות הייצור נקרא משם.":"לא מחובר עדיין"+(/not been used|disabled/i.test(d.release.why||"")?": צריך להפעיל את Google Play Android Developer API בפרויקט של חשבון השירות ב-Google Cloud.":/permission|^40[13]/i.test(d.release.why||"")?": לחשבון השירות אין עדיין הרשאת צפייה באפליקציה ב-Play Console.":".")+' <bdi dir="ltr">('+esc(d.release.why||"")+")</bdi>":"לא נבדק")+"</p>"
+"<h4>מקורות נתונים</h4>"+'<ul class="kv">'+(Object.entries(d.errors||{}).map(e=>li(esc(e[0]),'<span style="font-weight:400">'+esc(e[1])+"</span>")).join("")||li("כל המקורות ענו","✓"))+"</ul>"}

$("build").textContent="גרסה "+(d.build||"");
}

async function go(){const meta=$("meta");try{const r=await fetch("/live/data",{cache:"no-store"});if(!r.ok)throw 0;const d=await r.json();window.lastD=d;render(d);
const tm=new Date(d.at).toLocaleTimeString("he-IL",{timeZone:"Asia/Jerusalem",hour:"2-digit",minute:"2-digit"});
meta.className="meta"+(d.stale?" stale":"");meta.innerHTML='<span class="dot"></span>'+(d.stale?"נתונים ישנים מ-"+tm+", גוגל הגביל זמנית את מספר הבקשות":"עודכן "+tm)}
catch{meta.className="meta stale";meta.innerHTML='<span class="dot"></span>אין חיבור'+(window.lastD?". מוצגים הנתונים האחרונים":"")}}
document.addEventListener("click",e=>{const a=e.target.closest("[data-open]");if(a){const el=$(a.dataset.open);if(el)el.open=true}});
go();setInterval(()=>{if(!document.hidden)go()},60000);
</script></body></html>`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!(await verifyAccess(req, env).catch(() => false))) return new Response("forbidden", { status: 403, headers: HEAD });
    if (url.pathname === "/live/data") { try { return json({ ...(await collect(env)), flashes: (await getFlashes()).slice(0, 15), metrics: await getMetrics() }); } catch (e) { return json({ error: "unavailable" }, 502); } }
    if (url.pathname === "/live" || url.pathname === "/live/") return new Response(PAGE, { headers: { ...HEAD, "content-type": "text/html; charset=utf-8" } });
    return new Response("not found", { status: 404, headers: HEAD });
  }
};

export { collect };
