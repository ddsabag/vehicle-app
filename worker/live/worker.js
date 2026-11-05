// luchit-live: a private business dashboard for the owner. GET /live is the page, GET /live/data the numbers (GA4, Cloudflare Web Analytics, Search Console, Google Play store page, Play Console releases and its statistics reports).
// Protected twice: Cloudflare Access in front (route luchit.app/live*), and this Worker verifies the Access JWT itself, so a misconfigured Access policy cannot leak data.
// Returns only aggregate counts, never anything personal. Secrets: GA_SERVICE_ACCOUNT_JSON, CF_API_TOKEN. Vars: see wrangler.toml.
// Cloudflare Web Analytics keeps luchit.app as two sites: the home page's own beacon (index.html, site tag 03eb..., since 8.10; the token in the
// page, 9bb0..., is not a site tag) and the beacon Cloudflare adds by itself to every page (5c0a..., since 12.10). A page reports through one of
// them only, so the two are added up. The owner's own /live screen is left out, and so are automated browsers (headless Chrome: the site's own
// checks and crawlers, about a sixth of the page views; the page's own beacon already skips them, the added one does not).
const CF_SITES = ["03eb6fb7a75440649781d7a00b29c4ff", "5c0a33a14f5f4201b25fd680a29ae723"];
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const BUILD = "live-53";   // shown in /live/data so the running version is visible
const HEAD = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...HEAD, "content-type": "application/json; charset=utf-8" } });

let jwks = null, jwksAt = 0;
async function verifyAccess(req, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return false;          // not configured: refuse
  const tok = req.headers.get("cf-access-jwt-assertion"); if (!tok) return false;
  const [h, p, s] = tok.split("."); if (!s) return false;
  const head = JSON.parse(new TextDecoder().decode(unb64u(h))), pay = JSON.parse(new TextDecoder().decode(unb64u(p)));
  if (Date.now() - jwksAt > 3600e3 || !jwks) { jwks = (await (await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10e3) })).json()).keys; jwksAt = Date.now(); }
  const jwk = jwks.find(k => k.kid === head.kid); if (!jwk) return false;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64u(s), new TextEncoder().encode(h + "." + p));
  const aud = Array.isArray(pay.aud) ? pay.aud : [pay.aud];
  return ok && aud.includes(env.ACCESS_AUD) && pay.exp * 1000 > Date.now() && pay.iss === `https://${env.ACCESS_TEAM_DOMAIN}`;
}

// one token for every Google API the screen reads (a Worker request may make only 50 outside calls, so no token per API)
const SCOPES = ["analytics.readonly", "webmasters.readonly", "androidpublisher", "devstorage.read_only"].map(x => "https://www.googleapis.com/auth/" + x).join(" ");
const gtoks = {};
// collect() asks for the token once, before its parallel calls, and a refused one is not asked again for a minute. A request never waits on
// another request's token call: a request that ends mid-load (the screen closed or reloaded) leaves its unfinished calls unsettled for good,
// and on 20.10 from 14:00 UTC every /live/data request waited on such a shared call until the browser gave up (live-27)
let gtokErr = null, gtokErrAt = 0;
async function googleToken(env) {
  const c = gtoks[SCOPES]; if (c && Date.now() < c.exp) return c.tok;
  if (gtokErr && Date.now() - gtokErrAt < 60e3) throw gtokErr;
  try { return await newToken(env); } catch (e) { gtokErr = e; gtokErrAt = Date.now(); throw e; }
}
async function newToken(env) {
  const scope = SCOPES, sa = JSON.parse(env.GA_SERVICE_ACCOUNT_JSON), now = Math.floor(Date.now() / 1000);
  const enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: "RS256", typ: "JWT" }) + "." + enc({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 });
  const pem = sa.private_key.replace(/-----[^-]+-----|\s/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = b64u(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig }), signal: AbortSignal.timeout(10e3) });
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
async function cfQuery(env, day, dim, limit, lastDay = day, order = "sum_visits_DESC") {   // Israel days day..lastDay
  const token = cleanToken(env.CF_API_TOKEN), account = String(env.CF_ACCOUNT_ID || "").trim();
  if (!token || !account) return null;
  const dims = dim ? `dimensions{${dim}}` : "";
  const q = `query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){rumPageloadEventsAdaptiveGroups(filter:$f,limit:${limit},orderBy:[${order}]){count sum{visits} ${dims}}}}}`;
  const f = { AND: [{ datetime_geq: ilStart(day), datetime_lt: ilStart(addDays(lastDay, 1)) }, { siteTag_in: CF_SITES }, { requestPath_notlike: "/live%" }, { userAgentBrowser_neq: "ChromeHeadless" }] };
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: { acc: account, f } }) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.errors) throw new Error("cloudflare " + r.status + " " + JSON.stringify(j?.errors || j).slice(0, 140));
  return j?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];
}
async function cfVisits(env, day) {
  const g = await cfQuery(env, day, "", 1); if (g == null) return null;
  return g[0] ? { visits: Math.round(g[0].sum.visits), views: g[0].count } : { visits: 0, views: 0 };
}
async function cfTop(env, day, dim, lastDay = day, limit = 12, order) {
  const g = await cfQuery(env, day, dim, limit, lastDay, order); if (g == null) return null;
  return g.map(x => [x.dimensions[dim] || "", Math.round(x.sum.visits), x.count]);
}

// Google Play's pre-launch report installs every uploaded build on test devices abroad, so app numbers count only devices in Israel; the site keeps every visitor
const REAL = { orGroup: { expressions: [{ filter: { fieldName: "platform", stringFilter: { value: "web" } } }, { filter: { fieldName: "countryId", stringFilter: { value: "IL" } } }] } };
const withReal = f => ({ andGroup: { expressions: [f, REAL] } });
// app devices in Israel only: on the site every page load is a new GA4 "user" (the web client id is never saved), so user counts come from the app
const APP = { andGroup: { expressions: [{ filter: { fieldName: "platform", stringFilter: { value: "Android" } } }, { filter: { fieldName: "countryId", stringFilter: { value: "IL" } } }] } };

// A collector that was answered from memory says so (cached), so a quota error it remembers does not stop this request's own calls. A part that
// failed keeps its last good numbers (and its error is shown), and the collector asks again after a minute instead of its usual wait.
const keep = (fresh, prev, keys) => { const o = { ...fresh }; for (const k of keys) if (o[k] == null && prev && prev[k] != null) o[k] = prev[k]; return o; };
let daily = null, dailyAt = 0, dailyTtl = 0;
async function collectDaily(env) {
  if (daily && Date.now() - dailyAt < dailyTtl) return { ...daily, cached: true };
  const errors = {};
  const dr = [{ startDate: "today", endDate: "today" }, { startDate: "yesterday", endDate: "yesterday" }];
  const safe = (p, k) => p.catch(e => { errors[k] = String(e.message || e).slice(0, 200); return null; });
  // where people came from, the last 7 days with today [0] and today alone [1]: visits to the site by the source the page sends (src, from
  // 20.10), and new app devices in Israel by the link they reached the store from (Google Play's install referrer, firstUserSource)
  const R = [{ startDate: "6daysAgo", endDate: "today" }, { startDate: "today", endDate: "today" }];
  const web = v => ({ andGroup: { expressions: [{ filter: { fieldName: "platform", stringFilter: { value: "web" } } }, { filter: { fieldName: "eventName", stringFilter: { value: v } } }] } });
  const [evs, chSite, chApp, life] = await Promise.all([
    safe(report(env, { dateRanges: dr, dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: REAL, limit: 100 }), "ga4 events"),
    safe(report(env, { dateRanges: R, dimensions: [{ name: "customEvent:src" }], metrics: [{ name: "eventCount" }], dimensionFilter: web("web_visit"), limit: 100 }), "ga4 channels site"),
    safe(report(env, { dateRanges: R, dimensions: [{ name: "firstUserSource" }], metrics: [{ name: "newUsers" }], dimensionFilter: APP, limit: 100 }), "ga4 channels app"),
    // the app's first opens and removals in Israel by day: "installed now" is Google Play's count on its last reported day plus what came after
    safe(report(env, { dateRanges: [{ startDate: "2026-10-01", endDate: "today" }], dimensions: [{ name: "date" }, { name: "eventName" }], metrics: [{ name: "eventCount" }],
      dimensionFilter: { andGroup: { expressions: [APP, { filter: { fieldName: "eventName", inListFilter: { values: ["first_open", "app_remove"] } } }] } }, limit: 1000 }), "ga4 installs now")]);
  const range = r => r.dimensionValues[r.dimensionValues.length - 1].value;   // "date_range_0" (today) or "date_range_1"
  const ev = { today: {}, yesterday: {} };
  for (const r of evs || []) ev[range(r) === "date_range_0" ? "today" : "yesterday"][r.dimensionValues[0].value] = [Number(r.metricValues[0].value), Number(r.metricValues[1].value)];
  const byRange = rows => { const o = [{}, {}]; for (const r of rows || []) { const i = range(r) === "date_range_1" ? 1 : 0, k = r.dimensionValues[0].value || "(not set)"; o[i][k] = (o[i][k] || 0) + Number(r.metricValues[0].value); } return o; };
  const lf = {};   // { "2026-10-19": [first opens, removals] }
  for (const r of life || []) { const v = r.dimensionValues[0].value, k = v.slice(0, 4) + "-" + v.slice(4, 6) + "-" + v.slice(6); (lf[k] ||= [0, 0])[r.dimensionValues[1].value === "app_remove" ? 1 : 0] += Number(r.metricValues[0].value); }
  daily = keep({ errors, events: evs ? ev : null, ch: chSite || chApp ? { site: chSite ? byRange(chSite) : null, app: chApp ? byRange(chApp) : null } : null, life: life ? lf : null }, daily, ["events", "ch", "life"]);
  dailyAt = Date.now(); dailyTtl = Object.keys(errors).length ? 60e3 : 300e3; return daily;
}

// Where a visit came from, in the buckets of the marketing plan. The site's events reach GA4 through the Measurement Protocol, without a
// session, so their session source is always "(not set)": the page sends the source itself with every event (src, index.html LAND): the
// utm_source of the /go/ short links, "share" for a shared report or comparison, else the referring site or app (google, search, facebook,
// whatsapp..., site = another page of luchit.app, direct). The app is one bucket, because a session inside the app carries no source worth
// reading. Site events from before src existed (20.10.2026) are "unknown".
const GO_SOURCES = ["tiktok", "instagram", "facebook", "linkedin", "youtube", "whatsapp", "newsletter", "press", "dealer", "qr", "share"];
const WEB_SOURCES = ["google", "search", "direct", "site"];
function srcBucket(platform, src) {
  if (platform !== "web") return "app";
  const s = String(src || "").toLowerCase();
  if (GO_SOURCES.includes(s) || WEB_SOURCES.includes(s)) return s;
  return !s || s === "(not set)" ? "unknown" : "other";
}

// The month's three questions (until 22.11) count from the release of 1.36, the first version that sends share_open, first_save and app_return
const Q_FROM = "2026-10-21";
// the events kept day by day for the charts (about 9 weeks): car checks, installs (first opens), shares, site visits and saved cars
const HIST_EV = ["car_lookup", "first_open", "share", "web_visit", "car_save"];
const iso8 = v => v.slice(0, 4) + "-" + v.slice(4, 6) + "-" + v.slice(6);
const v136 = v => { const m = /^(\d+)\.(\d+)/.exec(v || ""); return !!m && (Number(m[1]) > 1 || Number(m[2]) >= 36); };

// The business view: whole weeks, not "right now". GA4 needs about a day to finish counting, so the week ends yesterday after noon and the day before until then.
const ilHour = t => Number(new Date(t).toLocaleString("en-US", { timeZone: "Asia/Jerusalem", hour: "2-digit", hourCycle: "h23" }));
let weekly = null, weeklyAt = 0, weeklyTtl = 0;
async function collectWeekly(env, today) {
  if (weekly && Date.now() - weeklyAt < weeklyTtl) return { ...weekly, cached: true };
  const errors = {}, safe = (p, k) => p.catch(e => { errors[k] = String(e.message || e).slice(0, 200); return null; });
  const end = addDays(today, ilHour(Date.now()) >= 12 ? -1 : -2);
  const W = [addDays(end, -6), end], P = [addDays(end, -13), addDays(end, -7)], M = [addDays(end, -27), end];
  const dr = w => ({ startDate: w[0], endDate: w[1] }), only = v => ({ filter: { fieldName: "eventName", stringFilter: { value: v } } }), any = vs => ({ filter: { fieldName: "eventName", inListFilter: { values: vs } } });
  const histFrom = [addDays(end, -62), "2026-10-04"].sort()[0];   // the growth target is chained from the week of 18-24.10, so keep that week in reach
  const CW = [addDays(today, -7), addDays(today, -1)];            // Cloudflare counts in real time: the last 7 whole days
  const bySrcQ = dims => report(env, { dateRanges: [dr(W), dr(P)], dimensions: [{ name: "platform" }, ...dims, { name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: withReal(any(["web_visit", "car_lookup"])), limit: 5000 });
  // src (from 20.10) and camp (the topic of a go/ link, ?c=, from 23.10) are custom fields: GA4 answers 400 for a field it does not know, so
  // each is dropped in turn and its column reads "(not set)"
  const is400 = e => /\b400\b/.test(e.message), pad = (rows, at, k) => rows.map(r => ({ ...r, dimensionValues: [...r.dimensionValues.slice(0, at), ...Array(k).fill({ value: "(not set)" }), ...r.dimensionValues.slice(at)] }));
  const srcRows = () => bySrcQ([{ name: "customEvent:src" }, { name: "customEvent:camp" }]).catch(e => !is400(e) ? Promise.reject(e)
    : bySrcQ([{ name: "customEvent:src" }]).then(rows => pad(rows, 2, 1)).catch(e2 => !is400(e2) ? Promise.reject(e2) : bySrcQ([]).then(rows => pad(rows, 1, 2))));
  const [evs, fails, links, hist, app, money, src, pages, saveU, bySrc, ret, appS, appC, durs, door, e28] = await Promise.all([
    safe(report(env, { dateRanges: [dr(W), dr(P), dr(M)], dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: REAL, limit: 250 }), "ga4 week"),
    safe(report(env, { dateRanges: [dr(W), dr(P)], dimensions: [{ name: "customEvent:kind" }], metrics: [{ name: "eventCount" }], dimensionFilter: withReal(only("lookup_failed")), limit: 20 }), "ga4 failures"),
    safe(report(env, { dateRanges: [dr(W), dr(P)], dimensions: [{ name: "eventName" }, { name: "customEvent:kind" }, { name: "customEvent:via" }], metrics: [{ name: "eventCount" }], dimensionFilter: withReal(any(["link_landing", "link_open", "referral_open", "link_out"])), limit: 200 }), "ga4 shared links"),
    safe(report(env, { dateRanges: [{ startDate: histFrom, endDate: end }], dimensions: [{ name: "date" }, { name: "platform" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: withReal(any(HIST_EV)), limit: 2000 }), "ga4 history"),
    safe(report(env, { dateRanges: [dr(W), dr(P), dr(M)], dimensions: [{ name: "countryId" }], metrics: [{ name: "newUsers" }, { name: "activeUsers" }, { name: "totalUsers" }], dimensionFilter: { filter: { fieldName: "platform", stringFilter: { value: "Android" } } }, limit: 250 }), "ga4 app"),
    safe(report(env, { dateRanges: [{ startDate: "2026-10-01", endDate: "today" }], dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: any(["b2b_lead_submit", "newsletter_confirm"]) }), "ga4 money"),
    safe(cfTop(env, CW[0], "refererHost", CW[1], 100), "site week sources"), safe(cfTop(env, CW[0], "requestPath", CW[1], 12, "count_DESC"), "site week pages"),
    safe(report(env, { dateRanges: [dr(W), dr(P)], dimensions: [{ name: "eventName" }], metrics: [{ name: "totalUsers" }], dimensionFilter: { andGroup: { expressions: [APP, any(["car_lookup", "car_save"])] } } }), "ga4 app savers"),
    // without the src field the site is one row, "unknown", rather than no table at all
    safe(srcRows(), "ga4 sources"),
    // the month's questions: each day's new installs from 1.36 on (first_open by app version), their saves on the install day and their returns
    // on days 1 to 7, both by install day (kind); and new app devices by the link that brought them to the store (google-play = found in the store)
    end >= Q_FROM ? safe(report(env, { dateRanges: [{ startDate: Q_FROM, endDate: end }], dimensions: [{ name: "date" }, { name: "eventName" }, { name: "appVersion" }, { name: "customEvent:n" }, { name: "customEvent:kind" }], metrics: [{ name: "eventCount" }],
      dimensionFilter: { andGroup: { expressions: [APP, any(["first_open", "first_save", "app_return"])] } }, limit: 5000 }), "ga4 return") : null,
    safe(report(env, { dateRanges: [dr(W), dr(P)], dimensions: [{ name: "firstUserSource" }, { name: "firstUserCampaignName" }], metrics: [{ name: "newUsers" }], dimensionFilter: APP, limit: 1000 }), "ga4 app sources"),
    // the app opened by a tagged link with a topic (link_open kind campaign, via = the network, camp = the topic; the app sends it from 1.38)
    safe(report(env, { dateRanges: [dr(W), dr(P)], dimensions: [{ name: "customEvent:kind" }, { name: "customEvent:via" }, { name: "customEvent:camp" }], metrics: [{ name: "eventCount" }], dimensionFilter: withReal(only("link_open")), limit: 1000 }), "ga4 app campaign opens"),
    // how long car checks took, by the bucket the site and every app version send alike (dur: lt2, 2to5, 5to10, gt10)
    safe(report(env, { dateRanges: [dr(W), dr(P)], dimensions: [{ name: "customEvent:dur" }], metrics: [{ name: "eventCount" }], dimensionFilter: withReal(only("car_lookup")), limit: 20 }), "ga4 check durations"),
    // the car-file door (1.38): the "פתיחת תיק" row seen at the end of the overview (file_cta_shown, once per car) and files opened, by where
    // (mine_set from: overview = that row, menu, home), so the 22.11 file read tells "not seen" from "not wanted"
    safe(report(env, { dateRanges: [dr(W), dr(P)], dimensions: [{ name: "eventName" }, { name: "customEvent:from" }], metrics: [{ name: "eventCount" }], dimensionFilter: withReal(any(["file_cta_shown", "mine_set"])), limit: 50 }), "ga4 file door"),
    // every event by day and by platform over the 28 days, for the drill-down of each action in the usage drawer (site or app, day by day) and the weekly funnel
    safe(report(env, { dateRanges: [dr(M)], dimensions: [{ name: "date" }, { name: "platform" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: REAL, limit: 10000 }), "ga4 events by day")]);
  const ri = r => { const v = r.dimensionValues[r.dimensionValues.length - 1].value; return /^date_range_\d$/.test(v) ? Number(v.slice(-1)) : 0; };
  const ev = [{}, {}, {}];
  for (const r of evs || []) ev[ri(r)][r.dimensionValues[0].value] = [Number(r.metricValues[0].value), Number(r.metricValues[1].value)];
  // { "shown" | "overview" | "menu" | "home" | "other": [this week, week before] }
  const dr8 = {};
  for (const r of door || []) { const [nm, fr] = r.dimensionValues.map(x => x.value), k = nm === "file_cta_shown" ? "shown" : ["overview", "menu", "home"].includes(fr) ? fr : "other"; (dr8[k] ||= [0, 0])[ri(r)] += Number(r.metricValues[0].value); }
  const fk = [{}, {}];
  for (const r of fails || []) fk[ri(r)][r.dimensionValues[0].value] = Number(r.metricValues[0].value);
  // arrivals from a shared report or comparison: web landings and app opens whose link carried s=img|full|pdf|txt|qr, or a comparison link.
  // Not arrivals: campaign links (counted apart), the "open in the app" bar and "copy the link" of a page already open (s=bar, s=copy: the
  // same visit going on, kept as bar) and the first launch after an install from a shared link (referral_open: the landing before it counted)
  // social: clicks on the site footer's links to our pages (link_out kind social, via = the network); other outbound links are not counted here
  const shared = [{ web: 0, app: 0, bar: 0, inst: 0, by: {} }, { web: 0, app: 0, bar: 0, inst: 0, by: {} }], social = [{}, {}];
  for (const r of links || []) {
    const [name, kind, via] = r.dimensionValues.map(x => x.value), c = Number(r.metricValues[0].value), o = shared[ri(r)];
    if (name === "link_out") { if (kind === "social" && via && via !== "(not set)") social[ri(r)][via] = (social[ri(r)][via] || 0) + c; continue; }
    if (name === "referral_open") { o.inst += c; continue; }
    if (kind === "campaign") continue;
    if (via === "bar" || via === "copy") { o.bar += c; continue; }
    const k = kind === "cmp" ? "cmp" : via && via !== "none" && via !== "(not set)" ? via : null;
    if (!k) continue;
    o[name === "link_landing" ? "web" : "app"] += c; o.by[k] = (o.by[k] || 0) + c;
  }
  // first opens (new devices) and active devices of the app, in Israel and abroad (abroad is mostly Google's pre-launch test devices)
  const appU = [0, 1, 2].map(i => { const o = { newUsers: 0, activeUsers: 0, totalUsers: 0, abroadNew: 0, abroadActive: 0 };
    for (const r of app || []) if (ri(r) === i) { const il = r.dimensionValues[0].value === "IL"; o[il ? "newUsers" : "abroadNew"] += Number(r.metricValues[0].value); o[il ? "activeUsers" : "abroadActive"] += Number(r.metricValues[1].value); if (il && r.metricValues[2]) o.totalUsers += Number(r.metricValues[2].value); }
    return o; });
  const m = {}; for (const r of money || []) m[r.dimensionValues[0].value] = Number(r.metricValues[0].value);
  // site visits (web_visit, once per opening of the page) and car checks (site and app) by where the visit came from, this week [0] and the
  // week before [1]: { bucket: [visits, checks] }; byCamp the same for visits that came by a tagged link with a topic: { "source|topic": [visits, checks] }
  // srcSeen: the week has site rows with a measured source (from 20.10), so its site rows can be compared with another week's
  const bs = [{}, {}], srcSeen = [false, false], bc = [{}, {}], tagged = v => v && v !== "(not set)";
  for (const r of bySrc || []) { const [pf, so, cp, name] = r.dimensionValues.map(x => x.value), i = ri(r), k = srcBucket(pf, so), j = name === "car_lookup" ? 1 : 0, c = Number(r.metricValues[0].value);
    (bs[i][k] ||= [0, 0])[j] += c; if (k !== "app" && k !== "unknown") srcSeen[i] = true;
    if (pf === "web" && tagged(cp) && k !== "share" && k !== "site") (bc[i][k + "|" + cp] ||= [0, 0])[j] += c; }
  // { install day: [new installs from 1.36, saved a car that day, came back on days 1-7 having saved, having not, of those counted by estimate] }
  // The install day rides in kind (MM-DD), but GA4 got kind "(not set)" from the app on every one of them since 22.10 (deep check, 25.10), so a row
  // without it is placed by estimate until the app sends it again: first_save fires only on the install day (its own date), and app_return is the
  // first opening on days 1 to 7, most often day 1 (its date minus one). The drawer marks such numbers as an estimate.
  const coh = {};
  for (const r of ret || []) { const [dt, name, ver, nv, kind] = r.dimensionValues.map(x => x.value), c = Number(r.metricValues[0].value), md = /^\d\d-\d\d$/.test(kind || "");
    const day = name === "first_open" ? iso8(dt) : md ? Q_FROM.slice(0, 5) + kind : /^\d{8}$/.test(dt) ? (name === "first_save" ? iso8(dt) : addDays(iso8(dt), -1)) : null;
    if (!/^\d{4}-\d\d-\d\d$/.test(day || "")) continue; const o = coh[day] ||= [0, 0, 0, 0, 0];
    if (name !== "first_open" && !md) o[4] += c;
    if (name === "first_open") { if (v136(ver)) o[0] += c; } else if (name === "first_save") o[1] += c; else o[nv === "1" ? 2 : 3] += c; }
  // new app devices by the link that brought them to the store: all, found in the store (google-play), and by tagged link and topic ("source|topic")
  const aSrc = [{ store: 0, all: 0, camp: {} }, { store: 0, all: 0, camp: {} }];
  for (const r of appS || []) { const o = aSrc[ri(r)], c = Number(r.metricValues[0].value), so = String(r.dimensionValues[0].value).toLowerCase(), cp = String(r.dimensionValues[1].value).toLowerCase();
    o.all += c; if (so === "google-play") o.store += c; else if (tagged(so) && so !== "(direct)" && so !== "luchit.app" && tagged(cp) && cp !== "(direct)" && cp !== "(organic)" && cp !== "car_share") o.camp[so + "|" + cp] = (o.camp[so + "|" + cp] || 0) + c; }
  // app opens by tagged link and topic: { "source|topic": opens } (a link without a topic counts under the network's default, as the go/ link sets it)
  const aOpen = [{}, {}];
  for (const r of appC || []) { const [kind, via, cp] = r.dimensionValues.map(x => String(x.value).toLowerCase()), c = Number(r.metricValues[0].value);
    if (kind === "campaign" && tagged(via) && tagged(cp)) aOpen[ri(r)][via + "|" + cp] = (aOpen[ri(r)][via + "|" + cp] || 0) + c; }
  // { bucket: checks } this week [0] and the week before [1]; checks without a bucket ("(not set)") are left out
  const dur = [{}, {}];
  for (const r of durs || []) { const b = r.dimensionValues[0].value; if (/^(lt2|2to5|5to10|gt10)$/.test(b)) dur[ri(r)][b] = (dur[ri(r)][b] || 0) + Number(r.metricValues[0].value); }
  // day by day for the charts: { event: { day: count } } for the events in HIST_EV, plus car checks on the site alone (site_lookup)
  const hd = Object.fromEntries([...HIST_EV, "site_lookup"].map(k => [k, {}]));
  for (const r of hist || []) { const [dt, pf, name] = r.dimensionValues.map(x => x.value), day = iso8(dt), c = Number(r.metricValues[0].value);
    if (!hd[name]) continue; hd[name][day] = (hd[name][day] || 0) + c; if (name === "car_lookup" && pf === "web") hd.site_lookup[day] = (hd.site_lookup[day] || 0) + c; }
  // { event: { a: [28 days in the app], w: [28 days on the site] } }, oldest first: the week shown is the last 7 days, the week before the 7 before them
  const ed = {};
  for (const r of e28 || []) { const [dt, pf, name] = r.dimensionValues.map(x => x.value), i = Math.round((Date.parse(iso8(dt) + "T12:00:00Z") - Date.parse(M[0] + "T12:00:00Z")) / 864e5); if (!(i >= 0 && i <= 27)) continue; (ed[name] ||= { a: Array(28).fill(0), w: Array(28).fill(0) })[pf === "web" ? "w" : "a"][i] += Number(r.metricValues[0].value); }
  const fresh = { errors, end, W, P, M, CW, ev: evs ? ev : null, fails: fails ? fk : null, shared: links ? shared : null, social: links ? social : null,
    days: hist ? hd.car_lookup : null, series: hist ? hd : null,
    app: app ? appU : null, savers: saveU ? Object.fromEntries(saveU.filter(r => ri(r) === 0).map(r => [r.dimensionValues[0].value, Number(r.metricValues[0].value)])) : null, saversP: saveU ? Object.fromEntries(saveU.filter(r => ri(r) === 1).map(r => [r.dimensionValues[0].value, Number(r.metricValues[0].value)])) : null, money: money ? { leads: m.b2b_lead_submit || 0, subscribers: m.newsletter_confirm || 0 } : null, sources: src, pages, bySource: bySrc ? bs : null, srcSeen: bySrc ? srcSeen : null, byCamp: bySrc ? bc : null, coh: ret ? coh : null, appSrc: appS ? aSrc : null, appOpen: appC ? aOpen : null, dur: durs ? dur : null, door: door ? dr8 : null, e28: e28 ? ed : null };
  // the last good numbers stand in for a part that failed, but only for the same week (a new week starts clean)
  weekly = keep(fresh, weekly && weekly.end === end ? weekly : null, ["ev", "fails", "shared", "social", "days", "series", "app", "savers", "money", "sources", "pages", "bySource", "srcSeen", "byCamp", "coh", "appSrc", "appOpen", "dur", "door", "saversP", "e28"]);
  // a Google part that failed is asked again after a minute; Cloudflare alone after five, so its failure does not re-run the Google queries every minute
  weeklyAt = Date.now(); weeklyTtl = Object.keys(errors).some(k => k.startsWith("ga4")) ? 60e3 : Object.keys(errors).length ? 300e3 : 900e3; return weekly;
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
// a side source that fails after it once answered keeps its last good answer (marked stale) and is asked again in 5 minutes. On a cold
// refresh about 45 Google calls start together and a Worker opens 6 connections at a time, so a call can wait its turn longer than its own
// timeout: a timeout says nothing about the source itself (26.10: GA time zone and Play reports showed "aborted due to timeout")
const keepGood = (prev, why) => prev && prev.ok ? { ...prev, stale: why } : { ok: false, why };
const sideFresh = (o, at, ttl) => o && Date.now() - at < (o.ok && !o.stale ? ttl : o.ok ? 300e3 : 900e3);
const SIDE_MS = 15e3;
let rel = null, relAt = 0;
async function playRelease(env) {
  if (sideFresh(rel, relAt, 900e3)) return rel;
  relAt = Date.now();
  try {
    const r = await fetch("https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.ddsabag.pratirechev/tracks/production/releases",
      { headers: { authorization: "Bearer " + await googleToken(env) }, signal: AbortSignal.timeout(SIDE_MS) });
    if (!r.ok) { const t = await r.text(); let m = t; try { m = JSON.parse(t).error.message || t; } catch {} rel = keepGood(rel, r.status + " " + String(m).replace(/\s+/g, " ").slice(0, 160)); }
    else {
      const list = ((await r.json()).releases || []).map(x => ({ name: String(x.releaseName || "").slice(0, 40), state: String(x.releaseLifecycleState || "").replace("RELEASE_LIFECYCLE_STATE_", "").toLowerCase(),
        code: Math.max(0, ...(x.activeArtifacts || []).map(a => Number(a.versionCode) || 0)) }));
      list.sort((a, b) => b.code - a.code);   // newest build first
      rel = { ok: true, at: new Date().toISOString(), list: list.slice(0, 3) };
    }
  } catch (e) { rel = keepGood(rel, String(e.message || e).slice(0, 160)); }
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
  if (sideFresh(pst, pstAt, 3 * 3600e3)) return pst;
  pstAt = Date.now();
  try {
    const tok = await googleToken(env);
    const month = k => { const d = new Date(Date.parse(today.slice(0, 7) + "-15T12:00:00Z")); d.setUTCMonth(d.getUTCMonth() + k); return d.toISOString().slice(0, 7).replace("-", ""); };
    const get = async (kind, m) => {
      const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(`stats/${kind}/${kind}_${PKG}_${m}_country.csv`)}?alt=media`,
        { headers: { authorization: "Bearer " + tok }, signal: AbortSignal.timeout(SIDE_MS) });
      if (r.status === 404) return null;   // this month's file does not exist yet
      if (!r.ok) { const t = await r.text(); let msg = t; try { msg = JSON.parse(t).error.message || t; } catch {} throw new Error(r.status + " " + String(msg).replace(/\s+/g, " ").slice(0, 140)); }
      return csvRows(csvText(await r.arrayBuffer()));
    };
    const [i0, i1, s0, s1] = await Promise.all([get("installs", month(-1)), get("installs", month(0)), get("store_performance", month(-1)), get("store_performance", month(0))]);
    if (!i0 && !i1) throw new Error("404 no installs report in the bucket for " + month(-1) + " or " + month(0));
    // per day: new users in Israel, new users abroad, users who uninstalled (Israel), all install events incl. reinstalls (Israel), store listing visitors and acquisitions (Israel)
    const day = {}, at = d => day[d] || (day[d] = [0, 0, 0, 0, 0, 0]), num = v => Number(String(v || "").replace(/,/g, "")) || 0, cc = r => r.country ?? r.countryregion ?? "";
    let total = 0, totalDay = "", lastIL = "";
    const act = {};   // devices in Israel that have the app (active in the last 30 days), per day
    for (const r of [...(i0 || []), ...(i1 || [])]) {
      const d = isoDay(r.date || ""); if (!d) continue;
      const a = at(d);
      if (cc(r) === "IL") { a[0] += num(r.dailyuserinstalls); a[2] += num(r.dailyuseruninstalls); a[3] += num(r.installevents); act[d] = (act[d] || 0) + num(r.activedeviceinstalls); if (d > lastIL) lastIL = d; if (d >= totalDay && num(r.totaluserinstalls)) { total = num(r.totaluserinstalls); totalDay = d; } }
      else a[1] += num(r.dailyuserinstalls);
    }
    for (const r of [...(s0 || []), ...(s1 || [])]) { const d = isoDay(r.date || ""); if (d && cc(r) === "IL") { const a = at(d); a[4] += num(r.storelistingvisitors); a[5] += num(r.storelistingacquisitions); } }
    const last = Object.keys(day).sort().pop();   // the newest day Google has posted
    if (!last) throw new Error("the installs report has no rows");
    const sum = w => { const o = [0, 0, 0, 0, 0, 0]; for (const [d, a] of Object.entries(day)) if (d >= w[0] && d <= w[1]) a.forEach((v, i) => { o[i] += v; });
      return { users: o[0], abroad: o[1], uninstalls: o[2], events: o[3], visitors: o[4], acquisitions: o[5] }; };
    const W = [addDays(last, -6), last], P = [addDays(last, -13), addDays(last, -7)];
    pst = { ok: true, at: new Date().toISOString(), last, W, P, cur: sum(W), prev: sum(P), total: total || null, store: !!(s0 || s1), active: lastIL ? act[lastIL] : null, activeDay: lastIL || null };
  } catch (e) { pst = keepGood(pst, String(e.message || e).slice(0, 160)); }
  return pst;
}

// The store rating for milestone M3 (rating 4.5 or more, 21 ratings): Play Console's monthly reports in the same bucket. The average is the
// lifetime "Total Average Rating" of the newest day in stats/ratings; the count is every rating in reviews/ (a star rating with or without
// text, one row per person, from the first month on Play, 10.2026). A closed month's count is kept in KV (lv:rv:<yyyymm>) so a cold request
// reads two months, not every month since launch. Refreshed every 6 hours; { ok: false, why } until the reports exist. Never throws.
const csvAll = t => {   // like csvRows, but a quoted field may hold line breaks (review texts do)
  const rows = []; let row = [], c = "", q = false;
  for (let i = 0; i < t.length; i++) { const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { row.push(c.trim()); c = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && t[i + 1] === "\n") i++; row.push(c.trim()); c = ""; if (row.some(v => v)) rows.push(row); row = []; }
    else c += ch; }
  row.push(c.trim()); if (row.some(v => v)) rows.push(row);
  const head = (rows.shift() || []).map(h => h.toLowerCase().replace(/[^a-z]/g, ""));
  return rows.map(v => { const r = {}; head.forEach((h, i) => { r[h] = v[i]; }); return r; });
};
const RV_FROM = "202610";
let prt = null, prtAt = 0;
async function playRatings(env, today) {
  const bucket = String(env.PLAY_REPORTS_BUCKET || "").trim().replace(/^gs:\/\//, "").split("/")[0];
  if (!bucket) return { ok: false, why: "no bucket" };
  if (sideFresh(prt, prtAt, 6 * 3600e3)) return prt;
  prtAt = Date.now();
  try {
    const tok = await googleToken(env);
    const month = k => { const d = new Date(Date.parse(today.slice(0, 7) + "-15T12:00:00Z")); d.setUTCMonth(d.getUTCMonth() + k); return d.toISOString().slice(0, 7).replace("-", ""); };
    const get = async path => {
      const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(path)}?alt=media`,
        { headers: { authorization: "Bearer " + tok }, signal: AbortSignal.timeout(SIDE_MS) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(r.status + " " + path);
      return csvAll(csvText(await r.arrayBuffer()));
    };
    const tally = rows => { const o = { n: 0, sum: 0, txt: 0, last: "" };
      for (const r of rows || []) { const st = Number(r.starrating); if (!(st >= 1 && st <= 5)) continue;
        o.n++; o.sum += st; if ((r.reviewtext || "").trim()) o.txt++; const d = isoDay(String(r.reviewsubmitdateandtime || "").slice(0, 10)); if (d > o.last) o.last = d; }
      return o; };
    const cur = month(0), prev = month(-1), closed = [];
    for (let k = -2; month(k) >= RV_FROM && k > -36; k--) closed.push(month(k));
    const [r0, r1, v0, v1, ...old] = await Promise.all([
      get(`stats/ratings/ratings_${PKG}_${cur}_overview.csv`), get(`stats/ratings/ratings_${PKG}_${prev}_overview.csv`),
      get(`reviews/reviews_${PKG}_${cur}.csv`), prev >= RV_FROM ? get(`reviews/reviews_${PKG}_${prev}.csv`) : null,
      ...closed.map(async m => { const k = "lv:rv:" + m, kept = env.ALERTS ? await env.ALERTS.get(k, "json").catch(() => null) : null;
        if (kept) return kept;
        const t = tally(await get(`reviews/reviews_${PKG}_${m}.csv`));
        if (env.ALERTS) await env.ALERTS.put(k, JSON.stringify(t)).catch(() => {});
        return t; })]);
    let avg = null, avgDay = "";
    for (const r of [...(r1 || []), ...(r0 || [])]) { const d = isoDay(r.date || ""), a = Number(r.totalaveragerating); if (d && a > 0 && d >= avgDay) { avg = a; avgDay = d; } }
    const all = [tally(v0), tally(v1), ...old], n = all.reduce((t, o) => t + o.n, 0), sum = all.reduce((t, o) => t + o.sum, 0);
    if (!r0 && !r1 && !n) throw new Error("404 no ratings or reviews report in the bucket yet");
    prt = { ok: true, at: new Date().toISOString(), avg: avg ?? (n ? Math.round(sum / n * 100) / 100 : null), avgDay: avgDay || null, own: avg == null,
      n, txt: all.reduce((t, o) => t + o.txt, 0), last: all.reduce((t, o) => (o.last > t ? o.last : t), "") || null };
  } catch (e) { prt = keepGood(prt, String(e.message || e).slice(0, 160)); }
  return prt;
}

// GA4 counts days in the property's time zone; the screen assumes Israel, so the technical drawer shows it (Admin API, read-only, daily). Never throws.
let gaTz = null, gaTzAt = 0;
async function gaTimeZone(env) {
  if (sideFresh(gaTz, gaTzAt, 864e5)) return gaTz;
  gaTzAt = Date.now();
  try {
    const r = await fetch(`https://analyticsadmin.googleapis.com/v1beta/properties/${env.GA_PROPERTY_ID}`, { headers: { authorization: "Bearer " + await googleToken(env) }, signal: AbortSignal.timeout(SIDE_MS) });
    if (!r.ok) { const t = await r.text(); let m = t; try { m = JSON.parse(t).error.message || t; } catch {} gaTz = keepGood(gaTz, r.status + " " + String(m).replace(/\s+/g, " ").slice(0, 140)); }
    else gaTz = { ok: true, at: new Date().toISOString(), tz: (await r.json()).timeZone || "" };
  } catch (e) { gaTz = keepGood(gaTz, String(e.message || e).slice(0, 140)); }
  return gaTz;
}

const SC = "sc-domain:luchit.app";
let seo = null, seoAt = 0, seoTtl = 0;
async function collectSeo(env, today) {
  if (seo && Date.now() - seoAt < seoTtl) return { ...seo, cached: true };
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
  const fresh = { errors, range: w1, cur: cur ? tot(cur) : null, prev: prev ? tot(prev) : null, days: days ? days.map(r => [r.keys[0], r.clicks, r.impressions]).sort() : null,
    queries: queries ? queries.map(row) : null, pages: pages ? pages.map(row) : null,
    sitemaps: sm ? sm.map(x => ({ path: x.path, submitted: (x.contents || []).reduce((a, c) => a + Number(c.submitted || 0), 0), errors: Number(x.errors || 0), warnings: Number(x.warnings || 0), last: x.lastDownloaded || null })) : null };
  // a week with no clicks or views at all is an answer (zeros), not a missing number
  if (cur && !fresh.cur) fresh.cur = { clicks: 0, imps: 0, ctr: 0, pos: null };
  if (prev && !fresh.prev) fresh.prev = { clicks: 0, imps: 0, ctr: 0, pos: null };
  seo = keep(fresh, seo && seo.range && seo.range[1] === w1[1] ? seo : null, ["cur", "prev", "days", "queries", "pages", "sitemaps"]);
  seoAt = Date.now(); seoTtl = Object.keys(errors).length ? 60e3 : 1800e3; return seo;
}

// agent news for the flashes card: what .github/scripts/flash.mjs writes (branch "flashes", public-safe text), and every alert the router
// recorded as sent to Telegram (branch "alert-state": the key's fixed Hebrew headline he and section sc, never the message text). Most
// alerts go only through the router, so without it the card stopped at 16.10. A router alert of the same kind and the same weight (news, or
// a failure / a decision) within 10 minutes of a flash.mjs item is the same news and is left out. l: alert = a failure, wait = asks for the
// owner's decision, info = news only. How a problem ended is news, never an alert: "fixed" (closed by a check that passed, and told) is
// "✅ טופל", a self-repair (the "quiet" entry that closed its own item, outcome self) is "✅ תוקן לבד". q 1: a failure that needs no one's
// attention now (sent quietly, or closed since), so the attention list does not count it.
const RKIND = k => { const f = String(k).split(":")[0];
  return /^(review|review3|vitals|reviews)$/.test(f) ? "reviews" : /^(ship|listing|watch|safety|prod)$/.test(f) ? "release"
    : /^(guard|ministry|checker|truth|catalog|stl)$/.test(f) ? "data" : /^(seo|seo-auto|mention|mag)$/.test(f) ? "content" : "infra"; };
// shadow entries (sh 1): the caller sent as td says; routed ones: the router sent it (loud, at night, a reminder, quietly, or how it ended),
// or handed it back to the caller's own send
const RSENT = e => e.sh === 1 ? e.td !== "none" : ["loud", "night", "remind", "remind-night", "quiet", "fixed"].includes(e.a) || (["legacy", "failed"].includes(e.a) && e.td !== "none");
let flashes = null, flashesAt = 0, flRaw = [], stRaw = null;
async function getFlashes() {
  if (flashes && Date.now() - flashesAt < 300e3) return flashes;
  const get = async path => { try { const r = await fetch("https://raw.githubusercontent.com/ddsabag/vehicle-app/" + path, { cf: { cacheTtl: 120 }, signal: AbortSignal.timeout(8e3) }); return r.ok ? await r.json() : null; } catch { return null; } };
  const [fl, st] = await Promise.all([get("flashes/flashes.json"), get("alert-state/state.json")]);   // a failed read keeps the last good one
  if (Array.isArray(fl)) flRaw = fl;
  if (st && Array.isArray(st.log)) stRaw = st;
  const own = flRaw.filter(f => f && f.t && f.x), at = f => Date.parse(f.t);
  const routed = stRaw ? stRaw.log.filter(e => e && e.he && e.t && RSENT(e)).map(e => {
    const it = (stRaw.items || {})[e.k] || {}, u = it.u, link = Array.isArray(u) && typeof u[0] === "string" && u[0].startsWith("https://") ? u[0] : "";
    const done = e.a === "fixed" ? "✅ טופל: " : e.a === "quiet" && it.out === "self" && it.outAt === e.t ? "✅ תוקן לבד: " : "";
    const l = done ? "info" : e.sc === "fail" ? "alert" : e.sc === "wait" ? "wait" : "info";
    const q = l === "alert" && (e.a === "quiet" || (it.open === false && Date.parse(it.outAt) >= Date.parse(e.t)));
    return { t: e.t, k: RKIND(e.k), l, x: done + e.he, ...(q ? { q: 1 } : {}), ...(link ? { u: link } : {}) };
  }).filter(r => !own.some(f => f.k === r.k && (f.l === "info") === (r.l === "info") && Math.abs(at(f) - at(r)) < 600e3)) : [];
  flashes = [...own, ...routed].sort((a, b) => at(b) - at(a)).slice(0, 30);
  flashesAt = Date.now(); return flashes;
}

// the page gets the index numbers and the bots board (each scheduled workflow's latest run on main, from Live watch's bots-status.mjs)
const slimMetrics = m => { const x = m && m.index, b = m && m.bots;
  return { ...(x ? { index: { indexed: x.indexed, crawledNotIndexed: x.crawledNotIndexed, inspected: x.inspected, total: x.total, at: x.at } } : {}),
    ...(b && Array.isArray(b.list) ? { bots: { at: b.at, list: b.list.map(o => ({ n: o.n, f: o.f, p: o.p, c: o.c, t: o.t, u: o.u, run: o.run, he: o.he, w: o.w, s: o.s })) } } : {}) }; };
// aggregate numbers published by the workflows (branch "flashes", metrics.json), e.g. how many pages Google reports as indexed
let metrics = null, metricsAt = 0;
async function getMetrics() {
  if (metrics && Date.now() - metricsAt < 300e3) return metrics;
  try { const r = await fetch("https://raw.githubusercontent.com/ddsabag/vehicle-app/flashes/metrics.json", { cf: { cacheTtl: 120 } }); metrics = r.ok ? await r.json() : (metrics || {}); } catch { metrics = metrics || {}; }
  metricsAt = Date.now(); return metrics;
}

// what the bots changed by themselves (autopilot rules, strategy/autopilot-rules.md, Dudu 25.10): branch "autopilot", log.json, a mirror of
// the private change log with no numbers in it (autopilot-mirror.mjs in the project files masks them): each zone's mode and the latest rows
let auto = null, autoAt = 0;
async function getAuto() {
  if (auto && Date.now() - autoAt < 300e3) return auto;
  try { const r = await fetch("https://raw.githubusercontent.com/ddsabag/vehicle-app/autopilot/log.json", { cf: { cacheTtl: 120 }, signal: AbortSignal.timeout(8e3) }); if (r.ok) auto = await r.json(); } catch {}
  autoAt = Date.now(); return auto;
}
// what is planned ahead (Dudu 26.10: "יומן בדשבורד לייב עם דברים מתוכננים קדימה"): branch "calendar", calendar.json, written every morning by
// the measurement thread from the scheduled tasks and the thread capsules (no numbers in it): dated items, open items with no date, and the
// recurring ones; "me" marks what needs Dudu. The page hides dated items that already passed, so a late refresh never shows the past as ahead
let cal = null, calAt = 0;
async function getCal() {
  if (cal && Date.now() - calAt < 300e3) return cal;
  try { const r = await fetch("https://raw.githubusercontent.com/ddsabag/vehicle-app/calendar/calendar.json", { cf: { cacheTtl: 120 }, signal: AbortSignal.timeout(8e3) }); if (r.ok) cal = await r.json(); } catch {}
  calAt = Date.now(); return cal;
}
const cut = (x, k) => String(x || "").slice(0, k);
const calId = x => /^[a-z0-9-]{1,60}$/.test(x || "") ? x : "";
// "בוצע" marks Dudu sets on the page (POST /live/cal, behind the same Access check): Workers KV luchit-alerts, key lv:cal:done = { id: time }.
// Live watch copies the ids to metrics.json (calDone) so the measurement thread's morning refresh takes them off the calendar for good
const CAL_KEY = "lv:cal:done";
async function calDone(env) { try { return (env.ALERTS && await env.ALERTS.get(CAL_KEY, "json")) || {}; } catch { return {}; } }
async function calMark(req, env) {
  let b = null; try { b = await req.json(); } catch {}
  const id = calId(b && b.id); if (!id || !env.ALERTS) return json({ ok: false }, 400);
  const m = await calDone(env);
  if (b.done) m[id] = new Date().toISOString(); else delete m[id];
  const keys = Object.keys(m).sort((x, y) => m[y].localeCompare(m[x])).slice(0, 300), out = Object.fromEntries(keys.map(k => [k, m[k]]));
  await env.ALERTS.put(CAL_KEY, JSON.stringify(out));
  return json({ ok: true, done: out });
}
// decisions Dudu answers on the page (POST /live/act, behind the same Access check): Workers KV luchit-alerts, key lv:act = { id: { c: the option pressed, at } }.
// Live watch copies it to the public board (metrics.json "acts") and the done-marks task relays each answer to the thread that owns the item
const ACT_KEY = "lv:act";
async function actsGet(env) { try { return (env.ALERTS && await env.ALERTS.get(ACT_KEY, "json")) || {}; } catch { return {}; } }
async function actMark(req, env) {
  let b = null; try { b = await req.json(); } catch {}
  const id = calId(b && b.id); if (!id || !env.ALERTS) return json({ ok: false }, 400);
  const m = await actsGet(env);
  if (b.undo) delete m[id]; else { const c = cut(b.c, 40).trim(); if (!c) return json({ ok: false }, 400); m[id] = { c, at: new Date().toISOString() }; }
  const keys = Object.keys(m).sort((x, y) => String(m[y].at).localeCompare(String(m[x].at))).slice(0, 300), out = Object.fromEntries(keys.map(k => [k, m[k]]));
  await env.ALERTS.put(ACT_KEY, JSON.stringify(out));
  return json({ ok: true, acts: out });
}
const optsOf = a => Array.isArray(a) ? a.slice(0, 4).map(x => cut(x, 40)).filter(Boolean) : undefined;   // a decision item's own answers, when the calendar gives them
const slimCal = c => c && typeof c === "object" ? { at: c.at,
  open: (Array.isArray(c.open) ? c.open : []).slice(0, 20).map(o => ({ id: calId(o.id), what: cut(o.what, 200), owner: cut(o.owner, 40), me: o.me ? 1 : 0, ask: cut(o.ask, 200), opts: optsOf(o.opts) })),
  items: (Array.isArray(c.items) ? c.items : []).filter(o => /^\d{4}-\d\d-\d\d$/.test(o.d || "")).slice(0, 80).map(o => ({ id: calId(o.id), d: o.d, t: /^\d\d:\d\d$/.test(o.t || "") ? o.t : "", what: cut(o.what, 200), owner: cut(o.owner, 40), me: o.me ? 1 : 0, ask: cut(o.ask, 200), opts: optsOf(o.opts) })),
  weekly: (Array.isArray(c.weekly) ? c.weekly : []).slice(0, 12).map(o => ({ when: cut(o.when, 60), what: cut(o.what, 200), owner: cut(o.owner, 40) })),
  // the publishing board, rebuilt by the calendar bot from the autopost queue, the magazine's crons and the Cowork rules (Dudu 5.11.2026)
  pubs: (Array.isArray(c.pubs) ? c.pubs : []).filter(o => /^\d{4}-\d\d-\d\d$/.test(o.d || "") && /^\d\d:\d\d$/.test(o.t || "")).slice(0, 80).map(o => ({ d: o.d, t: o.t,
    ch: (Array.isArray(o.ch) ? o.ch : []).filter(x => /^[a-z_]{2,20}$/.test(x)).slice(0, 4), what: cut(o.what, 120), src: /^(auto|mag|cowork)$/.test(o.src) ? o.src : "",
    st: Object.fromEntries(Object.entries(o.st && typeof o.st === "object" ? o.st : {}).filter(([k, v]) => /^[a-z_]{2,20}$/.test(k) && /^(done|missed|failed|unsure|planned|wait)$/.test(v)).slice(0, 4)),
    link: Object.fromEntries(Object.entries(o.link && typeof o.link === "object" ? o.link : {}).filter(([k, v]) => /^[a-z_]{2,20}$/.test(k) && /^https:\/\/(www\.)?(facebook|instagram|tiktok)\.com\/[\w\/.?=&%-]{1,200}$/.test(v)).slice(0, 4)) })) } : null;
const slimAuto = a => a && typeof a === "object" ? { at: a.at, modes: a.modes || {}, rows: (Array.isArray(a.rows) ? a.rows : []).slice(0, 20).map(r => ({ d: r.d, z: r.z, m: r.m, x: String(r.x || "").slice(0, 240), r: r.r })) } : null;

// today's car checks and new installs as seen in realtime, minute by minute: realtime covers only the last 30 minutes, so each request keeps
// what it saw and today's count only grows, until GA4's own report for today arrives hours later. Kept twice: this data centre's cache (every
// request) and Workers KV (luchit-alerts, key "lv:rt:<day>", one copy for every data centre, written when it changed and at most every 5
// minutes). On 20.10 the cache alone lost the day's count while the screen was closed for an hour (Cloudflare may drop a cached item nobody
// reads) and installed-now fell from 227 to 120. Minutes older than the realtime window keep the larger count of the two copies; the last 30
// minutes are always realtime's own. A failed realtime call still answers with what was kept.
const RT_KEYS = ["first_open", "car_lookup"], RT_KV_EVERY = 300e3;
async function rtToday(env, today) {
  const t1 = Date.now(), key = "https://luchit.app/live/_rt/" + today, kvKey = "lv:rt:" + today;
  let failed = null;
  const [rows, local, kept] = await Promise.all([
    realtime(env, { dimensions: [{ name: "minutesAgo" }, { name: "eventName" }], metrics: [{ name: "eventCount" }],
      dimensionFilter: { andGroup: { expressions: [REAL, { filter: { fieldName: "eventName", inListFilter: { values: RT_KEYS } } }] } }, limit: 200 }).catch(e => { failed = e; return null; }),
    caches.default.match(key).then(r => (r ? r.json() : null)).catch(() => null),
    env.ALERTS ? env.ALERTS.get(kvKey, "json").catch(() => null) : null]);
  const now = Math.floor(Date.now() / 6e4), seen = {};
  for (const src of [local, kept && kept.m]) for (const [m, v] of Object.entries(src || {})) { const s = (seen[m] ||= [0, 0]); RT_KEYS.forEach((_, i) => { s[i] = Math.max(s[i], Number(v[i]) || 0); }); }
  // a call that crossed a minute boundary cannot tell which minute "00" was, so it only reads what was kept
  if (rows && Math.floor(t1 / 6e4) === now) {
    for (let a = 0; a < 30; a++) delete seen[now - a];
    for (const r of rows) {
      const m = now - Number(r.dimensionValues[0].value), i = RT_KEYS.indexOf(r.dimensionValues[1].value);
      if (i >= 0 && ilDay(m * 6e4) === today) (seen[m] ||= [0, 0])[i] += Number(r.metricValues[0].value);
    }
    const body = JSON.stringify(seen);
    try { await caches.default.put(key, new Response(body, { headers: { "content-type": "application/json", "cache-control": "max-age=172800" } })); } catch {}
    if (env.ALERTS && body !== JSON.stringify((kept && kept.m) || {}) && !(kept && Date.now() - kept.at < RT_KV_EVERY))
      await Promise.race([env.ALERTS.put(kvKey, JSON.stringify({ at: Date.now(), m: seen }), { expirationTtl: 172800 }), new Promise(r => setTimeout(r, 3e3))]).catch(() => {});
  }
  if (failed && !Object.keys(seen).length) throw failed;
  const o = {}; RT_KEYS.forEach((k, i) => { o[k] = Object.values(seen).reduce((t, v) => t + v[i], 0); }); return o;
}

// yesterday's tally as kept in KV: GA4's report of yesterday is still incomplete for hours after midnight (on 21.10 it read 44 first opens
// of 19.10 at night and 63 the next morning), so yesterday counts at least what realtime saw. Read at most every 5 minutes.
let rtY = null, rtYAt = 0, rtYDay = "";
async function rtKept(env, day) {
  if (rtY && rtYDay === day && Date.now() - rtYAt < 300e3) return rtY;
  const kept = env.ALERTS ? await env.ALERTS.get("lv:rt:" + day, "json") : null;
  const o = {}; RT_KEYS.forEach((k, i) => { o[k] = Object.values((kept && kept.m) || {}).reduce((t, v) => t + (Number(v[i]) || 0), 0); });
  rtY = o; rtYAt = Date.now(); rtYDay = day; return o;
}

let cache = null, cacheAt = 0, backoffUntil = 0;
// who is on right now: the last 5 minutes (Dudu 2.11), the top line of the page. The page asks /live/now every 30 seconds on its own (the
// rest of the page every minute), so this keeps its answer only 20 seconds, and after a Google quota error answers with the last one.
let onl = null, onlAt = 0;
async function onlineNow(env) {
  if (onl && (Date.now() - onlAt < 20e3 || Date.now() < backoffUntil)) return onl;
  const rows = await realtime(env, { dimensions: [{ name: "platform" }], metrics: [{ name: "activeUsers" }], dimensionFilter: REAL, minuteRanges: [{ startMinutesAgo: 4, endMinutesAgo: 0 }] });
  const sum = k => rows.filter(r => r.dimensionValues[0].value === k).reduce((t, r) => t + Number(r.metricValues[0].value || 0), 0);
  onl = { app: sum("Android"), web: sum("web") }; onlAt = Date.now(); return onl;
}
async function collect(env) {
  // GA4 realtime has an hourly token quota: answer from cache for a minute, and after a 429 stop asking for 5 minutes (serve the last good numbers)
  if (cache && (Date.now() - cacheAt < 60e3 || Date.now() < backoffUntil)) return cache;
  const today = ilDay(Date.now()), yday = addDays(today, -1);
  const errors = {};
  const safe = (p, k) => p.catch(e => { errors[k] = String(e.message || e).slice(0, 200); return null; });
  // a Worker request may make only 50 outside calls: get the token once, before the parallel calls, or each of them fetches its own
  await googleToken(env).catch(() => {});
  // realtime: events, and active users by platform (the app's devices in Israel, and the site, where every opening of the page is its own "user")
  const [events, plats, online, vToday, vYday, dly, sc, wk, ps, rt, rty] = await Promise.all([
    safe(realtime(env, { dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: REAL, limit: 40 }), "events"),
    safe(realtime(env, { dimensions: [{ name: "platform" }], metrics: [{ name: "activeUsers" }], dimensionFilter: REAL }), "platforms"),
    safe(onlineNow(env), "online"),
    safe(cfVisits(env, today), "visitsToday"), safe(cfVisits(env, yday), "visitsYesterday"), safe(collectDaily(env), "daily"), safe(collectSeo(env, today), "seo"),
    safe(collectWeekly(env, today), "weekly"), playStatus(), safe(rtToday(env, today), "today"), safe(rtKept(env, yday), "yesterday tally")]);
  // the side Google sources (cached for hours, so usually no call at all) go after the GA4 batch: started with it, they waited for one of the
  // 6 connections a Worker opens at a time and ran out of time without the source being slow (26.10)
  const [rl, pls, tz, rat] = await Promise.all([playRelease(env), playStats(env, today), gaTimeZone(env), playRatings(env, today)]);
  // a quota error counts only when this request's own calls met it, not one a collector remembers from an earlier request
  const own = { ...errors, ...(dly && !dly.cached ? dly.errors : {}), ...(sc && !sc.cached ? sc.errors : {}), ...(wk && !wk.cached ? wk.errors : {}) };
  Object.assign(errors, dly?.errors || {}, sc?.errors || {}, wk?.errors || {});
  const quota = Object.values(own).some(m => /429|quota|Exhausted/i.test(m));
  if (quota) backoffUntil = Date.now() + 300e3;
  const prev = cache || {};
  const plat = k => plats ? plats.filter(r => r.dimensionValues[0].value === k).reduce((t, r) => t + Number(r.metricValues[0].value || 0), 0) : (quota ? prev.activeUsers ?? null : null);
  const strip = o => { if (!o) return null; const { errors: _e, cached: _c, ...rest } = o; return rest; };
  cache = { build: BUILD, errors: quota ? { ga4: "מכסת Google מלאה, מוצגים נתונים אחרונים ויתעדכנו בעוד כמה דקות", ...errors } : errors, stale: quota, at: quota && prev.at ? prev.at : new Date().toISOString(),
    activeUsers: plat("Android"),
    online: online ?? (quota ? prev.online ?? null : null),
    events: events ? events.map(r => [r.dimensionValues[0].value, Number(r.metricValues[0].value)]).sort((a, b) => b[1] - a[1]) : (quota ? prev.events ?? null : null),
    rtToday: rt ?? (quota ? prev.rtToday ?? null : null), rtYday: rty ?? prev.rtYday ?? null, visitsToday: vToday?.visits ?? null, visitsYesterday: vYday?.visits ?? null,
    // a collector that failed as a whole (no token) falls back to the last numbers it had; each carries its own dates
    seo: strip(sc || seo), daily: strip(dly || daily), weekly: strip(wk || weekly), play: ps, playAt: playSeen, release: rl, stats: pls, rating: rat, gaTz: tz };
  cacheAt = Date.now(); return cache;
}

const PAGE = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><link rel="icon" type="image/png" href="https://luchit.app/icon-192.png"><link rel="apple-touch-icon" href="https://luchit.app/apple-touch-icon.png"><title>לוחית, מצב העסק</title>
<style>
:root{--app:#2f5bb7;--site:#93acdf;--prev:#c5cbd5;--c-social:#eb6834;--c-search:#1baf7a;--c-direct:#eda100;--c-share:#e87ba4;--c-site:#6250d6;--c-other:#a3aab5;--bg:#f5f6f8;--card:#fff;--fg:#141922;--muted:#5b6474;--line:#e2e6ec;--soft:#f1f3f6;--accent:#2f5bb7;--ok:#1d7a4c;--ok-bg:#e7f3ec;--warn:#985a00;--warn-bg:#fbf0de;--bad:#ad2f29;--bad-bg:#fbe9e8;--nt:#626b7b;--nt-bg:#eef0f3}
@media(prefers-color-scheme:dark){:root{--app:#8fadf2;--site:#4a6299;--prev:#4a5363;--c-social:#d95926;--c-search:#199e70;--c-direct:#c98500;--c-share:#d55181;--c-site:#9085e9;--c-other:#6b7484;--bg:#0f131a;--card:#171c25;--fg:#e8ecf2;--muted:#a0a9b8;--line:#283142;--soft:#1d2330;--accent:#8fadf2;--ok:#6fcb97;--ok-bg:#15281e;--warn:#e3a957;--warn-bg:#2b2316;--bad:#f2908a;--bad-bg:#2f1c1c;--nt:#a0a9b8;--nt-bg:#222a36}}
*{box-sizing:border-box}html{direction:rtl}body{margin:0;background:var(--bg);color:var(--fg);font-family:Arial,"Arial Hebrew","Liberation Sans",Helvetica,sans-serif;font-variant-numeric:tabular-nums;line-height:1.5;text-align:right}
main{max-width:1280px;margin:0 auto;padding:20px 24px 32px}h1,h2,h3,p{margin:0}a{color:var(--accent)}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}.brand{display:flex;align-items:center;gap:10px}.brand img{width:36px;height:36px;border-radius:9px;display:block}.brand h1{font-size:1.15rem}
.onl{display:flex;align-items:center;gap:6px 14px;flex-wrap:wrap;font-size:.86rem;color:var(--muted);margin:-8px 0 14px}.onl b{color:var(--fg);font-size:1rem}.onl .pd{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--ok)}
.meta{font-size:.82rem;color:var(--muted)}.meta .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--nt);margin-inline-end:6px;vertical-align:middle}.meta.stale{color:var(--warn)}.meta.stale .dot{background:var(--warn)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;min-width:0}
h2{font-size:.95rem;font-weight:700;margin-bottom:10px}
.s-ok{--s:var(--ok);--sb:var(--ok-bg)}.s-warn{--s:var(--warn);--sb:var(--warn-bg)}.s-bad{--s:var(--bad);--sb:var(--bad-bg)}.s-early,.s-nodata,.s-cal,.s-wait{--s:var(--nt);--sb:var(--nt-bg)}
.cal{margin-top:14px}.cal>details>summary{list-style:none;cursor:pointer}.cal>details>summary::-webkit-details-marker{display:none}
.calh{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}.calh .ct2{font-size:1.05rem;font-weight:700}.calh .ct2::before{content:"▾ ";color:var(--muted)}.cal details:not([open]) .ct2::before{content:"◂ "}
.cal .tks{list-style:none;margin:10px 0 0;padding:0}
.cal .tk{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:10px 0;border-top:1px solid var(--line)}.cal .tk:first-child{border-top:0}
.cal .tw{min-width:0;display:grid;gap:2px}.cal .tw b{font-weight:600}.cal .ca{font-size:.84rem}.cal .co{font-size:.78rem;color:var(--muted)}.cal .due{color:var(--warn);font-weight:700}
.cal .tb{display:flex;gap:10px;align-items:center;flex:none}.cal .okb{font:inherit;font-size:.82rem;font-weight:600;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:4px 12px;cursor:pointer}.cal .okb:hover{border-color:var(--app)}
.cal .tb a{font-size:.82rem}.cal .bl{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:6px;font-size:.84rem}.cal .bl li>span:first-child{color:var(--muted);margin-inline-end:8px}
.cal .un{font:inherit;font-size:.76rem;border:0;background:none;color:var(--app);cursor:pointer;text-decoration:underline}
.chip{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;font-size:.76rem;font-weight:600;color:var(--s);background:var(--sb);border-radius:999px;padding:2px 10px 2px 9px}.chip i{font-style:normal;font-weight:700}
.r1{display:grid;grid-template-columns:2fr 1fr;gap:14px}
.verdict{border-inline-start:5px solid var(--s)}.verdict .vh{display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap}.verdict .vh span.lbl{font-size:.8rem;color:var(--muted)}
.verdict .vs{font-size:1.3rem;font-weight:600;line-height:1.55}.verdict .vn{font-size:.8rem;color:var(--muted);margin-top:10px}
.att ol{margin:0;padding:0;list-style:none;display:grid;gap:8px}.att li{display:flex;gap:8px;align-items:flex-start;font-size:.9rem}.att li .chip{flex:none}.att .none{color:var(--muted);font-size:.88rem}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:14px;padding:0}
.kpi{padding:16px 18px;display:flex;flex-direction:column;gap:6px;min-width:0;border-inline-start:1px solid var(--line)}.kpi:first-child{border-inline-start:0}
.kpi .kh{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}.kpi h3{font-size:.88rem;font-weight:600;color:var(--muted)}.more{display:none}h3 .win{display:block;font-size:.72rem;font-weight:400;color:var(--muted);margin-top:1px}
.kpi .big{font-size:2.5rem;font-weight:700;line-height:1.1;margin-top:2px;font-variant-numeric:proportional-nums}.kpi .big small{font-size:.9rem;font-weight:500;color:var(--muted);margin-inline-start:6px}
.kpi .dl{font-size:.84rem;min-height:1.3em}.kpi p.m{font-size:.8rem;color:var(--muted)}.kpi p.m b{color:var(--fg)}.kpi .foot{margin-top:auto;padding-top:6px;font-size:.72rem;color:var(--muted)}
.gb{height:6px;background:var(--soft);border-radius:999px;overflow:hidden;margin-top:2px}.gb i{display:block;height:100%;background:var(--s);border-radius:999px}.s-cal .gb i,.s-early .gb i{background:var(--app)}
.sp{display:block;width:100%;height:38px;margin-top:4px}.sp rect{fill:var(--app);opacity:.32}.sp rect.last{opacity:1}
.sec{font-size:1.05rem;font-weight:700;margin:28px 0 10px}
.g2{display:grid;grid-template-columns:3fr 2fr;gap:14px;margin-top:14px}.g2b{grid-template-columns:1fr 1fr}
.ct{font-size:.98rem;font-weight:700}.cs{font-size:.84rem;color:var(--muted);margin:2px 0 10px}.cs b{color:var(--fg)}
.lg{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:.78rem;color:var(--muted);margin-bottom:6px}.lg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-inline-end:5px;vertical-align:-1px}
.lg i.la{background:var(--app)}.lg i.ls{background:var(--site)}.lg i.lp{background:var(--prev)}.lg i.lgo{height:0;border-top:2px dashed var(--muted);border-radius:0;vertical-align:3px}
.hero svg{width:100%;height:auto;display:block}.t-app{fill:var(--app)}.t-site{fill:var(--site)}
.dn{display:grid;grid-template-columns:150px 1fr;gap:16px;align-items:center}.dn svg{width:150px;height:150px;display:block}.d-big{font-size:26px;font-weight:700;fill:var(--fg)}.d-lbl{font-size:11px;fill:var(--muted)}
.d-social{stroke:var(--c-social)}.d-search{stroke:var(--c-search)}.d-direct{stroke:var(--c-direct)}.d-share{stroke:var(--c-share)}.d-site{stroke:var(--c-site)}.d-other{stroke:var(--c-other)}
.sw{display:inline-block;width:10px;height:10px;border-radius:3px;margin-inline-end:6px;vertical-align:-1px}.sw-social{background:var(--c-social)}.sw-search{background:var(--c-search)}.sw-direct{background:var(--c-direct)}.sw-share{background:var(--c-share)}.sw-site{background:var(--c-site)}.sw-other{background:var(--c-other)}
.cmr{display:grid;grid-template-columns:7.5rem 1fr 4.2rem;gap:4px 10px;align-items:center;padding:7px 0;border-top:1px solid var(--line);font-size:.86rem}.cmr:first-of-type{border-top:0}
.cmr .bb{display:grid;gap:3px}.cmr .bb i{display:block;height:9px;border-radius:3px;min-width:2px}.cmr .bb i.c{background:var(--app)}.cmr .bb i.p{background:var(--prev)}.cmr .nn{font-size:.74rem;color:var(--muted);grid-column:2}.cmr .pc{text-align:left;font-weight:600;white-space:nowrap}
.dm{padding:8px 0;border-top:1px solid var(--line)}.dm:first-child{border-top:0;padding-top:0}.dmh{display:flex;justify-content:space-between;gap:10px;font-size:.84rem;margin-bottom:4px}.dmh span{color:var(--muted);font-size:.78rem}
.dm .spark rect{fill:var(--app);opacity:.75}
.hl{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));padding:0}.hc{padding:16px 18px;border-inline-start:1px solid var(--line);display:flex;flex-direction:column;gap:5px;min-width:0}.hc:first-child{border-inline-start:0}
.hc h3{font-size:.88rem;font-weight:600;color:var(--muted);display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap}.hc .big{font-size:2rem;font-weight:700;line-height:1.15;font-variant-numeric:proportional-nums}.hc p{font-size:.8rem;color:var(--muted)}.hc p b{color:var(--fg)}
.dots{display:flex;flex-wrap:wrap;gap:5px;margin-top:4px}.dots a,.dots span{width:12px;height:12px;border-radius:50%;background:var(--s);display:block}.dots .s-bad,.dots .s-warn{width:15px;height:15px;color:var(--card);font-size:10px;font-weight:700;line-height:15px;text-align:center;margin-top:-1.5px}
.drs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;align-items:start}.grp{padding:6px 16px}.grp>h3{font-size:.8rem;color:var(--muted);font-weight:600;margin:10px 0 2px}
.grp details.dr{border-top:1px solid var(--line);padding:12px 0}.grp h3+details.dr{border-top:0}
.mini{display:inline-flex;align-items:center;gap:4px;font-size:.74rem;font-weight:600;color:var(--s)}
.up{color:var(--ok)}.down{color:var(--bad)}.flat{color:var(--muted)}.evmore{margin:6px 0 0}.evmore summary{color:var(--accent,var(--muted));font-size:.85rem;justify-content:flex-start;margin:0 0 4px}
.ms{list-style:none;margin:0;padding:0;display:grid;gap:14px}.ms li{display:grid;gap:4px}.ms .k{font-size:.8rem;color:var(--muted)}.ms .v{font-size:.95rem;font-weight:600}
.bar{height:8px;background:var(--soft);border-radius:999px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent);border-radius:999px}
.trend svg{width:100%;height:auto;display:block}.trend .t-lbl{fill:var(--muted);font-size:12px}.trend .t-val{fill:var(--fg);font-size:13px;font-weight:600}.trend .t-bar{fill:var(--accent);opacity:.85}.trend .t-goal{stroke:var(--muted);stroke-width:1.5;stroke-dasharray:4 3}.trend .t-mark{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3}.trend .t-base{stroke:var(--line)}
.note{font-size:.78rem;color:var(--muted);margin-top:8px}
details.dr>summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:10px}details.dr>summary::-webkit-details-marker{display:none}
details.dr>summary b{font-size:.95rem}details.dr>summary span{font-size:.8rem;color:var(--muted);flex:1}details.dr>summary:after{content:"▾";color:var(--muted);transition:transform .2s}details.dr[open]>summary:after{transform:rotate(180deg)}
details.dr[open]>summary{margin-bottom:12px}.dr h4{font-size:.85rem;margin:14px 0 6px}.dr h4:first-of-type{margin-top:0}
table.t{width:100%;border-collapse:collapse;font-size:.86rem}.t th{font-weight:500;color:var(--muted);font-size:.74rem;text-align:right;padding:2px 6px 5px}.t td{text-align:right;padding:6px;border-top:1px solid var(--line);vertical-align:top}.t td.n,.t th.n{width:5.5rem;font-variant-numeric:tabular-nums;white-space:nowrap}.t td.w{word-break:break-word}.tg td.n,.tg th.n{width:auto}.tg th.n{white-space:normal}.tg td.w{min-width:8.5rem;word-break:normal}
.kv{list-style:none;margin:0;padding:0}.kv li{display:grid;grid-template-columns:1fr auto;gap:10px;padding:6px 0;border-top:1px solid var(--line);font-size:.86rem}.kv li:first-child{border-top:0}.kv b{font-variant-numeric:tabular-nums;text-align:right}.kv small{display:block;color:var(--muted);font-size:.74rem}.pg small{display:block;color:var(--muted);font-size:.74rem;font-weight:400}.t small{font-size:.74rem}
.fl li{grid-template-columns:auto 1fr}.fl .ft{font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}.fl .lv{color:var(--muted)}.fl .lv.alert{color:var(--bad)}.fl small{white-space:nowrap}
.spark{display:block;width:100%;height:auto}.spark rect{fill:var(--accent);opacity:.8}.axis{display:flex;justify-content:space-between;direction:ltr;font-size:.72rem;color:var(--muted);margin-top:2px}
.foot{font-size:.76rem;color:var(--muted);margin-top:16px}#er{color:var(--bad);margin-top:6px}
.hdr{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.hb{font:inherit;font-size:.78rem;font-weight:600;color:var(--accent);background:none;border:1px solid var(--line);border-radius:999px;padding:3px 11px;cursor:pointer}body.hp .hb{background:var(--accent);color:#fff;border-color:var(--accent)}
.help{display:none;font-size:.8rem;color:var(--muted);background:var(--soft);border-radius:8px;padding:8px 11px;margin:10px 0 0;line-height:1.5}body.hp .help{display:block}.help b{color:var(--fg)}#leg{margin:0 0 14px}#leg .chip{margin-inline-end:2px;vertical-align:middle}
.verdict .vt{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:.84rem;margin-top:10px;padding-top:8px;border-top:1px solid var(--line)}.verdict .vt:empty{display:none}
details.dr{scroll-margin-top:14px}details.dr.hit>summary b{color:var(--accent)}.hit{animation:hit 1.6s ease-out}@keyframes hit{0%{background:var(--warn-bg)}100%{background:transparent}}
.fn2{display:grid;grid-template-columns:1fr 1fr;gap:10px 28px;margin-top:4px}.fn h4{font-size:.88rem;margin:0 0 4px}.fr{display:grid;grid-template-columns:9rem 1fr 4rem;gap:2px 10px;align-items:center;font-size:.86rem;padding:5px 0}.fr .fb{display:grid;gap:3px}.fr .fb i{display:block;height:10px;border-radius:3px;min-width:2px}.fr .fb i.c{background:var(--app)}.fr .fb i.p{background:var(--prev);height:5px}.fr .pc{text-align:left;font-weight:600;white-space:nowrap}.fr .nn{grid-column:2/4;font-size:.74rem;color:var(--muted)}
.fs{font-size:.76rem;color:var(--muted);margin-inline-start:9rem;display:flex;gap:6px;align-items:center}.fs i{font-style:normal}
tr[data-ev]{cursor:pointer}tr.skr td{padding:2px 6px 8px;border-top:0}.skr rect.t-app{fill:var(--app)}.skr rect.t-site{fill:var(--site)}tr.skr small{display:block;color:var(--muted);font-size:.74rem;margin-top:2px}
@media(max-width:1023px){.r1,.g2,.fn2{grid-template-columns:1fr}.kpis,.hl{grid-template-columns:repeat(2,minmax(0,1fr))}.kpi:nth-child(3),.hc:nth-child(odd){border-inline-start:0}.kpi:nth-child(n+3),.hc:nth-child(n+3){border-top:1px solid var(--line)}.hc:nth-child(5){grid-column:1/-1}.drs{grid-template-columns:1fr}}
@media(max-width:560px){.cal .tk{flex-direction:column}.cal .tb{align-self:flex-start}main{padding:14px 12px 24px}.t td.n,.t th.n{width:3.4rem}.kpi,.hc{padding:12px}.kpi .big{font-size:1.8rem}.hc .big{font-size:1.6rem}.kpi .kh{flex-direction:column;gap:4px}.hc h3{flex-direction:column;gap:4px}.kpi .sp,.kpi p.m,.kpi .foot,.hc p{display:none}.kpi.open .sp,.kpi.open p.m,.kpi.open .foot,.hc.open p{display:block}.kpi.open,.hc.open{grid-column:1/-1}.kpi,.hc{cursor:pointer}.kpi .more,.hc .more{display:block;font-size:.72rem;color:var(--accent);margin-top:2px}.kpi.open .more,.hc.open .more{display:none}.verdict .vs{font-size:1.12rem}.dn{grid-template-columns:1fr;justify-items:center}.dn table{justify-self:stretch}.cmr{grid-template-columns:6rem 1fr 3.6rem}.fr{grid-template-columns:6.8rem 1fr 3.4rem}.fs{margin-inline-start:6.8rem}body.hp .kpi .help,body.hp .hc .help{display:none}body.hp .kpi.open .help,body.hp .hc.open .help{display:block}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
@media print{details.dr{display:none}body{background:#fff}}
</style></head><body><main>
<header class="top"><div class="brand"><img src="https://luchit.app/icon-192.png" alt="" width="36" height="36"><h1>לוחית · מצב העסק</h1></div><div class="hdr"><button class="hb" id="hb" type="button" aria-pressed="false">הסבר</button><p class="meta" id="meta"><span class="dot"></span>טוען</p></div></header>
<p class="onl" id="onl" hidden></p>
<p class="help" id="leg"><b>מצב הסבר.</b> לכל כרטיס מצורף הסבר קצר: מה המספר אומר, מאיפה הוא מגיע ומה עושים איתו. הסימונים: <span class="chip s-ok"><i>✓</i>תקין</span> ביעד או מעליו · <span class="chip s-warn"><i>!</i>דורש תשומת לב</span> קצת מתחת ליעד · <span class="chip s-bad"><i>✕</i>מתחת ליעד</span> · <span class="chip s-early"><i>◷</i>מוקדם לשפוט</span> · <span class="chip s-nodata"><i>?</i>אין נתון</span>. «לפירוט» ליד מספר פותח את המגירה שלו בתחתית הדף, ובה המספרים שמאחוריו. הכפתור «הסבר» למעלה מכבה את ההסברים, והבחירה נשמרת.</p>

<section class="r1">
<div class="card verdict s-cal" id="vd"><div class="vh" id="vh"><span class="lbl">השורה התחתונה</span></div><p class="vs" id="vs">טוען את הנתונים</p><p class="vn" id="vn"></p><p class="vt" id="vt"></p><p class="help">השורה התחתונה מסכמת את השבוע שהסתיים אתמול: בדיקות רכב מול היעד, הדבר הראשון לטפל בו, ותקינות השירות. הצבע הוא החמור מבין המדדים שנשפטים (עד שבוע הבסיס: רק תקינות השירות, דפים בגוגל והחנות). מתחתיה מה קרה היום עד עכשיו, בזמן אמת.</p></div>
<div class="card att"><h2>דורש תשומת לב</h2><ol id="att"><li class="none">טוען</li></ol><p class="help">כל מדד שאינו תקין, מהחמור לקל: אדום לפני צהוב, ומי שרחוק יותר מהיעד קודם. עד ארבעה פריטים, ואחריהם ההתראות מטלגרם ביממה האחרונה. רשימה ריקה פירושה שאין מה לטפל בו.</p></div>
</section>

<section class="card kpis" id="tiles" aria-label="ארבעת המדדים הראשיים"></section>

<section class="card cal" id="cal" aria-label="המשימות שלך והיומן"><details id="calx" open><summary><span class="calh"><span class="ct2">המשימות שלך והיומן</span><span class="cs" id="cals">טוען</span></span></summary><div id="calb"></div><p class="help">למעלה: מה מחכה לפעולה או להחלטה שלך, מהדחוף ועד מה שבהמשך. «בוצע» מוריד משימה מהרשימה ומעדכן גם את Claude. «ליומן» מוסיף אותה ליומן Google שלך. למטה, מקופל: מה הבוטים עושים לבד, ומה קורה כל שבוע. הרשימה מתעדכנת לבד כל בוקר, וכל משימה נבדקת לפני שהיא נרשמת.</p></details></section>

<h2 class="sec">צמיחה</h2>
<section class="g2">
<div class="card hero trend"><h3 class="ct">בדיקות רכב בשבוע</h3><p class="cs" id="trs"></p><div class="lg"><span><i class="la"></i>באפליקציה</span><span><i class="ls"></i>באתר</span><span><i class="lgo"></i>היעד השבועי</span></div><div id="tr"></div><p class="note" id="trn"></p><p class="help">כל עמודה היא שבוע שלם, מהישן (משמאל) לחדש (מימין). החלק הכהה הוא האפליקציה והבהיר האתר, והקו המקווקו הוא היעד של אותו שבוע. מגמה עולה שבוע אחרי שבוע חשובה יותר מכל מספר בודד.</p></div>
<div class="card"><h3 class="ct">מאיפה הגיעו הבדיקות באתר</h3><p class="cs" id="dns"></p><div id="dn"></div><p class="help">רק הבדיקות שנעשו באתר (לפתיחה של האפליקציה אין מקור), לפי מאיפה הגיע מי שבדק: הרשתות והקישורים שלנו, חיפוש בגוגל, ישיר, דוחות ששותפו, דפים אחרים באתר ואתרים אחרים. ככל שהחלק של החיפוש והשיתופים גדל, הצמיחה תלויה פחות בפוסטים.</p></div>
</section>
<section class="g2 g2b">
<div class="card"><h3 class="ct">השבוע מול השבוע הקודם</h3><p class="cs" id="cms"></p><div class="lg"><span><i class="la"></i>השבוע</span><span><i class="lp"></i>שבוע קודם</span></div><div id="cm"></div><p class="help">חמש הפעולות העיקריות, השבוע מול השבוע שלפניו, כל פעולה על הסולם שלה. אחוז השינוי משמאל. מספרים קטנים משתנים הרבה בלי סיבה אמיתית: שינוי של עשרות אחוזים על עשרות בודדות הוא לרוב רעש. כל פעולה שנספרה, במגירה «שימוש».</p></div>
<div class="card"><h3 class="ct">יום אחרי יום, 4 שבועות</h3><p class="cs">כל עמודה היא יום. העמודה הימנית ביותר היא אתמול.</p><div id="dl"></div><p class="help">28 הימים האחרונים, יום אחרי יום, לשלושה מדדים. כאן רואים יום חריג (פוסט שהצליח, או תקלה) ואת ההבדל בין ימי חול לסופי שבוע. כל פעולה אחרת, יום אחרי יום: במגירה «שימוש», בלחיצה על הפעולה.</p></div>
</section>
<section class="card" style="margin-top:14px"><h3 class="ct">המשפך השבועי</h3><p class="cs" id="fns"></p><div class="fn2" id="fn"></div><p class="help">שני מסלולים. באתר: מהכניסה לבדיקת רכב ועד לחיצה על «להתקנה». באפליקציה, במכשירים: כמה פתחו אותה בשבוע, כמה מהם בדקו רכב וכמה שמרו. האחוז בין שני שלבים הוא ההמרה, והשלב שבו הכי הרבה נושרים הוא המקום לשפר. השבוע הקודם בקו האפור הדק.</p></section>

<h2 class="sec">תקינות</h2>
<section class="card hl" id="hl" aria-label="תקינות השירות והבוטים"></section>

<h2 class="sec">פירוט</h2>
<section class="drs">
<div class="card grp"><h3>צמיחה ושימוש</h3>
<details class="dr" id="dr-src"><summary><b>מקורות</b><span>מאיפה מגיעים אנשים, לאתר ולאפליקציה, לפי רשת, קישור ונושא</span></summary><p class="help" style="margin:0 0 10px">כל הדרכים שבהן אנשים מגיעים: לפי רשת (7 ימים כולל היום), לפי קישור go/ ונושא (השבוע), מהאתר לעמודים שלנו ברשתות, ובדיקות הרכב לפי המקור של הכניסה. כאן בודקים איזה פוסט או ערוץ הביא בדיקות, ולא רק כניסות.</p><div id="src"></div></details>
<details class="dr" id="dr-use"><summary><b>שימוש</b><span>מה אנשים עושים, וכמה מכשירים יש לאפליקציה</span></summary><p class="help" style="margin:0 0 10px">מה אנשים עושים: שמירת רכב, כל פעולה שנספרה השבוע מול השבוע הקודם (לחיצה על פעולה פותחת אותה יום אחרי יום, באפליקציה ובאתר), ודלת תיק הרכב. למטה: כמה מכשירים יש לאפליקציה, לפי Google Play ולפי גוגל אנליטיקס.</p><div id="use"></div></details>
<details class="dr" id="dr-web"><summary><b>האתר</b><span>מאיפה נכנסו לאתר, והדפים שהכי נצפו</span></summary><p class="help" style="margin:0 0 10px">ביקורים באתר לפי Cloudflare: מאיפה נכנסו (האתר המפנה) והדפים שהכי נצפו. Cloudflare סופר כל כניסה, גם כאלה שגוגל אנליטיקס לא רואה, ולכן המספרים כאן גבוהים יותר.</p><div id="web"></div></details>
<details class="dr" id="dr-seo"><summary><b>חיפוש בגוגל</b><span>חיפושים, דפים והופעות בתוצאות</span></summary><p class="help" style="margin:0 0 10px">חיפוש בגוגל: כניסות לפי יום, הדפים שלנו שגוגל מכיר, מה חיפשו כשהופענו, וחיפושים שקרובים לעמוד הראשון (המקומות 8 עד 20), שכדאי לחזק בתוכן.</p><div id="seo"></div></details>
</div>
<div class="card grp"><h3>יעדים</h3>
<details class="dr" id="dr-goal"><summary><b>יעדים לשנה</b><span>איפה אנחנו מול היעד, עד אוקטובר 2027</span></summary><p class="help" style="margin:0 0 10px">היעדים מתוכנית השיווק לכל חודש עד אוקטובר 2027, ואיפה אנחנו היום מול הקו. בין חודש לחודש היעד עולה בהדרגה, ולכן «היעד להיום» משתנה כל יום.</p><div id="goal"></div></details>
<details class="dr" id="dr-q"><summary><b>שאלות החודש</b><span>שלוש השאלות שיקבעו מה בונים אחרי 22.11</span></summary><p class="help" style="margin:0 0 10px">שלוש השאלות שיכריעו ב-22.11 מה בונים: האם יש צמיחה בלי דחיפה, האם רכב שמור מחזיר אנשים, ואיפה השיתוף נשבר. לכל שאלה סטטוס, המספרים שמאחוריו והספים.</p><div id="q"></div></details>
<details class="dr" id="dr-ms"><summary><b>אבני דרך</b><span>Google Play, הדרך למנוי PRO, פניות עסקיות</span></summary><p class="help" style="margin:0 0 10px">אבני הדרך: מצב האפליקציה ב-Google Play, הדרך למנוי PRO (2,000 משתמשים בחודש), ופניות עסקיות ונרשמים למגזין.</p><ul class="ms" id="ms"></ul></details>
</div>
<div class="card grp"><h3>תפעול</h3>
<details class="dr" id="dr-now"><summary><b>עכשיו</b><span>מי פעיל ברגע זה ומה קרה היום</span></summary><p class="help" style="margin:0 0 10px">מה קורה ברגע זה: 30 הדקות האחרונות, והיום עד עכשיו. היום מתעדכן באיחור, ולכן מוצג «לפחות» כשהספירה בזמן אמת ראתה יותר ממה שגוגל אנליטיקס כבר עיבד.</p><ul class="kv" id="now"></ul><p class="note">נתוני היום חלקיים: גוגל אנליטיקס מעדכן אותם בעיכוב של שעה עד כמה שעות.</p></details>
<details class="dr" id="dr-bots"><summary><b>בוטים</b><span>כל המשימות האוטומטיות: מתי רצו, ואם הצליחו</span></summary><p class="help" style="margin:0 0 10px">כל המשימות האוטומטיות, הבעיות קודם. לכל בוט: מה הוא עושה, מתי הוא רץ (שעון ישראל), הריצה האחרונה (קישור ליומן הריצה) והמצב. כבוי: מושבת ב-GitHub. דילג: הריצה האחרונה לא הייתה צריכה לעשות דבר, וזה תקין.</p><div id="bots"></div></details>
<details class="dr" id="dr-tec"><summary><b>טכני</b><span>כשלים לפי סיבה, קריסות ומקורות שלא ענו</span></summary><p class="help" style="margin:0 0 10px">לטיפול בתקלות: כשלים לפי סיבה, בדיקות איטיות, קריסות, חיפושי דגם בלי תוצאה, וחיבורי הנתונים של הדף הזה (מה מחובר ומה לא).</p><div id="tec"></div></details>
<details class="dr" id="dr-auto"><summary><b>מה השתנה לבד</b><span>מה הבוטים שינו בעצמם, ומה רק היו משנים</span></summary><p class="help" style="margin:0 0 10px">מה הבוטים שינו בעצמם לפי כללי הטייס האוטומטי, ובאיזה אזור. בתצפית: רק רושמים מה היו משנים. כל שינוי נבדק אחרי שבוע ומוחזר לבד אם המדד שלו ירד.</p><div id="auto"></div></details>
<details class="dr" id="dr-fl"><summary><b>מבזקים</b><span>ההתראות שנשלחו לטלגרם, מהחדשה לישנה</span></summary><p class="help" style="margin:0 0 10px">ההתראות שנשלחו לטלגרם, מהחדשה לישנה. ● תקלה או בקשה להחלטה. ○ מידע. רוב התקלות מטופלות אוטומטית, והודעה מגיעה רק כשנדרשת החלטה שלך.</p><ul class="kv fl" id="fl"></ul><p class="note">● תקלה, או בקשה להחלטה שלך. ○ מידע בלבד. כשיש תקלה אני מטפל בה בשגרה, ופונה אליך רק כשנדרשת החלטה שלך.</p></details>
</div>
</section>

<p class="foot">מקורות: גוגל אנליטיקס (אפליקציה ואתר), Cloudflare (ביקורים באתר), Search Console (חיפוש בגוגל) ו-Google Play (דף האפליקציה, Play Console ודוחות ההתקנות). לכל מספר מצוינים התאריכים שלו, כי לכל מקור יש איחור אחר. הדף מתרענן כל דקה. <span id="build"></span></p>
<p class="foot" id="er"></p>
</main>
<script>
/* Business dashboard. Spec: Claude Doc "לוחית: אפיון דשבורד מנהלים", sections 3 (targets) and 4 (traffic light). */
const CAL_END="2026-11-02";        // until the base week 26.10-1.11 is over, only health, Google pages and the store get a colour
const COLS=new Date(Date.parse(CAL_END+"T12:00:00Z")+864e5).toISOString().slice(0,10);   // the first day the colors show: the window that ends on CAL_END is there after noon the next day
const SITE_FROM="2026-10-15";      // car checks on the site are counted from this day (the app's from the start)
// Yearly goals from the CMO plan (reports/marketing-goals-2026-10.json): per month [cons, base, opt], the weekly figure or level expected in the
// month's last week, Nov 2026 to Oct 2027. Colour vs base: at or above base ok, between cons and base warn, below cons bad (failures: lower is better).
// Between month ends the target moves in a straight line; "from" gives a starting point where one is known, otherwise the first month holds before it.
const GOALS={first:"2026-11",k:{weekly_checks:[[160,190,240],[190,240,330],[250,330,490],[270,380,600],[320,470,800],[360,550,990],[430,680,1310],[500,820,1670],[560,970,2080],[640,1150,2600],[690,1290,3050],[740,1430,3540]],installs_week:[[30,40,50],[35,50,70],[50,70,105],[50,75,120],[60,90,155],[65,100,185],[75,125,245],[85,145,300],[95,165,360],[105,190,435],[105,200,480],[105,210,525]],google_clicks_week:[[4,5,6],[7,9,13],[11,15,23],[15,22,36],[22,33,57],[29,45,83],[37,60,117],[47,80,165],[60,105,228],[74,135,308],[84,160,383],[95,190,475]],pages_indexed:[[100,120,150],[110,150,180],[120,165,200],[130,180,220],[140,195,240],[145,210,255],[150,220,265],[155,230,275],[160,240,285],[165,250,295],[170,260,300],[175,270,305]],share_per_100:[[2,3,4],[3,4,5],[3,4,6],[3,5,7],[4,6,8],[4,6,9],[4,7,9],[5,7,10],[5,8,11],[5,9,12],[6,9,13],[6,10,14]],app_active_28d:[[110,150,190],[150,200,280],[210,300,450],[240,350,550],[290,430,730],[330,510,900],[410,650,1200],[480,780,1510],[540,910,1860],[620,1080,2300],[670,1200,2650],[720,1320,3030]],failures_pct:[[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5]],subscribers_total:[[5,15,45],[10,30,90],[20,50,150],[30,70,210],[35,90,270],[50,120,360],[60,150,450],[80,200,600],[100,250,750],[120,300,900],[140,350,1050],[160,400,1200]]},
 from:{weekly_checks:["2026-10-25",170],google_clicks_week:["2026-10-14",0],pages_indexed:["2026-10-17",90],app_active_28d:["2026-10-18",23],subscribers_total:["2026-10-01",0]},
 calib:{keys:["weekly_checks","installs_week"],end:"2026-11-01",lo:.5,hi:20}};   // the base week 26.10-1.11 sets the level of car checks and installs (Dudu 26.10): r = its actual / the plan's line on 1.11 (174 checks, 40 installs), 0.5 to 20. Not the launch week 19-25.10: its posts would set every later target (decided 20.10)
const SUBMITTED="2026-10-17";      // production access requested in Play Console
const PRO_MAU=2000;
const N={car_lookup:"בדיקת רכב",car_save:"שמירת רכב ברשימה",share:"שיתוף (דוח רכב או השוואה)",compare_open:"השוואת רכבים",tab_view:"מעבר בין לשוניות",link_out:"לחיצה על קישור חיצוני",alerts_toggle:"הדלקה או כיבוי של התראות",alert_kind:"בחירת סוג התראה",upgrade_open:"פתיחת חלונית המנוי (PRO)",voice_search:"חיפוש בקול",bulk_check:"בדיקת כמה רכבים יחד",camera_scan:"סריקת לוחית במצלמה",buy_card_open:"פתיחת כרטיס בלשונית קנייה",settlement_shown:"הצגת הסדר פשרה",checklist_pdf:"הורדת רשימת בדיקה",doc_add:"הוספת מסמך לרכב",doc_exp:"תאריך תוקף למסמך (הוספה או שינוי)",doc_scan:"קריאת תאריך התוקף מהמסמך (בטלפון)",simple_view:"מעבר לתצוגה פשוטה",search_no_result:"חיפוש דגם בלי תוצאה",user_screenshot:"צילום מסך",first_open:"התקנה חדשה (פתיחה ראשונה)",lookup_repeat:"פתיחה חוזרת של רכב (רענון)",notif_open:"פתיחת התראה מהטלפון",notif_sent:"התראה שנשלחה לטלפון",web_hint_click:"לחיצה על הצעה להתקין מהאתר",web_install_click:"מעבר מהאתר להתקנה",calendar_reminder_click:"הוספת תזכורת ליומן",link_landing:"כניסה לאתר מקישור",link_open:"פתיחת קישור באפליקציה",web_visit:"כניסה לאתר",referral_open:"פתיחה ראשונה אחרי התקנה מקישור ששותף",share_open:"פתיחת חלון השיתוף",nav:"מעבר בתפריט התחתון",cars_mode:"החלפת תצוגה ברכבים שלי",alert_item:"לחיצה על פריט במסך ההתראות",road_docs:"פתיחת מסמכים לנסיעה",history_pdf:"הפקת דוח היסטוריה (PDF)",mine_set:"פתיחת תיק לרכב שלי",mine_unset:"ביטול סימון הרכב שלי",car_unsave:"הסרת רכב מהרכבים שלי",home_open:"פתיחה מהאייקון במסך הבית (אתר)",home_sheet:"הצעה באייפון להוסיף למסך הבית",first_save:"שמירת רכב ראשונה (ביום ההתקנה)",app_return:"חזרה לאפליקציה בשבוע הראשון",zombie_shown:"הצגת רכב שירד מהכביש וחזר",lookup_from_cache:"הצגת בדיקה שמורה (בלי חיבור)",buy_step_done:"סימון שלב ברשימת הקנייה",check_open:"פתיחת סעיף ברשימת הבדיקה",simple_more:"הרחבה בתצוגה הפשוטה",calendar_reminder_shown:"הצגת הצעה לתזכורת ביומן",car_nick:"כינוי לרכב",web_install_prompt:"הצגת הצעה להתקין (באתר)",svc_add:"רישום טיפול או קילומטראז' לרכב",svc_cal:"הטיפול הבא ליומן",trial_start:"התחלת ניסיון PRO",trial_end_shown:"הודעת סוף ניסיון PRO",upgrade_purchase_start:"התחלת רכישת PRO",update_prompt:"הצעה לעדכן גרסה",update_start:"התחלת עדכון גרסה",update_done:"התקנת עדכון גרסה",file_cta_shown:"הצגת השורה «פתיחת תיק» בסקירת הרכב",exp_expose:"הצגת נוסח בניסוי",js_error:"שגיאת קוד באתר או באפליקציה",lookup_abort:"בדיקה שבוטלה באמצע",lookup_failed:"בדיקה שנכשלה",lookup_slow:"בדיקה איטית (הופיעה הודעת המתנה)",lookup_timeout:"בדיקה שלא הסתיימה בזמן",app_exception:"קריסה של האפליקציה",newsletter_confirm:"אישור הרשמה למגזין",b2b_lead_submit:"פנייה עסקית מהאתר"};
// events Google sends by itself: shown with this name and marked as automatic; any other name GA4 has that neither list knows is shown raw, marked new
const AUTO={session_start:"פתיחה (אוטומטי)",user_engagement:"זמן שימוש (אוטומטי)",screen_view:"מעבר מסך באפליקציה (אוטומטי)",page_view:"צפייה בדף (אוטומטי)",first_visit:"כניסה ראשונה לאתר (אוטומטי)",app_remove:"הסרת האפליקציה (אוטומטי)",app_update:"עדכון האפליקציה (אוטומטי)",os_update:"עדכון מערכת בטלפון (אוטומטי)",app_clear_data:"ניקוי נתוני האפליקציה (אוטומטי)",firebase_campaign:"פתיחה מקמפיין (אוטומטי)",notification_receive:"קבלת התראה (אוטומטי)",notification_open:"פתיחת התראה (אוטומטי)",notification_dismiss:"סגירת התראה (אוטומטי)",notification_foreground:"התראה כשהאפליקציה פתוחה (אוטומטי)",screen_view_web:"מעבר מסך (אוטומטי)",scroll:"גלילה בדף (אוטומטי)",click:"לחיצה על קישור יוצא (אוטומטי)",form_start:"התחלת מילוי טופס (אוטומטי)",form_submit:"שליחת טופס (אוטומטי)",file_download:"הורדת קובץ (אוטומטי)",view_search_results:"תוצאות חיפוש באתר (אוטומטי)",video_start:"התחלת וידאו (אוטומטי)",in_app_purchase:"רכישה באפליקציה (אוטומטי)"};
const KIND={source_down:"משרד התחבורה לא ענה",offline:"לא התקבלה תשובה (חיבור או זמן המתנה)",not_found:"מספר שלא קיים (הוקלד לא נכון)",net_err:"החיבור למאגרי משרד התחבורה נכשל",js_err:"תקלה בקוד שלנו בזמן הבדיקה","(not set)":"לא ידוע"};
const FK={data:"נתונים",infra:"תשתית",content:"תוכן",release:"שחרור",experiment:"ניסוי",reviews:"ביקורות"};
const VIA={img:"תמונה",full:"תמונה מלאה",pdf:"PDF",txt:"טקסט",cmp:"השוואה"};
const HT={t1:"המדד הראשי: כמה בדיקות רכב נעשו בשבוע שהסתיים אתמול, באפליקציה ובאתר יחד. הפס מראה כמה מהיעד השבועי הושג, והעמודות הקטנות את השבועות האחרונים. היעד נקבע מתוכנית השיווק ומשבוע הבסיס.",
 t2:"כמה אנשים הגיעו לאתר מתוצאות חיפוש בגוגל בשבוע, לפי Search Console (שמוסר באיחור של 3 ימים). מתחת: כמה מדפי האתר מופיעים בגוגל. יותר דפים בגוגל מביאים עם הזמן יותר כניסות בלי פרסום.",
 t3:"כמה שיתופים (דוח רכב או השוואה) היו על כל 100 בדיקות. מודד אם אנשים מרוצים מספיק כדי להעביר הלאה, וזה המנוע לצמיחה בלי פרסום. נספר מ-100 בדיקות בשבוע; עד אז מ-28 ימים.",
 t4:"כמה מכשירים בישראל פתחו את האפליקציה בפעם הראשונה בשבוע (התקנה חדשה). מתחת: כמה מכשירים מחזיקים אותה עכשיו, כמה התקינו היום, ומה מצב הגרסה ב-Google Play. היעד נקבע מתוכנית השיווק ומשבוע הבסיס.",
 h1:"אחוז הבדיקות שקיבלו תשובה. כשל הוא רק כשמשרד התחבורה לא ענה או שלא התקבלה תשובה; מספר שהוקלד לא נכון אינו כשל. היעד: עד 2% כשלים.",
 h2:"חלק הבדיקות שלקחו יותר מ-5 שניות. עד 10% זה תקין. מעל זה הבעיה בדרך כלל אצל משרד התחבורה, לא אצלנו.",
 h3:"כמה פעמים האפליקציה קרסה השבוע, לפי גוגל אנליטיקס. אחרי שחרור גרסה שומר הקריסות משווה ל-7 הימים שלפניו ומתריע על בעיה חדשה.",
 h4:"הדירוג הממוצע בחנות ומספר הדירוגים, מדוחות Google Play (באיחור של כמה ימים). אבן הדרך M3: דירוג 4.5 ומעלה עם 21 דירוגים.",
 h5:"כל המשימות האוטומטיות: כמה רצו כמו שצריך מתוך כולן. נקודה אדומה: בוט שנכשל. סימן קריאה: באיחור, או כבוי. בוט שנכשל מטופל אוטומטית; הרשימה המלאה, עם מה כל בוט עושה, במגירה «בוטים»."};
const ST={ok:["תקין","✓"],warn:["דורש תשומת לב","!"],bad:["מתחת ליעד","✕"],early:["מוקדם לשפוט","◷"],nodata:["אין נתון","?"],cal:["יעד מ-"+Number(COLS.slice(8))+"."+Number(COLS.slice(5,7)),"·"],wait:["ממתין","◷"]};

const $=i=>document.getElementById(i);
const n=x=>x==null||!isFinite(x)?"-":Math.round(x).toLocaleString("en-US");
const n1=x=>x==null||!isFinite(x)?"-":(Math.round(x*10)/10).toLocaleString("en-US");
// a source that did not answer in time is told in Hebrew; one that answered before keeps that answer and says so (26.10)
const TOUT=/abort|timed? ?out/i,whyT=w=>TOUT.test(w||"")?"לא ענה בזמן. ייבדק שוב בעוד כמה דקות":(w||"");
const stl=o=>o&&o.stale?"<b>הבדיקה האחרונה לא ענתה בזמן.</b> מוצג המידע הקודם"+(o.at?" מתאריך <bdi>"+new Date(o.at).toLocaleDateString("he-IL",{timeZone:"Asia/Jerusalem",day:"numeric",month:"numeric"})+"</bdi> בשעה <bdi>"+new Date(o.at).toLocaleTimeString("he-IL",{timeZone:"Asia/Jerusalem",hour:"2-digit",minute:"2-digit"})+"</bdi>":"")+". ":"";
const esc=t=>String(t==null?"":t).replace(/[<>&"]/g,"");
// a page of the site by its Hebrew name, with its address under it
const PGN=[[/^\\/$/,"דף הבית: בדיקת רכב"],[/^\\/magazine\\//,"מגזין"],[/^\\/model\\/$/,"כל הדגמים"],[/^\\/model\\//,"דף דגם"],[/^\\/check\\/$/,"כל הבדיקות"],[/^\\/check\\/recall\\//,"בדיקת ריקול"],[/^\\/check\\/settlements\\//,"הסדרי פשרה"],[/^\\/check\\/license-fee\\//,"אגרת רישוי"],[/^\\/check\\/owners\\//,"כמה ידיים היו לרכב"],[/^\\/check\\/test\\//,"מתי הטסט"],[/^\\/check\\/off-road\\//,"רכב שירד מהכביש"],[/^\\/check\\/value\\//,"שווי רכב"],[/^\\/business\\//,"לעסקים"],[/^\\/guide\\//,"מדריך"],[/^\\/go(\\/|$)/,"קישור מרשת חברתית"]];
const PG=u=>{const p=String(u||"/").replace(/^https?:\\/\\/[^/]+/,"").replace(/[?#].*$/,"")||"/",m=PGN.find(x=>x[0].test(p));return '<span class="pg">'+(m?m[1]:"דף אחר")+'<small><bdi dir="ltr">'+esc(p)+"</bdi></small></span>"};
const dm=s=>{const p=String(s).slice(0,10).split("-");return Number(p[2])+"."+Number(p[1])};
const rng=w=>w?dm(w[0])+" עד "+dm(w[1]):"";
const addD=(d,k)=>new Date(Date.parse(d+"T12:00:00Z")+k*864e5).toISOString().slice(0,10);
const between=(a,b)=>Math.round((Date.parse(b+"T12:00:00Z")-Date.parse(a+"T12:00:00Z"))/864e5);
const chip=(s,w)=>'<span class="chip s-'+s+'"><i aria-hidden="true">'+ST[s][1]+'</i>'+(w||ST[s][0])+'</span>';
const mini=s=>'<span class="mini s-'+s+'"><i aria-hidden="true">'+ST[s][1]+'</i>'+ST[s][0]+'</span>';
const mark=s=>'<span class="mini s-'+s+'" title="'+ST[s][0]+'" aria-label="'+ST[s][0]+'">'+ST[s][1]+'</span>';
const spark28=(o,M)=>{const T=o.a.map((x,i)=>x+o.w[i]),mx=Math.max(1,...T),sum=T.reduce((a,b)=>a+b,0),ta=o.a.reduce((a,b)=>a+b,0),tw=o.w.reduce((a,b)=>a+b,0),D=i=>addD(M[0],i);
 return '<svg class="spark" viewBox="0 0 280 50" direction="ltr" style="direction:ltr" role="img" aria-label="יום אחרי יום, 28 ימים">'+T.map((t,i)=>{if(!t)return "";const ha=o.a[i]?Math.max(2,o.a[i]/mx*44):0,hw=o.w[i]?Math.max(2,o.w[i]/mx*44):0,x=i*10+1;return (ha?'<rect class="t-app" x="'+x+'" y="'+(48-ha)+'" width="8" height="'+ha+'" rx="1.5"><title>'+dm(D(i))+": באפליקציה "+n(o.a[i])+"</title></rect>":"")+(hw?'<rect class="t-site" x="'+x+'" y="'+(48-ha-hw-(ha?1:0))+'" width="8" height="'+hw+'" rx="1.5"><title>'+dm(D(i))+": באתר "+n(o.w[i])+"</title></rect>":"")}).join("")+'</svg><div class="axis"><span>'+dm(D(0))+"</span><span>"+dm(D(27))+"</span></div><small>28 ימים: "+n(sum)+" בסך הכול, "+n1(sum/28)+" ביום בממוצע"+(ta&&tw?". באפליקציה "+n(ta)+", באתר "+n(tw):tw?". באתר":"")+"</small>"};
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
// a calibrated goal's r: the base week's actual over the plan's line on its last day, within lo to hi. Every target of the goal is the plan's
// times r, so the plan's growth shape is kept. null for a goal that is not calibrated, or without the base week's count
function calib(key,actual){const C=GOALS.calib;return actual==null||C.keys.indexOf(key)<0?null:Math.min(C.hi,Math.max(C.lo,actual/goal(key,C.end)[1]))}
// at or above base ok, cons to base warn, below cons bad; small counts only bad when it cannot be bad luck; lower=true flips it (failures)
function band(a,g,lower,small){if(a==null)return "nodata";if(!g)return "early";const c=g[0],b=g[1];if(lower)return a<=b?"ok":a<=c?"warn":"bad";if(a>=b)return "ok";if(a>=c)return "warn";if(small&&c<20&&pois(a,c)>=.05)return "warn";return "bad"}
const gtxt=g=>g?"היעד "+n1(g[1])+" (טווח "+n1(g[0])+" עד "+n1(g[2])+")":"";
const MN=["ינואר","פברואר","מרץ","אפריל","מאי","יוני","יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];
const mname=(m,y)=>MN[Number(m.slice(5,7))-1]+(y?" "+m.slice(0,4):"");
// a count target in whole numbers; while it is still under 1 a week (the first weeks of a goal that starts near zero), the month-end target
const gtxtN=(key,g,day)=>{if(!g)return "";if(g[1]>=1)return "היעד "+n(g[1])+" (טווח "+n(g[0])+" עד "+n(g[2])+")";const m=MONTHS.find(x=>mEnd(x)>=day)||MONTHS[0];return "היעד לסוף "+mname(m)+": "+n(goal(key,mEnd(m))[1])+" בשבוע"};
const RANK={bad:0,nodata:1,warn:2};
// production release states in Play Console: [what it means, status]
const RS={draft:["טיוטה בקונסול","wait"],not_sent_for_review:["מוכנה, עוד לא נשלחה לבדיקה","wait"],in_review:["בבדיקה של גוגל","wait"],approved_not_published:["אושרה, מחכה שתפרסם","wait"],not_approved:["נדחתה בבדיקה","bad"],published:["פורסמה","ok"]};
const hm=ts=>{if(!ts)return "";const o={timeZone:"Asia/Jerusalem"},t=new Date(ts),day=t.toLocaleDateString("en-CA",o);return (day!==new Date().toLocaleDateString("en-CA",o)?dm(day)+" ":"")+t.toLocaleTimeString("he-IL",{...o,hour:"2-digit",minute:"2-digit"})};

function render(d){
const W=d.weekly||null,ev=W&&W.ev,E0=ev?ev[0]:{},E1=ev?ev[1]:{},E2=ev?ev[2]:{},ge=(o,k,i)=>o&&o[k]?o[k][i||0]:0;
const end=W?W.end:null,cal=!end||end<CAL_END,days=W&&W.days;
const week=e=>{if(!days)return null;let s=0;for(let i=0;i<7;i++)s+=days[addD(e,-i)]||0;return s};
const M={},att=[];
const push=(key,s,prio,ratio,text,short,w)=>{M[key]=s;if(RANK[s]!=null)att.push({key,s,prio,ratio,text,short,w})};
// where each number is explained: the drawer behind it
const DR={ns:"dr-src",clicks:"dr-seo",pages:"dr-seo",share:"dr-q",installs:"dr-use",store:"dr-ms",health:"dr-tec",slow:"dr-tec",bots:"dr-bots"};
// day by day series (about 9 weeks): weekly sums for the charts, the up to 8 whole weeks that have checks, oldest first
const SR=W&&W.series,wsum=(k,e)=>{const o=SR&&SR[k];if(!o)return null;let s=0;for(let i=0;i<7;i++)s+=o[addD(e,-i)]||0;return s};
// the calibration (GOALS.calib) once the base week is over: its car checks from the day by day counts, its installs from the first opens
// series (the count the installs tile shows, new users in Israel); r 1 before then, and no installs target when that series is missing
const CB=GOALS.calib,base=end>=CB.end,cw=days&&base?week(CB.end):null,ci=base?wsum("first_open",CB.end):null;
const RC=cw!=null?calib("weekly_checks",cw):1,RI=base?calib("installs_week",ci):1,RCAL={weekly_checks:RC,installs_week:RI};
const nsGoal=e=>!days||e<CAL_END?null:goal("weekly_checks",e,RC),nsTarget=e=>{const g=nsGoal(e);return g?g[1]:null};
const ENDS=[];if(end&&days){for(let i=7;i>=0;i--)ENDS.push(addD(end,-7*i));while(ENDS.length>2&&!week(ENDS[0]))ENDS.shift()}
// a small bar chart of a few weeks under a number; the last bar (the week shown) is solid
const spark=(vals,labels,fmt)=>{if(!vals||vals.length<2)return "";const v=vals.map(x=>x==null||!isFinite(x)?0:x),mx=Math.max(1e-9,...v),k=v.length,sw=200/k,bw=Math.max(3,sw*.6);
 return '<svg class="sp" viewBox="0 0 200 38" preserveAspectRatio="none" direction="ltr" style="direction:ltr" role="img" aria-label="'+labels.map((l,i)=>l+": "+fmt(vals[i])).join(", ")+'">'+v.map((x,i)=>{const h=x?Math.max(2,x/mx*36):0;return '<rect'+(i===k-1?' class="last"':"")+' x="'+(i*sw+(sw-bw)/2)+'" y="'+(38-h)+'" width="'+bw+'" height="'+h+'" rx="2"><title>'+labels[i]+": "+fmt(vals[i])+"</title></rect>"}).join("")+"</svg>"};
const wl=e=>"שבוע עד "+dm(e);
// the bots board (Live watch writes it every 30 minutes): each scheduled workflow's latest run on main, in plain words
const BN={"alert-daily.yml":["צלצול הבוקר של ההתראות","ניטור"],"live-watch.yml":["שומר הדשבורד","ניטור"],"web-watch.yml":["שומר האתר היומי","ניטור"],"explore.yml":["הסיור השבועי באפליקציה","ניטור"],"site-smoke.yml":["בדיקת האתר החי","ניטור"],"data-guard.yml":["שומר הנתונים","ניטור"],"data-truth.yml":["בדיקת אמת מול משרד התחבורה","ניטור"],"ministry-watch.yml":["שומר מאגרי משרד התחבורה","ניטור"],"release-watch.yml":["שומר הקריסות אחרי שחרור","ניטור"],"release-guard.yml":["שומר הגרסה החדשה","ניטור"],"app-guardian.yml":["שומר העיצוב באפליקציה","ניטור"],"ui-guardian.yml":["שומר העיצוב","ניטור"],"copy-audit.yml":["בדיקת הנוסח השבועית","ניטור"],"notes-draft.yml":["טיוטת הערות השחרור","פריסה"],"reviews-monitor.yml":["שומר הביקורות","ניטור"],
 "catalog.yml":["קטלוג הדגמים","נתונים"],"fuel.yml":["מחיר הדלק","נתונים"],"market.yml":["נתוני השוק","נתונים"],"models.yml":["שמות הדגמים","נתונים"],"modelstats.yml":["סטטיסטיקת הדגמים","נתונים"],"own-data.yml":["העתק נתוני הבעלות","נתונים"],"settlements.yml":["הסדרי פשרה","נתונים"],"zombie.yml":["גלאי רכבים שחזרו לכביש","נתונים"],
 "seo-data.yml":["צילום נתוני SEO","גוגל"],"seo-daily.yml":["סיכום SEO יומי","גוגל"],"seo-check.yml":["בדיקת SEO","גוגל"],"seo-publish.yml":["פרסום SEO אוטומטי","גוגל"],
 "magazine.yml":["המגזין","תוכן ושיווק"],"social-publish.yml":["הפרסום האוטומטי לפייסבוק ואינסטגרם","תוכן ושיווק"],"camp-data.yml":["צילום נתוני הקמפיינים","תוכן ושיווק"],"competitor-check.yml":["בדיקת המתחרים החודשית","תוכן ושיווק"],"kit-draft.yml":["טיוטת ערכת התוכן השבועית","תוכן ושיווק"],"kit-qa.yml":["הבדיקה הוויזואלית של ערכת התוכן","תוכן ושיווק"],"weekly-analytics.yml":["הדוח השבועי","תוכן ושיווק"],
 "web-deploy.yml":["פריסת האתר","פריסה"],"workers-deploy.yml":["פריסת ה-Workers","פריסה"],"ship-tail.yml":["זנב השחרור (העלאה ל-Alpha)","פריסה"]};
// what each bot does, one line
const BD={"copy-audit.yml":"פעם בשבוע: קורא את כל הנוסח בעברית באפליקציה, באתר ובדף החנות, ומסמן ניסוח לא אחיד, הבטחה שלא מתקיימת, פנייה במגדר או שגיאת כתיב. רק מציע, לא משנה כלום.","notes-draft.yml":"כשמכינים גרסה חדשה: כותב טיוטה בעברית להערות השחרור ב-Google Play מתוך השינויים, לפי הכללים של החנות. רק טיוטה, לא נשלחת לבד.","kit-draft.yml":"ביום רביעי בלילה: Claude כותב טיוטה של טקסטי ערכת התוכן השבועית מהעובדות המאומתות, ובודק אותה בבודק הערכה. שרשור השיווק עובר עליה ביום חמישי.","kit-qa.yml":"אחרי שערכת התוכן נכנסת לתור הפרסום: Claude עובר על כל תמונה ועל פריימים מהסרטון ומחפש טקסט חתוך, טעות כתיב, ימין-לשמאל, תג Google Play חסר או לוחית רישוי שאינה לדוגמה.","competitor-check.yml":"פעם בחודש: מחפש ברשת שינויים אצל אפליקציות ושירותים דומים (מחיר, התראות, גרסה חדשה) ושומר רק שינוי שנמצא לו מקור.","app-guardian.yml":"כל לילה: פותח את האפליקציה האמיתית על אנדרואיד 12 ו-15, בכמה גדלי מסך וגופן, ובודק שכל מסך במקום, שהמקלדת, כפתור החזרה והמצב הכהה עובדים, ושהתראה או קישור פותחים את המסך הנכון.","ui-guardian.yml":"כל לילה: עובר בדפדפן על כל המסכים באפליקציה ובאתר, בטלפון, בטאבלט ובמחשב, בהיר וכהה, ובודק שכל מסך נפתח במקום, שאין גלילה הצידה או משהו שחורג מהמסך, ושהאנליטיקה שולחת את מה שהדשבורד קורא, בלי פרטים אישיים.","alert-daily.yml":"סיכום הבוקר בטלגרם: מה קרה בלילה ומה מחכה להחלטה.","live-watch.yml":"בודק כל חצי שעה שהדשבורד הזה עונה, ומעדכן את לוח הבוטים.","web-watch.yml":"פעם ביום: מהירות האתר בטלפון וזמן הטעינה האמיתי, ובדיקה שצינור הנתונים (אנליטיקס מול Cloudflare) תקין.","site-smoke.yml":"פותח את האתר החי בדפדפן אמיתי, בודק רכב ודפים מרכזיים, ועוקב אחרי תוקף האבטחה והדומיין.","data-guard.yml":"משווה כל יום את מבנה מאגרי משרד התחבורה לבסיס שמור, ועוצר בניית גרסה כשמשהו נשבר.","data-truth.yml":"פותח מדגם של כ-40 רכבים באתר כמו משתמש, ומשווה כל לשונית למאגר של משרד התחבורה.","ministry-watch.yml":"פעם ביום: המאגרים של משרד התחבורה שהאפליקציה קוראת זמינים ועודכנו.","release-watch.yml":"72 שעות אחרי שגרסה מגיעה ל-Google Play: קריסות ותקיעות חדשות באותה גרסה, התראה אחת לכל בעיה.","release-guard.yml":"ביום 1, 3 ו-7 אחרי גרסה חדשה: משווה את השימוש לגרסה הקודמת, לכל 100 בדיקות.","reviews-monitor.yml":"שלוש פעמים ביום: ביקורות חדשות של 1 עד 3 כוכבים וחריגות בקריסות, לטלגרם.",
 "catalog.yml":"בונה את קטלוג הדגמים להשוואה (יצרן, דגם, שנה, רמת גימור) מנתוני משרד התחבורה.","fuel.yml":"מחיר הדלק המפוקח, לחישובי העלות.","market.yml":"נתוני השוק החודשיים ממשרד התחבורה, לכתבות ולדפי הדגמים.","models.yml":"שמות הדגמים בעברית, מהרישוי.","modelstats.yml":"סטטיסטיקה לכל דגם, פעם בחודש.","own-data.yml":"העתק יומי של קובץ היסטוריית הבעלות, לשימוש כשמאגר המשרד מחזיר ריק.","settlements.yml":"רשימת הסדרי הפשרה (תביעות ייצוגיות) שהאפליקציה קוראת מהאתר, פעם בשבוע.","zombie.yml":"פעם בחודש: רכבים שירדו מהכביש וחזרו, מהשוואת המאגר לחודש שעבר.",
 "seo-data.yml":"צילום יומי מ-Search Console: חיפושים, דפים ומצב האינדוקס, והתראה כשמספר הדפים בגוגל יורד.","seo-daily.yml":"סיכום יומי של החיפוש בגוגל לטלגרם, ואזכורים חדשים של luchit.app ברשת.","seo-check.yml":"בדיקות SEO לאתר על כל שינוי, ובשני גם בדיקה של האתר החי.","seo-publish.yml":"מפרסם שינויי SEO שהוכנו מראש, אחרי כיום, כשכל הבדיקות עוברות.",
 "magazine.yml":"כתבת נתונים שבועית (חמישי) וכתבה חודשית (ב-6 בחודש) במגזין.","social-publish.yml":"מפרסם את ערכת התוכן השבועית לעמוד הפייסבוק ולאינסטגרם, לפי התור.","camp-data.yml":"צילום שבועי של מה שכל נושא קמפיין הביא, לערכת התוכן.","weekly-analytics.yml":"הדוח השבועי בטלגרם: 7 הימים האחרונים, חריגות והמגמה.","explore.yml":"פעם בשבוע: Claude משתמש באפליקציה ובאתר שבדרך לשחרור כמו אדם סקרן, מחוץ למסלולים הקבועים של השומרים, עם לוחיות לדוגמה בלבד ובלי ששום דבר יוצא מהמחשב, ורושם מה נראה שבור או מבלבל.",
 "web-deploy.yml":"בונה את האתר לפרסום (הקוד נדחס ומוגש מהר יותר).","workers-deploy.yml":"אחרי כל שינוי ב-main: מעלה את השרתים (הדשבורד, ההתראות והקישורים).","ship-tail.yml":"אחרי בניית גרסה: מעלה אותה ל-Alpha, מסנכרן את אנליטיקס ושולח הודעה אחת."};
const every=p=>!p?"אחרי כל שחרור":p<=15?"כל רבע שעה":p<=30?"כל חצי שעה":p<=60?"כל שעה":p<=13*60?"כמה פעמים ביום":p<=1500?"פעם ביום":p<=10600?"פעם בשבוע":"פעם בחודש";
// switched off in GitHub / failed / late (no run for its interval plus a quarter, at least an hour and a half) / skipped (its last run had nothing to do) / never ran / ok
const bst=o=>o.s==="off"?["warn","כבוי"]:o.c==="failure"||o.c==="timed_out"?["bad","נכשל"]:o.c==="unread"?["nodata","לא נקרא"]:o.c==="none"?["early","עוד לא רץ"]:o.c==="skipped"?["early","דילג, לא היה צורך"]:o.c==="cancelled"?["warn","בוטל"]:o.run?["ok","רץ עכשיו"]:o.p&&o.t&&Date.now()-Date.parse(o.t)>(o.p+Math.max(90,o.p*.25))*60e3?["warn","באיחור"]:["ok","תקין"];
const BO=d.metrics&&d.metrics.bots,BL=BO?BO.list.map(o=>({...o,st:bst(o),he:(BN[o.f]||[o.he||o.n,"אחר"])[0],gr:(BN[o.f]||[o.n,"אחר"])[1]})):null;

// 1. weekly car checks (north star)
let t1;{const L=ev?ge(E0,"car_lookup"):null,Lp=ev?ge(E1,"car_lookup"):null,G=end?nsGoal(end):null,tg=G?G[1]:null;let s;
// a previous week that began before SITE_FROM has no (or only some) site checks: the change is the app's alone
const BS=W&&W.bySource,mix=W&&W.W&&addD(W.W[0],-7)<SITE_FROM,La=BS&&BS[0].app?BS[0].app[1]:null,Lpa=BS&&BS[1].app?BS[1].app[1]:null,app1=mix&&La!=null&&Lpa!=null;
if(!ev)s="nodata";else if(cal)s="cal";else{s=band(L,G,false,true);if(s==="ok"&&(app1?Lpa>=30&&La<.8*Lpa:Lp>=30&&L<.8*Lp))s="warn"}
push("ns",s,1,tg?L/tg:1,"בדיקות רכב: "+n(L)+(tg?", היעד "+n(tg):""),s==="nodata"?"חסר נתון מגוגל אנליטיקס":"הבדיקות מתחת ליעד");
const l1=!ev?"גוגל אנליטיקס לא ענה":tg?n(L/tg*100)+"% מהיעד ("+n(tg)+", טווח "+n(G[0])+" עד "+n(G[2])+")":"שבוע הבסיס הוא "+rng([addD(CB.end,-6),CB.end])+", ולפיו ייקבע היעד";
const l2=!mix?delta(L,Lp):app1?"באפליקציה: "+delta(La,Lpa)+". את האתר עוד אי אפשר להשוות, הוא נספר מ-"+dm(SITE_FROM):"";
const site=wsum("site_lookup",end);
t1={s,title:"בדיקות רכב בשבוע",big:n(L),lines:[l1,l2],win:rng(W&&W.W),foot:"אפליקציה ואתר",L,Lp,tg,dl:ev?l2:"",
 gl:tg?n(L/tg*100)+"% מהיעד השבועי ("+n(tg)+")":"",gp:tg?L/tg:0,gn:!tg&&ev?"היעד השבועי ייקבע לפי שבוע הבסיס, "+rng([addD(CB.end,-6),CB.end]):"",
 sp:spark(ENDS.map(week),ENDS.map(wl),n),sub:site!=null&&ev?"באפליקציה <b>"+n(Math.max(0,week(end)-site))+"</b>"+(W.savers&&W.savers.car_lookup?" (מ-"+n(W.savers.car_lookup)+" מכשירים)":"")+", באתר <b>"+n(site)+"</b>":""}}

// 2. Google clicks, with pages Google knows under it
let t2;{const S=d.seo,c=S&&S.cur,a=c?Math.round(c.clicks):null,sd=S&&S.range?S.range[1]:null,GC=goal("google_clicks_week",sd),exp=GC?GC[1]:null;let s;
if(!c)s="nodata";else if(cal)s="cal";else if(exp<2)s="early";else s=band(a,GC,false,true);
push("clicks",s,2,exp?a/exp:1,"כניסות מגוגל: "+n(a)+(exp>=1?", היעד "+n(exp):""),s==="nodata"?"חסר נתון מ-Search Console":"הכניסות מגוגל מתחת ליעד");
// pages
const X=d.metrics&&d.metrics.index,today=new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Jerusalem"}),GP2=goal("pages_indexed",today),pexp=GP2[1];let ps;
// pages come into Google in batches, so a few pages short of the line (3, or 5% of it) is yellow, not red
if(!X||X.indexed==null||Date.now()-Date.parse(X.at)>48*3600e3)ps="nodata";else{ps=band(X.indexed,GP2,false,false);if(ps==="bad"&&X.indexed>=pexp-Math.max(3,pexp*.05))ps="warn"}
push("pages",ps,3,X&&pexp?X.indexed/pexp:1,"דפים שמופיעים בגוגל: "+(X?n(X.indexed):"-")+", היעד "+n(pexp),ps==="nodata"?"חסר נתון על הדפים בגוגל":"פחות דפים בגוגל מהיעד");
const imps=c?Math.round(c.imps):null,ip=S&&S.prev?Math.round(S.prev.imps):null,ap2=S&&S.prev?Math.round(S.prev.clicks):null;
// Google clicks a week, from the 28 days Search Console gives (up to 4 weeks, oldest first)
const gd=S&&S.days?S.days:[],gw=[];if(sd)for(let i=3;i>=0;i--){const e=addD(sd,-7*i);let v=0,any=false;gd.forEach(r=>{if(r[0]<=e&&r[0]>addD(e,-7)){v+=r[1];any=true}});if(any)gw.push([e,v])}
t2={s,dl:c?delta(a,ap2):"",gl:exp>=1?n(a/exp*100)+"% מהיעד השבועי ("+n(exp)+")":"",gp:exp>=1?a/exp:0,gn:c&&exp<1?gtxtN("google_clicks_week",GC,sd):"",
 sp:spark(gw.map(x=>x[1]),gw.map(x=>wl(x[0])),n),sub:'דפים שמופיעים בגוגל: <b>'+(X?n(X.indexed):"-")+"</b>"+(X?" מתוך "+n(X.total||X.inspected):"")+" "+mini(ps),title:"כניסות מגוגל בשבוע",big:n(a),lines:[c?gtxtN("google_clicks_week",GC,sd):"Search Console לא ענה","הופענו בתוצאות החיפוש "+n(imps)+" פעמים"+(ip!=null?" (שבוע קודם "+n(ip)+")":""),
 'דפים שמופיעים בגוגל: <b>'+(X?n(X.indexed):"-")+"</b>"+(X?" מתוך "+n(X.total||X.inspected)+" באתר":"")+" "+mini(ps)],win:S&&S.range?rng(S.range):"",foot:"גוגל מוסר באיחור של 3 ימים"}}

// 3. arrived from a share
let t3;{const GS=goal("share_per_100",end||new Date().toISOString().slice(0,10)),Lw=ge(E0,"car_lookup"),Sw=ge(E0,"share"),Lm=ge(E2,"car_lookup"),Sm=ge(E2,"share"),sh=W&&W.shared;let rate=null,win="",s;
if(!ev)s="nodata";else{if(Lw>=100){rate=Sw/Lw*100;win=rng(W.W)}else if(Lm>=100){rate=Sm/Lm*100;win=rng(W.M)+" (28 ימים, עד שיש 100 בדיקות בשבוע)"}
 if(rate==null)s="early";else if(cal)s="cal";else s=band(rate,GS,false,false)}
push("share",s,4,rate!=null?rate/GS[1]:1,"שיתופים: "+n1(rate)+" לכל 100 בדיקות, היעד "+n1(GS[1]),s==="nodata"?"חסר נתון על שיתופים":"מעט שיתופים");
const arr=sh?sh[0].web+sh[0].app:null,arrp=sh?sh[1].web+sh[1].app:null;
// last week's rate (when it had 100 checks) and the weekly rate over the weeks with at least 30 checks
const Lp1=ge(E1,"car_lookup"),rp=Lp1>=100?ge(E1,"share")/Lp1*100:null,rw=ENDS.map(e=>{const l=wsum("car_lookup",e),x=wsum("share",e);return l>=30&&x!=null?x/l*100:null});
const dR=rate!=null&&rp!=null?(rate>rp+.05?'<span class="up">▲ '+n1(rate-rp)+"</span> יותר מהשבוע הקודם ("+n1(rp)+")":rate<rp-.05?'<span class="down">▼ '+n1(rp-rate)+"</span> פחות מהשבוע הקודם ("+n1(rp)+")":'<span class="flat">כמו בשבוע הקודם</span>'):"";
t3={s,rate,dl:dR,gl:rate!=null&&!cal?n(rate/GS[1]*100)+"% מהיעד ("+n1(GS[1])+")":"",gp:rate!=null?rate/GS[1]:0,gn:rate==null&&ev?"עוד מעט מדי בדיקות כדי לחשב: "+n(Sw)+" שיתופים מתוך "+n(Lw)+" בדיקות":rate!=null&&cal?"היעד "+n1(GS[1])+" לכל 100 בדיקות":"",
 sp:spark(rw,ENDS.map(wl),n1),sub:sh?"נכנסו מקישור ששותף: <b>"+n(arr)+"</b>"+(arrp!=null?" (שבוע קודם "+n(arrp)+")":""):"",title:"שיתופים לכל 100 בדיקות",big:!ev?"-":rate!=null?(rate>=10?n(rate):n1(rate)):n(Sw),unit:!ev||rate!=null?"":"שיתופים",lines:[!ev?"גוגל אנליטיקס לא ענה":rate!=null?gtxt(GS):"עוד מעט מדי בדיקות כדי לחשב: "+n(Sw)+" שיתופים מתוך "+n(Lw)+" בדיקות","נכנסו מקישור ששותף: <b>"+n(arr)+"</b>"+(arrp!=null?" (שבוע קודם "+n(arrp)+")":""),sh&&sh[0].inst?"התקינו את האפליקציה מקישור ששותף: <b>"+n(sh[0].inst)+"</b>":""],win:win||rng(W&&W.W),foot:"אפליקציה ואתר"}}

// Google Play: the public store page says whether anyone can install; Play Console, when connected, says where the production release stands
const RL=d.release&&d.release.ok?d.release:null,top=RL&&RL.list&&RL.list[0]||null;
// Google Play statistics reports, when connected: exact installs from the store, a few days late
const PS=d.stats&&d.stats.ok&&d.stats.cur?d.stats:null;
const RU={draft:"עדכון בטיוטה",not_sent_for_review:"עדכון שעוד לא נשלח לבדיקה",in_review:"עדכון בבדיקה",approved_not_published:"עדכון שאושר ומחכה שתפרסם",not_approved:"עדכון שנדחה בבדיקה"};
const GP=d.play==="live"?{s:top&&top.state==="not_approved"?"bad":"ok",txt:"באוויר בחנות"+(top&&RU[top.state]?" · "+RU[top.state]:"")}:top?{s:(RS[top.state]||[0,"wait"])[1],txt:(RS[top.state]||[top.state?"מצב "+esc(top.state):"מצב לא ידוע"])[0]}:RL?{s:"wait",txt:"עוד אין גרסה בחנות"}:d.play==="review"?{s:"wait",txt:"עדיין לא פתוח לכולם"}:{s:"wait",txt:"לא הצלחתי לבדוק את דף החנות"};
// installed now: Google Play's count of devices in Israel that have the app, on the last day its reports reached, plus first opens minus
// removals in Analytics since that day (today and yesterday at least what the realtime tally saw, as the day's report lags hours behind);
// without Play reports, Analytics alone since 1.10
let inst=null,instHow="",instMin=false,instToday=null,instTodayMin=false;{const LF=d.daily&&d.daily.life,td0=new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Jerusalem"}),rf=(d.events||[]).find(e=>e[0]==="first_open"),rtf=d.rtToday?d.rtToday.first_open:rf?rf[1]:0,pa=PS&&PS.active!=null?PS.activeDay:"";
if(LF){const yd0=new Date(Date.parse(td0+"T12:00:00Z")-864e5).toISOString().slice(0,10),rty=d.rtYday?d.rtYday.first_open||0:0;let fo=LF[td0]?0:rtf,rm=0;instMin=rtf>(LF[td0]?LF[td0][0]:0);if(yd0>pa&&!LF[yd0])fo+=rty;for(const [k,v] of Object.entries(LF))if(k>pa){fo+=k===td0?Math.max(v[0],rtf):k===yd0?Math.max(v[0],rty):v[0];rm+=v[1]}
 inst=(pa?PS.active:0)+fo-rm;instHow=(pa?n(PS.active)+" מכשירים לפי Google Play ב-"+dm(pa)+", ועוד ":"")+n(fo)+" התקנות חדשות פחות "+n(rm)+" הסרות "+(pa?"מאז":"מ-1.10")+", לפי גוגל אנליטיקס"+(instMin?". ההתקנות של היום נספרות בינתיים בזמן אמת, כל 10 דקות, עד שגוגל אנליטיקס יעבד את היום":"")}
else if(pa){inst=PS.active;instHow="לפי Google Play ב-"+dm(pa)}
// today, so far: Analytics' report of today, or more when realtime saw more (realtime counts only while this screen is open: a minimum)
{const tdv=LF&&LF[td0]?LF[td0][0]:null;instToday=tdv==null?rtf:Math.max(tdv,rtf);instTodayMin=tdv==null||rtf>tdv}}
// 4. new app installs a week: first opens in Israel, the same week as the other tiles; under them what is installed now and the store status
let t4;{const A=W&&W.app,a=A?A[0].newUsers:null,ap=A?A[1].newUsers:null,live=d.play==="live",GI=RI==null?null:goal("installs_week",end,RI),tg=live&&!cal&&GI?GI[1]:null;let s;
if(a==null)s="nodata";else if(!live)s="early";else if(cal)s="cal";else s=band(a,GI,false,true);
push("installs",s,5,tg?a/tg:1,"התקנות חדשות: "+n(a)+(tg?", היעד "+n(tg):""),s==="nodata"?"חסר נתון על התקנות":"מעט התקנות");
push("store",GP.s,0,0,"Google Play: הגרסה החדשה נדחתה בבדיקה של גוגל. הסיבה במייל ובקונסול","גרסה חדשה נדחתה בבדיקה של גוגל","נדחתה");
t4={s,dl:delta(a,ap),gl:tg?n(a/tg*100)+"% מהיעד השבועי ("+n(tg)+")":"",gp:tg?a/tg:0,gn:!live?"עד שהאפליקציה בחנות, מתקינים רק בודקים":GP.s!=="ok"||GP.txt.indexOf("·")>=0?"Google Play: "+GP.txt:"",
 sp:spark(ENDS.map(e=>wsum("first_open",e)),ENDS.map(wl),n),
 sub:[inst!=null?"מותקנת עכשיו: <b>"+(instMin?"לפחות ":"בערך ")+n(inst)+'</b> מכשירים (<a href="#dr-use" data-open="dr-use">איך מחושב</a>)':"",instToday!=null?"היום עד עכשיו: <b>"+(instTodayMin&&instToday>0?"לפחות ":"")+n(instToday)+"</b>":""].filter(Boolean).join("<br>"),title:"התקנות חדשות בשבוע",big:n(a),lines:[delta(a,ap),instToday!=null?"היום עד עכשיו: <b>"+(instTodayMin&&instToday>0?"לפחות ":"")+n(instToday)+"</b> התקנות חדשות (לא נכללות בשבוע)":"",inst!=null?"מותקנת עכשיו בסך הכול: <b>"+(instMin?"לפחות ":"בערך ")+n(inst)+'</b> מכשירים בישראל (הערכה, <a href="#dr-use" data-open="dr-use">איך מחושב</a>)':"",GP.s!=="ok"||GP.txt.indexOf("·")>=0?"Google Play: "+GP.txt+(!live&&!top&&d.play==="review"?" (הבקשה הוגשה "+dm(SUBMITTED)+")":""):"",tg?n(a/tg*100)+"% מהיעד ("+n(tg)+", טווח "+n(GI[0])+" עד "+n(GI[2])+")":live?"":"עד שהאפליקציה בחנות, מתקינים רק בודקים"],win:rng(W&&W.W),foot:"פתיחה ראשונה של האפליקציה בישראל"}}

// health: failures caused by us or the ministry, out of all attempts (a mistyped plate is not a failure)
let H;{const fk=W&&W.fails?W.fails[0]:null,tech=fk?(fk.source_down||0)+(fk.offline||0)+(fk.net_err||0)+(fk.js_err||0):null,att2=ev?ge(E0,"car_lookup")+ge(E0,"lookup_failed"):null;let s,r=null;
const GF=goal("failures_pct",end||new Date().toISOString().slice(0,10));
if(!fk||!ev)s="nodata";else if(att2<50)s="early";else{r=tech/att2*100;s=band(r,GF,true);if(s==="bad"&&tech<5)s="warn"}
push("health",s,0,r!=null?GF[1]/Math.max(r,.01):1,"בדיקות שנכשלו: "+n1(r)+"%, היעד עד "+n1(GF[1])+"%","",s==="bad"?"יותר מדי כשלים":s==="warn"?"מעט יותר כשלים":"");
H={s,r,tech,att:att2}}

// slow checks: the share of the week's car checks that took more than 5 seconds (Dudu, 23.10), by the duration bucket every version sends
// alike; it needs attention above 10%, and is judged from 50 checks with a known bucket
let SL5;{const DU=W&&W.dur,sl=o=>{const k=(o.lt2||0)+(o["2to5"]||0)+(o["5to10"]||0)+(o.gt10||0);return k?{k,p:((o["5to10"]||0)+(o.gt10||0))/k*100,p10:(o.gt10||0)/k*100}:null};
SL5=DU?{c:sl(DU[0]),p:sl(DU[1])}:null;
if(SL5&&SL5.c&&SL5.c.k>=50&&SL5.c.p>10)push("slow","warn",6,10/SL5.c.p,"בדיקות איטיות: "+n1(SL5.c.p)+"% מהבדיקות לקחו יותר מ-5 שניות","","מעל 10%")}

// bots: a failed or late bot is listed (I handle failures; this shows they exist), without changing the verdict
if(BL){const bad=BL.filter(o=>o.st[0]==="bad"||o.st[0]==="warn");if(bad.length)push("bots","warn",7,.5,"בוטים: "+bad.slice(0,3).map(o=>o.he+" ("+o.st[1]+")").join(", ")+(bad.length>3?" ועוד "+n(bad.length-3):""),"",bad.some(o=>o.st[0]==="bad")?"בוט נכשל":bad.some(o=>o.s==="off")?"בוט כבוי":"בוט באיחור")}

// verdict
att.sort((x,y)=>RANK[x.s]-RANK[y.s]||x.ratio-y.ratio||x.prio-y.prio);
const judged=["health","pages","store"].concat(cal?[]:["ns","clicks","share","installs"]).map(k=>M[k]);
const vs=judged.includes("bad")?"bad":judged.includes("nodata")?"nodata":judged.includes("warn")?"warn":judged.includes("ok")?"ok":cal?"cal":"early";
const head=t1.L==null?"אין עדיין נתון על בדיקות רכב השבוע.":t1.tg?"השבוע: "+n(t1.L)+" בדיקות רכב, "+n(t1.L/t1.tg*100)+"% מהיעד.":"השבוע: "+n(t1.L)+" בדיקות רכב"+(t1.Lp!=null?", "+(t1.L>t1.Lp?n(t1.L-t1.Lp)+" יותר מהשבוע הקודם":t1.L<t1.Lp?n(t1.Lp-t1.L)+" פחות מהשבוע הקודם":"כמו בשבוע הקודם"):"")+".";
const first=att.find(x=>x.short);const mid=first?first.short+".":H.s==="ok"?"אין מה לטפל בו.":"";
const tail=H.s==="ok"?"השירות תקין.":H.s==="warn"?n1(H.r)+"% מהבדיקות נכשלו, מעט מעל הרגיל.":H.s==="bad"?n1(H.r)+"% מהבדיקות נכשלו.":H.s==="early"?"מעט מדי בדיקות כדי לשפוט את תקינות השירות.":"אין נתון על תקינות השירות.";
$("vd").className="card verdict s-"+vs;$("vh").innerHTML=chip(vs,att[0]&&att[0].s===vs?att[0].w:"")+'<span class="lbl">השורה התחתונה</span>';$("vs").textContent=[head,mid,tail].filter(Boolean).join(" ");
{const Ed=d.daily&&d.daily.events,T=Ed&&Ed.today||{},rt=d.events||[],g=k=>(rt.find(e=>e[0]===k)||[0,0])[1],tc=T.car_lookup?T.car_lookup[0]:null,rc=d.rtToday&&d.rtToday.car_lookup!=null?d.rtToday.car_lookup:g("car_lookup"),ck=Ed?Math.max(tc||0,rc):d.rtToday?rc:null;
onl(d.online,d.stale,d.at);
$("vt").innerHTML=ck==null&&instToday==null&&d.visitsToday==null?"":"<span>היום עד עכשיו:</span>"+(ck!=null?"<span><b>"+n(ck)+"</b> בדיקות רכב</span>":"")+(instToday!=null?"<span><b>"+n(instToday)+"</b> התקנות חדשות</span>":"")+(d.visitsToday!=null?"<span><b>"+n(d.visitsToday)+"</b> ביקורים באתר</span>":"")+'<a href="#dr-now" data-open="dr-now">לפירוט</a>'}
$("vn").textContent=cal?"שבוע הבסיס הוא "+rng([addD(CB.end,-6),CB.end])+": לפיו ייקבעו היעדים לבדיקות רכב ולהתקנות, ומ-"+dm(COLS)+" בצהריים כל מספר יקבל צבע מול היעד שלו. עד אז יש צבע רק לתקינות השירות, לדפים בגוגל ולחנות. בדיקות מהאתר נספרות מ-15.10.":"";

// attention list
const alerts=(d.flashes||[]).filter(f=>f.l==="alert"&&!f.q&&Date.now()-Date.parse(f.t)<864e5).length;
$("att").innerHTML=(att.length?att.slice(0,4).map(x=>"<li>"+chip(x.s,x.w||(x.s==="warn"?"מעט מתחת ליעד":""))+"<span>"+esc(x.text)+(DR[x.key]?' <a href="#'+DR[x.key]+'" data-open="'+DR[x.key]+'">לפירוט</a>':"")+"</span></li>").join(""):'<li class="none">אין כרגע דבר שדורש תשומת לב.</li>')+(alerts?'<li><span class="chip s-warn"><i aria-hidden="true">!</i>מבזקים</span><span>'+(alerts===1?"התראה אחת על תקלה":n(alerts)+" התראות על תקלות")+' ב-24 השעות האחרונות. <a href="#dr-fl" data-open="dr-fl">לפירוט</a></span></li>':"");

// tiles
// one panel, four numbers: status, the number, the change from last week, the way to the goal, the last weeks, one fact under it
const tile=t=>'<article class="kpi s-'+t.s+'"><div class="kh"><h3>'+t.title+(t.win?'<small class="win">'+t.win+"</small>":"")+"</h3>"+chip(t.s)+'</div><div class="big">'+t.big+(t.unit?"<small>"+t.unit+"</small>":"")+'</div><p class="dl">'+(t.dl||"")+"</p>"
 +(t.gl?'<div class="gb" role="img" aria-label="'+esc(t.gl)+'"><i style="width:'+Math.max(2,Math.min(100,t.gp*100))+'%"></i></div><p class="m">'+t.gl+"</p>":t.gn?'<p class="m">'+t.gn+"</p>":"")
 +(t.sp||"")+(t.sub?'<p class="m">'+t.sub+"</p>":"")+(t.help?'<p class="help">'+t.help+"</p>":"")+'<p class="foot">'+t.foot+(t.dd?' · <a href="#'+t.dd+'" data-open="'+t.dd+'">לפירוט</a>':"")+'</p><span class="more">לפרטים</span></article>';
t1.dd="dr-src";t2.dd="dr-seo";t3.dd="dr-q";t4.dd="dr-use";t1.help=HT.t1;t2.help=HT.t2;t3.help=HT.t3;t4.help=HT.t4;
$("tiles").innerHTML=[t1,t2,t3,t4].map(tile).join("");

// milestones
{const A=W&&W.app,mau=A?A[2].activeUsers:null,mo=W&&W.money,pt=hm(d.playAt),td=new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Jerusalem"}),GA=goal("app_active_28d",td),GN=goal("subscribers_total",td);
$("ms").innerHTML='<li><span class="k">Google Play</span><span class="v">'+GP.txt+(GP.s==="ok"&&GP.txt.indexOf("·")<0?" ✓":"")+'</span><span class="k">'+[top?"הגרסה האחרונה: "+esc(top.name||"")+" ("+(RS[top.state]||["מצב לא ידוע"])[0]+", לפי Play Console"+(RL.at?", נבדק ב-"+hm(RL.at):"")+").":RL&&d.play!=="live"?"אחרי אישור הבקשה צריך ליצור גרסה לחנות, ואז יופיע כאן אם היא בבדיקה, אושרה או נדחתה.":"",d.play!=="live"&&!(top||RL)?"הבקשה הוגשה ב-"+dm(SUBMITTED)+". אישור Google מגיע במייל ובקונסול; כאן הסטטוס מתחלף כשהאפליקציה מופיעה בחנות לכולם.":"",!top&&(d.play==="live"||!RL)?(pt?"דף החנות הציבורי נבדק ב-"+pt+".":"דף החנות הציבורי נבדק כל שעה."):""].filter(Boolean).join(" ")+"</span></li>"
+'<li><span class="k">הדרך למנוי PRO: משתמשים באפליקציה בישראל ב-28 הימים האחרונים</span><span class="v">'+n(mau)+" מתוך "+n(PRO_MAU)+'</span><div class="bar" role="img" aria-label="'+n(mau)+" מתוך "+n(PRO_MAU)+'"><i style="width:'+Math.max(1,Math.min(100,(mau||0)/PRO_MAU*100))+'%"></i></div><span class="k">'+(mau!=null&&!cal?mini(band(mau,GA,false,true))+" ":"")+"מנוי בתשלום מפעילים רק כשיש 2,000 עד 3,000 משתמשים בחודש. היעד להיום: "+n(GA[1])+" (טווח "+n(GA[0])+" עד "+n(GA[2])+").</span></li>"
+'<li><span class="k">פניות עסקיות ונרשמים למגזין (מ-1.10)</span><span class="v">'+(mo?n(mo.leads)+" פניות עסקיות · "+n(mo.subscribers)+" נרשמים למגזין":"אין נתון")+'</span><span class="k">'+(mo&&!cal?mini(band(mo.subscribers,GN,false,true))+" ":"")+"היעד להיום: "+n(GN[1])+" נרשמים (טווח "+n(GN[0])+" עד "+n(GN[2])+"). לפניות עסקיות אין יעד עד שמתחילים למכור."+'</span></li>'}

// trend: weekly car checks, up to 8 weeks, oldest on the left so the latest week sits next to the right edge, each split into the app
// (below) and the site (above); weeks before the first counted check are left out (they would read as a drop to zero)
{const box=$("tr");if(!ENDS.length){box.innerHTML='<p class="note">אין עדיין נתון היסטורי מגוגל אנליטיקס.</p>';$("trn").textContent="";$("trs").textContent=""}else{
const k=ENDS.length,tot=ENDS.map(week),st=ENDS.map(e=>Math.min(wsum("site_lookup",e)||0,week(e))),tgs=ENDS.map(nsTarget),mx=Math.max(1,...tot,...tgs.filter(Boolean))*1.16;
const nar=box.clientWidth&&box.clientWidth<520,VW=nar?360:640,X0=nar?4:12,SW=(VW-2*X0)/k,BW=Math.min(58,SW*.62),H=172,Y=v=>H-v/mx*(H-30);let g='<line class="t-base" x1="'+X0+'" x2="'+(VW-X0)+'" y1="'+H+'" y2="'+H+'"/>';
ENDS.forEach((e,i)=>{const x=X0+i*SW,cx=x+SW/2,v=tot[i],sv=st[i],av=v-sv,ya=Y(av),yt=Y(v),lb=wl(e);
 if(av)g+='<rect class="t-app" x="'+(cx-BW/2)+'" y="'+ya+'" width="'+BW+'" height="'+(H-ya)+'" rx="3"><title>'+lb+": באפליקציה "+n(av)+"</title></rect>";
 if(sv&&ya-yt>2)g+='<rect class="t-site" x="'+(cx-BW/2)+'" y="'+yt+'" width="'+BW+'" height="'+(ya-yt-2)+'" rx="3"><title>'+lb+": באתר "+n(sv)+"</title></rect>";
 g+='<text class="t-val" x="'+cx+'" y="'+(yt-6)+'" text-anchor="middle">'+n(v)+'</text><text class="t-lbl" x="'+cx+'" y="'+(H+18)+'" text-anchor="middle">'+(nar?"":"עד ")+dm(e)+"</text>";
 if(tgs[i])g+='<line class="t-goal" x1="'+(cx-BW/2-6)+'" x2="'+(cx+BW/2+6)+'" y1="'+Y(tgs[i])+'" y2="'+Y(tgs[i])+'"><title>היעד לשבוע: '+n(tgs[i])+"</title></line>";
 // the label stands on the later side of the line (the weeks it speaks of), unless it would run off the chart
 if(addD(e,-6)<="2026-10-15"&&e>="2026-10-15")g+='<line class="t-mark" x1="'+(x+2)+'" x2="'+(x+2)+'" y1="16" y2="'+H+'"/><text class="t-lbl" x="'+(x+112<VW-4?x+6:x-2)+'" y="12" text-anchor="'+(x+112<VW-4?"start":"end")+'">מכאן נספר גם האתר</text>'});
box.innerHTML='<svg viewBox="0 0 '+VW+' 196" direction="ltr" style="direction:ltr" role="img" aria-label="בדיקות רכב בשבוע: '+tot.map(n).join(", ")+'">'+g+"</svg>";
const L0=tot[k-1],S0=st[k-1],P0=k>1?tot[k-2]:null;
$("trs").innerHTML="השבוע שהסתיים אתמול: <b>"+n(L0)+"</b> בדיקות, "+n(L0-S0)+" באפליקציה ו-"+n(S0)+" באתר"+(P0!=null?(L0>P0?", <b>"+n(Math.round((L0-P0)/Math.max(1,P0)*100))+"%</b> יותר מהשבוע שלפניו":L0<P0?", <b>"+n(Math.round((P0-L0)/Math.max(1,P0)*100))+"%</b> פחות מהשבוע שלפניו":""):"")+".";
$("trn").textContent=cal?"היעד השבועי יופיע מהשבוע שאחרי שבוע הבסיס ("+rng([addD(CB.end,-6),CB.end])+").":"הקו המקווקו הוא היעד של כל שבוע."}}

// where the week's site checks came from: a ring by source, in a fixed order and colour per source, with a table of the numbers
{const box=$("dn"),B=W&&W.bySource;
const G=[["social","רשתות וקישורים שלנו",["facebook","instagram","tiktok","youtube","whatsapp","linkedin","newsletter","press","dealer","qr"]],["search","חיפוש בגוגל ובמנועים אחרים",["google","search"]],["direct","ישיר, בלי מקור מזוהה",["direct"]],["share","דוחות רכב ששותפו",["share"]],["site","מדפים אחרים באתר",["site"]],["other","אתרים ואפליקציות אחרים",["other"]]];
if(!B){box.innerHTML='<p class="note">גוגל אנליטיקס לא ענה על המקורות.</p>';$("dns").textContent=""}else{
const c=B[0],val=ks=>ks.reduce((a,k)=>a+((c[k]||[0,0])[1]),0),rows=G.map(x=>[x[0],x[1],val(x[2])]),tot=rows.reduce((a,r)=>a+r[2],0),unk=(c.unknown||[0,0])[1];
if(!tot){box.innerHTML='<p class="note">עוד אין השבוע בדיקות באתר עם מקור ידוע.</p>';$("dns").textContent=""}else{
const C=2*Math.PI*56;let off=0,arcs="";
rows.forEach(r=>{if(!r[2])return;const len=r[2]/tot*C,gap=rows.filter(x=>x[2]).length>1?2:0;arcs+='<circle class="d-'+r[0]+'" r="56" cx="80" cy="80" fill="none" stroke-width="24" stroke-dasharray="'+Math.max(.5,len-gap)+" "+(C-Math.max(.5,len-gap))+'" stroke-dashoffset="'+(-off)+'" transform="rotate(-90 80 80)"><title>'+r[1]+": "+n(r[2])+"</title></circle>";off+=len});
const top=rows.slice().sort((a,b)=>b[2]-a[2])[0];
$("dns").innerHTML="הכי הרבה: <b>"+top[1]+"</b>, "+n(top[2]/tot*100)+"% מהבדיקות באתר ("+rng(W.W)+").";
box.innerHTML='<div class="dn"><svg viewBox="0 0 160 160" role="img" aria-label="'+rows.filter(r=>r[2]).map(r=>r[1]+" "+n(r[2])).join(", ")+'">'+arcs+'<text x="80" y="82" text-anchor="middle" class="d-big">'+n(tot)+'</text><text x="80" y="102" text-anchor="middle" class="d-lbl">בדיקות באתר</text></svg>'
+'<table class="t tg"><tbody>'+rows.map(r=>'<tr><td class="w"><span class="sw sw-'+r[0]+'"></span>'+r[1]+'</td><td class="n">'+n(r[2])+'</td><td class="n">'+(r[2]?n(r[2]/tot*100)+"%":"-")+"</td></tr>").join("")+"</tbody></table></div>"
+(unk?'<p class="note">עוד '+n(unk)+" בדיקות באתר בלי מקור: לפני 20.10, כשהמקור עוד לא נמדד.</p>":"")+'<p class="note">רשתות וקישורים שלנו: פייסבוק, אינסטגרם, טיקטוק, יוטיוב, וואטסאפ וקישורי go/. הפירוט לפי רשת וקישור במגירה <a href="#dr-src" data-open="dr-src">מקורות</a>.</p>'}}}

// this week against last week, per action: two bars on each action's own scale, and the change in percent
{const box=$("cm");if(!ev){box.innerHTML='<p class="note">גוגל אנליטיקס לא ענה.</p>';$("cms").textContent=""}else{const A=W.app,part=W.W&&addD(W.W[0],-7)<SITE_FROM;
const R=[["כניסות לאתר",ge(E0,"web_visit"),ge(E1,"web_visit"),part],["בדיקות רכב",ge(E0,"car_lookup"),ge(E1,"car_lookup"),part],["שמירת רכב",ge(E0,"car_save"),ge(E1,"car_save")],["שיתופים",ge(E0,"share"),ge(E1,"share"),part],["התקנות חדשות",A?A[0].newUsers:null,A?A[1].newUsers:null]];
const pc=(a,b)=>a==null||b==null?"-":!b?(a?"חדש":"-"):a===b?'<span class="flat">0%</span>':a>b?'<span class="up">▲ '+n((a-b)/b*100)+"%</span>":'<span class="down">▼ '+n((b-a)/b*100)+"%</span>";
$("cms").textContent=rng(W.W)+" מול "+rng(W.P)+".";
box.innerHTML=R.map(r=>{const mx=Math.max(1,r[1]||0,r[2]||0);return '<div class="cmr"><span>'+r[0]+'</span><div class="bb"><i class="c" style="width:'+((r[1]||0)/mx*100)+'%" title="השבוע: '+n(r[1])+'"></i><i class="p" style="width:'+((r[2]||0)/mx*100)+'%" title="שבוע קודם: '+n(r[2])+'"></i></div><span class="pc">'+pc(r[1],r[2])+'</span><span class="nn">'+n(r[1])+" מול "+n(r[2])+(r[3]?" (בשבוע הקודם האתר נספר רק מ-"+dm(SITE_FROM)+")":"")+"</span></div>"}).join("")}}

// day by day, the last 28 days: car checks, new installs, site visits (the site is counted from SITE_FROM)
{const box=$("dl");if(!SR||!end){box.innerHTML='<p class="note">אין עדיין נתון יומי מגוגל אנליטיקס.</p>'}else{const D=[];for(let i=27;i>=0;i--)D.push(addD(end,-i));
const M3=[["car_lookup","בדיקות רכב"],["first_open","התקנות חדשות"],["web_visit","כניסות לאתר",SITE_FROM]];
box.innerHTML=M3.map(m=>{const o=SR[m[0]]||{},v=D.map(x=>m[2]&&x<m[2]?null:o[x]||0),vv=v.filter(x=>x!=null),mx=Math.max(1,...vv),sum=vv.reduce((a,b)=>a+b,0),avg=vv.length?sum/vv.length:0;
 const bars=v.map((x,i)=>{if(!x)return "";const h=Math.max(2,x/mx*44);return '<rect x="'+(i*10+1)+'" y="'+(48-h)+'" width="8" height="'+h+'" rx="1.5"><title>'+dm(D[i])+": "+n(x)+"</title></rect>"}).join("");
 return '<div class="dm"><div class="dmh"><b>'+m[1]+"</b><span>"+n1(avg)+" ביום בממוצע, הכי הרבה "+n(mx)+'</span></div><svg class="spark" viewBox="0 0 280 50" direction="ltr" style="direction:ltr" role="img" aria-label="'+m[1]+' לפי יום">'+bars+'</svg><div class="axis"><span>'+dm(D[0])+"</span><span>"+dm(D[27])+"</span></div></div>"}).join("")}}

// the weekly funnel. On the site: visits, car checks, clicks on the install button (events, by platform from the day-by-day events when GA4
// gave them). In the app, devices: opened it this week, checked a car, saved one (the same device counts as the savers line). Each step
// against the one before it, this week with the week before under it in grey
{const box=$("fn"),E28=W&&W.e28,or=(a,b)=>a==null?b:a,pw=(k,i)=>{const o=E28&&E28[k];return o?o.w.slice(i?14:21,i?21:28).reduce((x,y)=>x+y,0):null};
if(!ev){box.innerHTML='<p class="note">גוגל אנליטיקס לא ענה.</p>';$("fns").textContent=""}else{const site=wsum("site_lookup",end),siteP=wsum("site_lookup",addD(end,-7)),A=W.app,SV=W.savers||{},SP=W.saversP||{};
const S=[["כניסות לאתר",or(pw("web_visit",0),ge(E0,"web_visit")),or(pw("web_visit",1),ge(E1,"web_visit"))],["בדיקות רכב באתר",or(pw("car_lookup",0),site),or(pw("car_lookup",1),siteP)],["לחיצות «להתקנה»",or(pw("web_install_click",0),ge(E0,"web_install_click")),or(pw("web_install_click",1),ge(E1,"web_install_click"))]];
const AP=[["פתחו את האפליקציה",A?A[0].totalUsers||null:null,A?A[1].totalUsers||null:null],["בדקו רכב",SV.car_lookup||null,SP.car_lookup||null],["שמרו רכב",SV.car_save||0,SP.car_save||0]];
const pc=(a,b)=>a==null||!b?"-":a>b?"פי "+n1(a/b):Math.round(a/b*100)+"%";
// every bar is scaled on the largest number of its block (26.10: a step larger than the first, more checks than visits, ran over its number)
const fun=(t,R)=>{const mx=Math.max(1,...R.map(r=>Math.max(r[1]||0,r[2]||0)));return '<div class="fn"><h4>'+t+"</h4>"+R.map((r,i)=>(i?'<div class="fs"><i>↓</i> '+pc(r[1],R[i-1][1])+" מהשלב הקודם"+(r[1]>R[i-1][1]&&R[i-1][1]?" (אפשר לבדוק כמה רכבים בכניסה אחת)":"")+(R[i-1][2]&&r[2]!=null?' <span class="flat">(שבוע קודם '+pc(r[2],R[i-1][2])+")</span>":"")+"</div>":"")+'<div class="fr"><span>'+r[0]+'</span><div class="fb"><i class="c" style="width:'+(r[1]?Math.max(1,r[1]/mx*100):0)+'%" title="השבוע: '+n(r[1])+'"></i><i class="p" style="width:'+(r[2]?Math.max(1,r[2]/mx*100):0)+'%" title="שבוע קודם: '+n(r[2])+'"></i></div><span class="pc">'+n(r[1])+'</span><span class="nn">'+(r[2]===0&&!i&&r[1]>0?"שבוע קודם: עוד לא נמדד":"שבוע קודם "+n(r[2]))+"</span></div>").join("")+"</div>"};
box.innerHTML=fun("באתר ("+rng(W.W)+")",S)+fun("באפליקציה, מכשירים ("+rng(W.W)+")",AP);
$("fns").innerHTML="באתר: "+(S[0][1]&&S[1][1]>S[0][1]?"<b>"+n1(S[1][1]/S[0][1])+"</b> בדיקות רכב לכל כניסה (יש מי שבודק כמה רכבים)":"<b>"+pc(S[1][1],S[0][1])+"</b> מהנכנסים בדקו רכב")+", ו-<b>"+pc(S[2][1],S[1][1])+"</b> מהבדיקות הביאו ללחיצה על «להתקנה». באפליקציה: <b>"+pc(AP[1][1],AP[0][1])+"</b> מהמכשירים שנפתחו בדקו רכב, ו-<b>"+pc(AP[2][1],AP[1][1])+"</b> מהבודקים שמרו. "+'<a href="#dr-use" data-open="dr-use">לפירוט</a>'}}

// health: the service, speed, crashes and the bots, side by side
{const box=$("hl"),cr=ev?ge(E0,"app_exception"):null,crp=ev?ge(E1,"app_exception"):null,sl=SL5&&SL5.c,slS=!sl?"nodata":sl.k<50?"early":sl.p>10?"warn":"ok";
const cell=(t,s,w,big,sub,win,dd,help)=>'<div class="hc s-'+s+'"><h3><span>'+t+(win?'<small class="win">'+win+"</small>":"")+"</span>"+(s?chip(s,w):"")+'</h3><div class="big">'+big+"</div><p>"+sub+(dd?' <a href="#'+dd+'" data-open="'+dd+'">לפירוט</a>':"")+"</p>"+(help?'<p class="help">'+help+"</p>":"")+'<span class="more">לפרטים</span></div>';
const RA=d.rating&&d.rating.ok?d.rating:null,raS=!RA?"nodata":RA.n<5?"early":RA.avg>=4.5?"ok":"warn",raLeft=RA?Math.max(0,21-RA.n):21;
const okN=BL?BL.filter(o=>o.st[0]==="ok").length:0,probs=BL?BL.filter(o=>o.st[0]!=="ok"):[],bS=!BL?"nodata":probs.some(o=>o.st[0]==="bad")?"bad":probs.some(o=>o.st[0]==="warn")?"warn":"ok";
box.innerHTML=cell("השירות",H.s,H.s==="bad"?"יותר מדי כשלים":"",H.r!=null?n1(100-H.r)+"%":"-",H.r!=null?"מהבדיקות קיבלו תשובה. נכשלו <b>"+n(H.tech)+"</b> מתוך "+n(H.att)+". מספר שהוקלד לא נכון לא נחשב כשל.":"אין עדיין מספיק בדיקות כדי לשפוט.",rng(W&&W.W),"dr-tec",HT.h1)
+cell("בדיקות איטיות",slS,slS==="warn"?"מעל 10%":"",sl?n1(sl.p)+"%":"-",sl?"מהבדיקות לקחו יותר מ-5 שניות. עד 10% זה תקין.":"אין נתון על משך הבדיקות.",rng(W&&W.W),"dr-tec",HT.h2)
+cell("קריסות",null,"",n(cr),"קריסות של האפליקציה"+(crp!=null?", בשבוע הקודם "+n(crp):"")+'. <a href="#dr-tec" data-open="dr-tec">לפירוט</a>',rng(W&&W.W),"",HT.h3)
+cell("דירוג בחנות",raS,raS==="ok"?"4.5 ומעלה":raS==="warn"?"מתחת ל-4.5":"",RA&&RA.avg!=null?n1(RA.avg)+'<small style="font-size:.9rem;font-weight:500;color:var(--muted)"> ★ מתוך 5</small>':"-",
 RA?"<b>"+n(RA.n)+"</b> דירוגים, "+n(RA.txt)+" מהם עם ביקורת כתובה. "+(raLeft?"עד היעד של M3 (דירוג 4.5 ומעלה ו-21 דירוגים) חסרים עוד <b>"+n(raLeft)+"</b>.":"יש מספיק דירוגים ליעד של M3 (21).")+(RA.own?" הממוצע מחושב מהביקורות.":""):"עוד אין דירוגים בדוחות של Google Play. הם מתעדכנים פעם ביום, באיחור של כמה ימים.","מאז ההשקה","dr-ms",HT.h4)
+cell("בוטים",bS,bS==="bad"?"בוט נכשל":bS==="warn"?"בוט באיחור":"",BL?n(okN)+"<small style=\\"font-size:.9rem;font-weight:500;color:var(--muted)\\"> מתוך "+n(BL.length)+"</small>":"-",
 BL?'<span class="dots">'+BL.map(o=>'<span class="s-'+o.st[0]+'" title="'+esc(o.he+": "+o.st[1])+'">'+(o.st[0]==="bad"?"✕":o.st[0]==="warn"?"!":"")+"</span>").join("")+"</span>"+(probs.length?probs.slice(0,3).map(o=>esc(o.he)+": "+o.st[1]).join(", ")+". ":"כל המשימות האוטומטיות רצות כרגיל. ")+'<a href="#dr-bots" data-open="dr-bots">לרשימה</a>':"הרשימה תתמלא אחרי הריצה הבאה של שומר הדשבורד (כל חצי שעה).","",HT.h5)}

// drawer: bots, problems first, then by group
{const box=$("bots");if(!BL){box.innerHTML='<p class="note">הרשימה תתמלא אחרי הריצה הבאה של שומר הדשבורד, שרץ כל חצי שעה.</p>'}else{const RK={bad:0,warn:1,nodata:2,early:3,ok:4},GO=["ניטור","נתונים","גוגל","תוכן ושיווק","פריסה","אחר"];
const L2=BL.slice().sort((a,b)=>RK[a.st[0]]-RK[b.st[0]]||GO.indexOf(a.gr)-GO.indexOf(b.gr)||a.he.localeCompare(b.he,"he"));
box.innerHTML='<div style="overflow-x:auto"><table class="t tg"><thead><tr><th>בוט</th><th>מתי רץ</th><th>ריצה אחרונה</th><th>מצב</th></tr></thead><tbody>'
+L2.map(o=>'<tr><td class="w">'+esc(o.he)+'<small style="display:block;color:var(--muted)">'+esc(o.gr)+(BD[o.f]?" · "+BD[o.f]:"")+'</small></td><td>'+esc(o.w||every(o.p))+"</td><td>"+(o.t?(o.u&&o.u.indexOf("https://github.com/")===0?'<a href="'+esc(o.u)+'" target="_blank" rel="noopener">'+hm(o.t)+"</a>":hm(o.t)):"-")+(o.run?' <small style="color:var(--muted)">(רץ עכשיו)</small>':"")+"</td><td>"+chip(o.st[0],o.st[1])+"</td></tr>").join("")+"</tbody></table></div>"
+'<p class="note">כל משימה אוטומטית שרצה לפי שעון, וגם הפריסות. השעות בשעון ישראל. באיחור: לא רצה זמן ארוך מהרגיל שלה. דילג: הריצה האחרונה לא הייתה צריכה לעשות דבר (למשל שינוי באתר שלא נוגע לה), וזה תקין. כבוי: מושבת ב-GitHub. כשבוט נכשל מגיעה התראה, ואני מטפל בה. הרשימה עודכנה '+hm(BO.at)+".</p>"}}

// drawer: now
// problems = checks that failed and app crashes; a slow or cancelled check is not a problem, and a check that ran out of time is already a failed one
{const rt=d.events||[],g=k=>(rt.find(e=>e[0]===k)||[0,0])[1],bad=g("lookup_failed")+g("app_exception"),Ed=d.daily&&d.daily.events,T=Ed&&Ed.today||{},Y=Ed&&Ed.yesterday||{},dv=(o,k)=>o[k]?o[k][0]:0;
const li=(l,v,s)=>"<li><span>"+l+(s?"<small>"+s+"</small>":"")+"</span><b>"+v+"</b></li>";
// today's report lags hours behind: when the last 30 minutes alone saw more than it has, today is at least that many
const sofar=(k,l,s)=>{const t=Ed?dv(T,k):null,r=d.rtToday&&d.rtToday[k]!=null?d.rtToday[k]:d.events?g(k):0,low=t!=null&&r>t;return li(l,t==null?"-":low?"לפחות "+n(r):n(t),(low?"לפי הספירה בזמן אמת. ":"")+s+" אתמול, יום שלם: "+(Ed?n(Math.max(dv(Y,k),d.rtYday&&d.rtYday[k]||0)):"-"))};
$("now").innerHTML=li("באפליקציה, 30 הדקות האחרונות",n(d.activeUsers),"משתמשים בישראל")
+li("באתר, 30 הדקות האחרונות",d.events?n(g("web_visit")):"-","אנשים שנכנסו לאתר. מי שרענן את הדף או חזר אליו נספר פעם אחת")
+li("נכנסו לאתר מקישור, 30 הדקות האחרונות",d.events?n(g("link_landing")):"-","מתוך הנכנסים לאתר: מקישור לדוח רכב או להשוואה ששותפו, או מקישור go/ של רשת חברתית")
+li("בדיקות רכב, 30 הדקות האחרונות",d.events?n(g("car_lookup")):"-","באפליקציה ובאתר יחד")
+li("התקנות חדשות, 30 הדקות האחרונות",d.events?n(g("first_open")):"-","פתיחה ראשונה של האפליקציה בישראל")
+li("בעיות, 30 הדקות האחרונות",d.events?n(bad):"-",d.events?"בדיקות שנכשלו: "+n(g("lookup_failed"))+". קריסות של האפליקציה: "+n(g("app_exception"))+".":"")
+sofar("car_lookup","בדיקות רכב היום, עד כה","גוגל אנליטיקס מוסר את היום באיחור של כמה שעות.")
+sofar("first_open","התקנות חדשות היום, עד כה","פתיחה ראשונה של האפליקציה בישראל.")
+li("ביקורים באתר היום, עד כה",n(d.visitsToday),"כל דפי האתר, לפי Cloudflare. אתמול, יום שלם: "+n(d.visitsYesterday))}

// drawer: the yearly goals, now against the target of the day, and the month-end targets ahead
{const td=new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Jerusalem"}),Ad=W&&W.app,mo=W&&W.money,X2=d.metrics&&d.metrics.index,S2=d.seo&&d.seo.cur;
const R=[["weekly_checks","בדיקות רכב בשבוע",t1.L,end],["installs_week","התקנות חדשות בשבוע",Ad?Ad[0].newUsers:null,end],["google_clicks_week","כניסות מגוגל בשבוע",S2?Math.round(S2.clicks):null,d.seo&&d.seo.range?d.seo.range[1]:td],
 ["pages_indexed","דפים שמופיעים בגוגל",X2?X2.indexed:null,td],["share_per_100","שיתופים לכל 100 בדיקות",t3.rate,end],["app_active_28d","משתמשים באפליקציה ב-28 ימים",Ad?Ad[2].activeUsers:null,td],
 ["failures_pct","אחוז הבדיקות שנכשלו",H.r,end,1,true],["subscribers_total","נרשמים למגזין",mo?mo.subscribers:null,td]];
// counts in whole numbers, rates with one decimal
const nx=[0,5,11].map(i=>MONTHS[i]),RATE={share_per_100:1,failures_pct:1};
// a goal that has a tile above gets the tile's status, so the two never disagree
const TK={weekly_checks:"ns",installs_week:"installs",google_clicks_week:"clicks",pages_indexed:"pages",share_per_100:"share",failures_pct:"health"};
$("goal").innerHTML='<div style="overflow-x:auto"><table class="t tg"><thead><tr><th>מדד</th><th class="n">עכשיו</th><th class="n">היעד להיום</th>'+nx.map((m,i)=>'<th class="n">סוף '+mname(m,i===nx.length-1)+"</th>").join("")+"</tr></thead><tbody>"
+R.map(([k,l,v,day,,lower])=>{const rk=RCAL[k],g=rk===null?null:goal(k,day||td,rk),tk=TK[k],st=tk&&M[tk]?M[tk]:cal?"cal":band(v,g,lower,!lower),gf=RATE[k]?n1:x=>x>0&&x<1?"פחות מ-1":n(x);return '<tr><td class="w">'+l+'</td><td class="n">'+gf(v)+(st==="cal"?"":" "+mark(st))+'</td><td class="n">'+gf(g&&g[1])+'</td>'+nx.map(m=>'<td class="n">'+gf(rk===null?null:goal(k,mEnd(m),rk)[1])+"</td>").join("")+"</tr>"}).join("")+"</tbody></table></div>"
+'<p class="note">היעדים מתוכנית השיווק, בתרחיש הבסיס (בלי פרסום בתשלום). ✓ ירוק: ביעד או מעליו. ! צהוב: קצת מתחת ליעד, אבל מעל התרחיש הזהיר. ✕ אדום: מתחת לתרחיש הזהיר. בין סוף חודש לסוף החודש הבא היעד עולה בהדרגה. בבדיקות שנכשלו, נמוך יותר טוב. '+(cw!=null?"היעדים לבדיקות רכב ולהתקנות נקבעו לפי שבוע הבסיס ("+rng([addD(CB.end,-6),CB.end])+"): היו בו "+n(cw)+" בדיקות מול "+n(goal("weekly_checks",CB.end)[1])+" שהתוכנית הניחה"+(ci!=null?", ו-"+n(ci)+" התקנות מול "+n(goal("installs_week",CB.end)[1]):"")+". כל יעד שלהם הוא יעד התוכנית כפול היחס הזה, כך שקצב הגדילה של התוכנית נשמר"+(RC>=CB.hi||RI>=CB.hi?" (היחס מוגבל עד פי "+CB.hi+")":"")+".":"עד שייגמר שבוע הבסיס ("+rng([addD(CB.end,-6),CB.end])+") רוב השורות בלי צבע, והיעדים לבדיקות רכב ולהתקנות ייקבעו לפיו.")+'</p>'}

// drawer: sources. First, per channel, where people came from in the last 7 days: visits to the site by the source the page sends (src,
// from 20.10), and new app devices in Israel by the link they reached the store from (Google Play's install referrer). Then the plan's
// North Star (car checks a week) split by the source of the visit the check was made in
{const B=W&&W.bySource,box=$("src"),CH=d.daily&&d.daily.ch;
const SL={google:"חיפוש בגוגל",search:"מנועי חיפוש אחרים",direct:"בלי מקור מזוהה (הקלדה, או קישור בלי סימון)",site:"מדף אחר באתר (דגמים, מגזין)",unknown:"לפני 20.10, כשהמקור עוד לא נמדד",app:"באפליקציה (בלי פירוט מקור)",share:"קישור לדוח רכב או להשוואה ששותפו",tiktok:"טיקטוק",instagram:"אינסטגרם",facebook:"פייסבוק",linkedin:"לינקדאין",youtube:"יוטיוב",whatsapp:"וואטסאפ",newsletter:"ניוזלטר",press:"כתבות",dealer:"סוחרים",qr:"QR ודפוס",other:"אתרים ואפליקציות אחרים",store:"חיפוש ב-Google Play",fromsite:"דרך האתר (כפתור ההורדה)",nolink:"בלי מקור מזוהה (הקלדה, או קישור בלי סימון)"};
let h='<p class="note">אין כרגע נתון מגוגל אנליטיקס על הרשתות.</p>';
if(CH){const NET=["facebook","instagram","whatsapp","tiktok","youtube"],low=k=>String(k||"").toLowerCase(),own=s=>SL[s]&&s!=="unknown"&&s!=="app";
 // the site sends the plan's names; the app's install referrer is google-play (found in the store), luchit.app (the site's download
 // button after a visit without a campaign), a campaign name, or nothing
 const sb=k=>{const s=low(k);return !s||s==="(not set)"||s==="direct"?"nolink":own(s)?s:"other"};
 const ab=k=>{const s=low(k);return s==="google-play"?"store":s==="luchit.app"||s==="luchitapp"?"fromsite":!s||s==="(direct)"||s==="(not set)"?"nolink":own(s)?s:"other"};
 const fold=(o,f)=>{const m={};for(const [k,v] of Object.entries(o||{})){const b=f(k);m[b]=(m[b]||0)+v}return m};
 const s7=CH.site?fold(CH.site[0],sb):null,s1=CH.site?fold(CH.site[1],sb):null,a7=CH.app?fold(CH.app[0],ab):null,a1=CH.app?fold(CH.app[1],ab):null,tot=k=>(s7&&s7[k]||0)+(a7&&a7[k]||0),pos=k=>NET.includes(k)?NET.indexOf(k):9;
 const ks=[...new Set([...NET,...Object.keys(s7||{}),...Object.keys(a7||{})])].filter(k=>NET.includes(k)||tot(k)).sort((a,b)=>pos(a)-pos(b)||tot(b)-tot(a));
 const cell=(m,m1,k)=>!m?"-":n(m[k]||0)+(m1&&m1[k]?' <small class="flat">(היום '+n(m1[k])+")</small>":"");
 h="<h4>מאיפה הגיעו אנשים, 7 הימים האחרונים (כולל היום)</h4>"+'<div style="overflow-x:auto"><table class="t tg"><thead><tr><th>מקור</th><th class="n">נכנסו לאתר</th><th class="n">התקינו את האפליקציה</th></tr></thead><tbody>'
 +ks.map(k=>'<tr><td class="w">'+esc(SL[k]||k)+'</td><td class="n">'+(k==="store"||k==="fromsite"?"":cell(s7,s1,k))+'</td><td class="n">'+cell(a7,a1,k)+"</td></tr>").join("")+"</tbody></table></div>"
 +(CH.site&&!Object.keys(CH.site[0]).length?'<p class="note">עוד אין כאן כניסות לאתר לפי רשת: האתר מוסר את המקור מ-20.10, וגוגל אנליטיקס מעבד כל יום באיחור של כמה שעות. בינתיים יש כניסות לפי אתר מפנה, לפי Cloudflare, במגירה "האתר".</p>':"")
 +'<p class="note">וואטסאפ: לרוב לא מוסר מאיפה הגיעו (באייפון אף פעם), ולכן קישור רגיל בהודעה נספר בדרך כלל בשורה "בלי מקור מזוהה". כדי לספור אותו בוודאות, משתפים את הקישור <bdi dir="ltr">luchit.app/go/wa</bdi>. דוח רכב ששותף בוואטסאפ נספר בשורת הקישורים ששותפו.</p>'
 +'<p class="note">נכנסו לאתר: כל כניסה נספרת פעם אחת. התקינו: פתיחה ראשונה של האפליקציה בישראל, לפי הקישור שהביא לחנות. התקנה מכפתור ההורדה באתר נספרת לפי קישור go/ או השיתוף שהביאו לאתר, ובלעדיהם כ"דרך האתר". היום מתעדכן באיחור של כמה שעות. כאן 7 הימים כוללים את היום, ולכן הסכומים שונים מהמשבצות למעלה, שסופרות שבוע שלם עד אתמול.</p>'}
// every tagged link with a topic (luchit.app/go/fb?c=market, a bio link, a newsletter issue): site visits and car checks in the week, and the
// app installs it brought (the topic rides the store link as utm_campaign). Topics are counted from 23.10 (the page sends them from then)
// from 4.11.2026 each Facebook group has its own topic (fbg_ and letters): the table keeps one "קבוצות פייסבוק" row (fb_groups), so the series
// goes on, and lists the groups under it
{const fam=k=>{const i=k.indexOf("|");return /^fbg_[a-z]{1,20}$/.test(k.slice(i+1))?k.slice(0,i)+"|fb_groups":k},mg=(o,f)=>{const r={};for(const[k,v]of Object.entries(o||{})){const m=fam(k);r[m]=f(r[m],v)}return r},sum2=(a,v)=>[(a||[0,0])[0]+v[0],(a||[0,0])[1]+v[1]],sum1=(a,v)=>(a||0)+v;
const BC=W&&W.byCamp,AC0=W&&W.appSrc&&W.appSrc[0]&&W.appSrc[0].camp,AO0=W&&W.appOpen&&W.appOpen[0]||{},cv0=BC?BC[0]:{},AC=AC0&&mg(AC0,sum1),AO=mg(AO0,sum1),op=Object.keys(AO).length>0,cv=mg(cv0,sum2),
GK=[...new Set([...Object.keys(cv0),...Object.keys(AC0||{}),...Object.keys(AO0)])].filter(k=>fam(k)!==k).sort((a,b)=>(cv0[b]||[0,0])[1]-(cv0[a]||[0,0])[1]||(AC0&&AC0[b]||0)-(AC0&&AC0[a]||0)||(a<b?-1:1)),ks=[...new Set([...Object.keys(cv),...Object.keys(AC||{}),...Object.keys(AO)])],ins=k=>AC&&AC[k]||0,ck=k=>(cv[k]||[0,0])[1];
const TOP={bio:"קישור בביו",post:"פוסט",message:"הודעה",magazine:"גיליון המגזין",article:"כתבה",qr:"קוד QR",dealer:"סוחר",market:"פוסט על השוק",offroad:"פוסט על רכבים שירדו מהכביש",one_line:"פוסט בשורה אחת",fb_group:"קבוצת פייסבוק",fb_groups:"קבוצות פייסבוק",friend_post:"פוסט של חבר",personal_post:"פוסט אישי"};
const tl=t=>TOP[t]||(/^fb_group_/.test(t)?"קבוצה: "+'<bdi dir="ltr">'+esc(t.slice(9))+"</bdi>":'<bdi dir="ltr">'+esc(t)+"</bdi>"),nm2=k=>{const i=k.indexOf("|");return esc(SL[k.slice(0,i)]||k.slice(0,i))+" · "+tl(k.slice(i+1))};
ks.sort((a,b)=>ck(b)-ck(a)||ins(b)-ins(a)||(cv[b]||[0,0])[0]-(cv[a]||[0,0])[0]||(AO[b]||0)-(AO[a]||0));
h+="<h4>לפי קישור ונושא ("+rng(W&&W.W)+")</h4>"+(!BC&&!AC?'<p class="note" style="margin:0">אין כרגע נתון מגוגל אנליטיקס.</p>':ks.length?'<div style="overflow-x:auto"><table class="t tg"><thead><tr><th>קישור</th><th class="n">נכנסו לאתר</th><th class="n">בדיקות רכב</th><th class="n">התקינו</th>'+(op?'<th class="n">נפתחו באפליקציה</th>':"")+"</tr></thead><tbody>"
+ks.map(k=>'<tr><td class="w">'+nm2(k)+'</td><td class="n">'+n((cv[k]||[0,0])[0])+'</td><td class="n">'+n(ck(k))+'</td><td class="n">'+n(ins(k))+"</td>"+(op?'<td class="n">'+n(AO[k]||0)+"</td>":"")+"</tr>").join("")+"</tbody></table></div>"
+(GK.length?'<details style="margin-top:6px"><summary>«קבוצות פייסבוק» לפי קבוצה ('+n(GK.length)+')</summary><div style="overflow-x:auto"><table class="t tg"><thead><tr><th>תגית הקבוצה</th><th class="n">נכנסו לאתר</th><th class="n">בדיקות רכב</th><th class="n">התקינו</th>'+(op?'<th class="n">נפתחו באפליקציה</th>':"")+"</tr></thead><tbody>"
+GK.map(k=>'<tr><td class="w">'+esc(SL[k.slice(0,k.indexOf("|"))]||k.slice(0,k.indexOf("|")))+' · <bdi dir="ltr">'+esc(k.slice(k.indexOf("|")+1))+'</bdi></td><td class="n">'+n((cv0[k]||[0,0])[0])+'</td><td class="n">'+n((cv0[k]||[0,0])[1])+'</td><td class="n">'+n(AC0&&AC0[k]||0)+"</td>"+(op?'<td class="n">'+n(AO0[k]||0)+"</td>":"")+"</tr>").join("")+'</tbody></table></div><p class="note" style="margin:0">התגית מזהה את הקבוצה בקובץ תוכנית הפרסום. השורה «קבוצות פייסבוק» למעלה היא הסכום של כולן.</p></details>':"")
:'<p class="note" style="margin:0">עוד אין השבוע כניסות מקישור עם נושא.</p>')
+'<p class="note">כל קישור <bdi dir="ltr">luchit.app/go/</bdi> נספר כאן לפי הרשת והנושא שלו, למשל <bdi dir="ltr">go/fb?c=market</bdi> מופיע כ"פייסבוק · פוסט על השוק". קישור בלי נושא נספר לפי ברירת המחדל של הרשת (בביו, פוסט, הודעה). הנושא נמדד מ-23.10. התקינו: פתיחה ראשונה של האפליקציה אחרי הורדה דרך הקישור.'+(op?" נפתחו באפליקציה: מי שכבר מותקנת אצלו האפליקציה, והקישור פתח אותה במקום את האתר (מגרסה 1.38).":"")+'</p>'}
// clicks from the site to our own pages on the networks (the footer links), this week and the week before
{const SO=W&&W.social;if(SO){const ks=[...new Set(["facebook","instagram","tiktok",...Object.keys(SO[0]),...Object.keys(SO[1])])];
h+="<h4>מהאתר לעמודים שלנו ברשתות ("+rng(W.W)+")</h4>"+'<div style="overflow-x:auto"><table class="t tg"><thead><tr><th>עמוד</th><th class="n">לחיצות השבוע</th><th class="n">שבוע קודם</th></tr></thead><tbody>'+ks.map(k=>'<tr><td class="w">'+esc(SL[k]||k)+'</td><td class="n">'+n(SO[0][k]||0)+'</td><td class="n">'+n(SO[1][k]||0)+"</td></tr>").join("")+"</tbody></table></div>"
+'<p class="note">לחיצות על הקישורים לעמודי פייסבוק, אינסטגרם וטיקטוק שבתחתית האתר. נספרות מהיום שהקישורים עלו לאתר.</p>'}}
if(!B){box.innerHTML=h+'<p class="note">'+(W?"גוגל אנליטיקס לא ענה על המקורות.":"אין נתונים")+"</p>"}else{
const c=B[0],p=B[1],seen=W.srcSeen||[true,true],ks=[...new Set([...Object.keys(c),...Object.keys(p)])].filter(k=>(c[k]||[0,0])[1]||(p[k]||[0,0])[1]).sort((a,b)=>(a==="app"?-1:b==="app"?1:0)||((c[b]||[0,0])[1]-(c[a]||[0,0])[1])),tc=ks.reduce((a,k)=>a+(c[k]||[0,0])[1],0);
// the previous week compares only what both weeks counted: the site from 15.10 (SITE_FROM), and its rows by source from 20.10
const pSite=W.W&&addD(W.W[0],-7)>=SITE_FROM,pv=k=>k==="app"?(p[k]||[0,0])[1]:!pSite||(k!=="unknown"&&!seen[1])?null:(p[k]||[0,0])[1],tp=pSite?ks.reduce((a,k)=>a+(p[k]||[0,0])[1],0):null;
const nm=k=>k==="app"?"באפליקציה":"באתר: "+(SL[k]||k);
box.innerHTML=h+"<h4>בדיקות רכב לפי מקור ("+rng(W.W)+")</h4>"+'<p class="note" style="margin:0 0 6px">אלה '+n(tc)+' בדיקות הרכב של המשבצת "בדיקות רכב בשבוע", לפי המקור של הכניסה שבה נעשתה כל בדיקה: האפליקציה, או באתר הרשת או הקישור שהביאו את הנכנס.</p>'+(ks.length?'<div style="overflow-x:auto"><table class="t tg"><thead><tr><th>מקור</th><th class="n">בדיקות רכב</th><th class="n">חלק מהבדיקות</th><th class="n">שבוע קודם</th></tr></thead><tbody>'
+ks.map(k=>{const a=c[k]||[0,0];return '<tr><td class="w">'+esc(nm(k))+'</td><td class="n">'+n(a[1])+'</td><td class="n">'+(tc?Math.round(a[1]*100/tc)+"%":"-")+'</td><td class="n">'+n(pv(k))+"</td></tr>"}).join("")
+'<tr><td class="w"><b>סך הכול</b></td><td class="n"><b>'+n(tc)+'</b></td><td class="n"></td><td class="n">'+n(tp)+"</td></tr></tbody></table></div>":'<p class="note" style="margin:0">אין עדיין נתונים לשבוע הזה.</p>')
+'<p class="note">באפליקציה אין מקור לכל פתיחה, ולכן היא שורה אחת. האתר נספר מ-15.10 ומוסר מקור מ-20.10: הבדיקות באתר שלפני 20.10 בשורה אחת, ובשבוע קודם שלא נספר בו האתר מופיע מקף, כי אין מה להשוות. השבוע נגמר אתמול, כי גוגל אנליטיקס מסיים לספור אחרי כיום.</p>'}}

// drawer: the month's three questions (report "רנטגן משפך AARRR", 21.10). Until 22.11 no new features; these readings decide what comes next.
// Each question: a status, what it reads now, and the numbers behind it. The thresholds are the report's; where it set none, the note says mine.
{const box=$("q"),QF="2026-10-21",QE="2026-11-22",td=new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Jerusalem"}),left=between(td,QE);
const row=(l,v,sub)=>"<li><span>"+l+(sub?"<small>"+sub+"</small>":"")+"</span><b>"+v+"</b></li>",pc=x=>x==null||!isFinite(x)?"-":n1(x)+"%";
const head=(i,t,s,w,read)=>"<h4>"+i+". "+t+"</h4>"+'<p class="note" style="margin:0 0 6px">'+chip(s,w)+" "+read+"</p>";
let h='<p class="note" style="margin:0 0 6px">'+(left>0?"עד 22.11 לא מוסיפים פיצ'רים, והתשובות לשלוש השאלות קובעות מה בונים אחר כך. נשארו "+n(left)+" ימים.":"הגיע מועד ההחלטה (22.11): התשובות כאן הן הבסיס לה.")+"</p>";
// 1. organic: site checks from sources that are not our campaign links (Google, other search engines, direct, other pages of the site, shared reports, other sites)
{const ORG=["google","search","direct","site","share","other"],B=W&&W.bySource,seen=W&&W.srcSeen||[false,false],AS=W&&W.appSrc;
const sc=(o,ks)=>ks.reduce((a,k)=>a+((o&&o[k]||[0,0])[1]),0),known=o=>Object.keys(o||{}).filter(k=>k!=="app"&&k!=="unknown");
const o0=B?sc(B[0],ORG):null,m0=B?sc(B[0],known(B[0])):null,o1=B&&seen[1]?sc(B[1],ORG):null,sh=m0?o0/m0*100:null,gr=o1?(o0-o1)/o1*100:null;
let s,w,r;
if(!B){s="nodata";r="גוגל אנליטיקס לא ענה על המקורות."}
else if(!seen[0]||m0<30){s="early";r="מעט נתונים עדיין: "+n(m0)+" בדיקות באתר שהמקור שלהן ידוע (המקור נמדד מ-20.10). צריך לפחות 30 בשבוע."}
else if(sh<25){s="warn";w="מתחת ל-25%";r="אם זה יישאר כך עד 22.11, החודש הבא מוקדש להפצה: שותפויות, קהילות, סוחרים. לא לפיצ'רים."}
else if(gr!=null&&gr>=20){s="ok";w="יש משיכה";r="מעל 25% ועולה ב-20% בשבוע או יותר: אפשר להתחיל להשקיע בלולאות (שיתוף, הפניות)."}
else{s="warn";w="עוד לא צומח";r="מעל 25%, אבל עוד לא עולה ב-20% בשבוע. אם זה לא יעלה עד 22.11, החודש הבא מוקדש להפצה."}
h+=head(1,"האם לוחית צומחת בלי דחיפה?",s,w,r)+(!B?"":'<ul class="kv">'
+row("בדיקות באתר ממקורות שאינם קישורי קמפיין",n(o0)+(o1!=null?' <small class="flat">(שבוע קודם '+n(o1)+")</small>":""),"גוגל, מנועי חיפוש, ישיר, דפים אחרים באתר, דוחות ששותפו ואתרים אחרים · "+rng(W&&W.W))
+row("החלק שלהן מהבדיקות באתר",pc(sh),"מתוך "+n(m0)+" בדיקות שהמקור שלהן ידוע · הסף 25%")
+(gr!=null?row("שינוי מהשבוע הקודם",'<bdi dir="ltr">'+(gr>0?"+":"")+n(gr)+"%</bdi>","הסף לצמיחה: 20% בשבוע"):"")
+(AS?row("התקנות שמצאו את האפליקציה בחנות",n(AS[0].store)+' <small class="flat">(שבוע קודם '+n(AS[1].store)+")</small>","מתוך "+n(AS[0].all)+" התקנות חדשות בישראל השבוע (Google Play, חיפוש ודפדוף בחנות)"):"")
+'</ul><p class="note">בדיקות באפליקציה לא נכללות, כי לפתיחה של האפליקציה אין מקור. "ישיר" כולל גם קישור שנשלח בוואטסאפ בלי סימון, ולכן המספר אופטימי במעט.</p>')}
// 2. does a saved car bring people back? new installs from 1.36 that saved a car on the install day vs those that did not, back on days 1 to 7
{const C=W&&W.coh,mat=end?addD(end,-7):null;let I=0,Sv=0,N1=0,N0=0,R1=0,R0=0,Est=0;
for(const [day,o] of Object.entries(C||{})){if(day<QF)continue;const sv=o[1];I+=o[0];Sv+=o[1];Est+=o[4]||0;if(day<=mat){N1+=sv;N0+=Math.max(0,o[0]-sv);R1+=o[2];R0+=o[3]}}
const r1=N1?R1/N1*100:null,r0=N0?R0/N0*100:null,x=r1==null||r0==null?null:r0>0?r1/r0:r1>0?Infinity:null;
let s,w,r;
if(!W||!end||end<QF){s="wait";w="ממתין לנתונים";r="הנתונים מתחילים עם 1.36: כל יום התקנות נכנס לחשבון שבוע אחרי שהותקן."}
else if(!C){s="nodata";r="גוגל אנליטיקס לא ענה."}
else if(N1<40||R1<5||N0<20){s="early";r="מעט נתונים עדיין: נספרים רק מי שהתקין מ-1.36 ועבר עליו שבוע שלם. ההחלטה נחשבת רק מ-40 ששמרו, ש-5 מהם חזרו (ו-20 לפחות שלא שמרו). אם לא יגיעו לזה עד 22.11, ההחלטה עוברת ל-6.12."}
else if(x>=3){s="ok";w="השמירה מחזירה";r="מי ששמר רכב חוזר פי 3 או יותר: השמירה היא המנוף, וכדאי לחזק את רגע השמירה אחרי בדיקה."}
else{s="warn";w="פחות מפי 3";r="השמירה לא מחזירה מספיק: אם זה יישאר כך, מפסיקים לדחוף התקנות, ולוחית היא כלי אתר לשימוש חד-פעמי, עם הכנסה מחבילת קנייה ומעסקים."}
h+=head(2,"האם רכב שמור מחזיר אנשים?",s,w,r)+(s==="wait"||!C?"":'<ul class="kv">'
+row("התקנות חדשות מ-1.36",n(I),"מ-"+dm(QF)+" עד "+(end?dm(end):"-")+", בישראל")
+row("שמרו רכב ביום ההתקנה",n(Sv)+(I?' <small class="flat">('+pc(Sv/I*100)+")</small>":""),"אחוז השומרים מתוך המתקינים")
+row("חזרו בתוך 7 ימים, מי ששמר",N1?n(R1)+" מתוך "+n(N1)+' <small class="flat">('+pc(r1)+")</small>":"-","התקנות שעבר עליהן שבוע שלם"+(mat&&mat>=QF?" (עד "+dm(mat)+")":""))
+row("חזרו בתוך 7 ימים, מי שלא שמר",N0?n(R0)+" מתוך "+n(N0)+' <small class="flat">('+pc(r0)+")</small>":"-","")
+row("פי כמה חוזרים מי ששמרו",x==null?"-":x===Infinity?"רק הם חזרו":"פי "+n1(x),"הסף: פי 3")
+row("גודל המדגם",n(N1)+" ששמרו · "+n(R1)+" מהם חזרו","המינימום להחלטה: 40 ששמרו ו-5 שחזרו. בלי זה ההחלטה עוברת מ-22.11 ל-6.12 (הוחלט 24.10)")+"</ul>"
+(Est?'<p class="note">הערכה: האפליקציה לא שולחת כרגע את יום ההתקנה, ולכן '+n(Est)+" שמירות וחזרות שויכו לפי התאריך שלהן (חזרה נספרת ליום שלפניה). המספרים יהיו מדויקים כשהאפליקציה תשלח אותו שוב.</p>":""))}
// 3. where sharing breaks: the share sheet opened per report shown, shares per opening, arrivals from a shared link per share
{const Lw=ge(E0,"car_lookup"),Ow=ge(E0,"share_open"),Sw=ge(E0,"share"),sh=W&&W.shared,Aw=sh?sh[0].web+sh[0].app:null,part=W&&W.W&&W.W[0]<QF;
const o=Lw?Ow/Lw*100:null,c=Ow?Sw/Ow*100:null,a=Sw&&Aw!=null?Aw/Sw:null;
let s,w,r;
if(!ev){s="nodata";r="גוגל אנליטיקס לא ענה."}
else if(part){s="early";r="פתיחת חלון השיתוף נמדדת מ-"+dm(QF)+". השבוע המלא הראשון ("+dm(QF)+" עד "+dm(addD(QF,6))+") יוצג כאן מ-"+dm(addD(QF,7))+"."}
else if(Lw<200){s="early";r="מעט בדיקות השבוע כדי לשפוט ("+n(Lw)+", צריך 200)."}
else if(o<2){s="warn";w="מעטים פותחים";r="פחות מ-2% פותחים את חלון השיתוף: בעיית מוטיבציה. הכיוון: הצד של המוכר, מוכר ששולח דוח לקונה."}
else if(Ow<20){s="early";r="מעט פתיחות של החלון כדי לשפוט את ההמשך ("+n(Ow)+", צריך 20)."}
else if(c<30){s="warn";w="מעטים משלימים";r="רבים פותחים את החלון ומעטים משתפים בפועל: תיקון קטן בחלון השיתוף."}
else if(Sw<10){s="early";r="מעט שיתופים כדי לשפוט אם הם מביאים אנשים ("+n(Sw)+", צריך 10)."}
else if(a<.1){s="warn";w="שיתופים בלי כניסות";r="משתפים, אבל כמעט אף אחד לא מגיע מהקישור: הקישור בטקסט יהיה ברירת המחדל במקום תמונה או PDF."}
else{s="ok";w="השיתוף עובד";r="אין שבר בולט בשלבי השיתוף."}
h+=head(3,"איפה נשבר השיתוף?",s,w,r)+'<ul class="kv">'
+row("דוחות שהוצגו (בדיקות רכב)",n(Lw),rng(W&&W.W)+" · אפליקציה ואתר")
+row("פתחו את חלון השיתוף",n(Ow)+' <small class="flat">('+pc(o)+")</small>","מתוך הדוחות · הסף 2%")
+row("שיתפו בפועל",n(Sw)+' <small class="flat">('+pc(c)+")</small>","מתוך הפתיחות")
+row("נכנסו מקישור ששותף",n(Aw)+(a!=null?' <small class="flat">('+n1(a*10)+" לכל 10 שיתופים)</small>":""),"")
+'</ul><p class="note">פתיחת החלון נמדדת באתר מ-21.10, ובאפליקציה אצל מי שעדכן ל-1.36. ספים שהדוח לא קבע ובחרתי: "מעטים משלימים" הוא פחות מ-30% מהפתיחות, ו"אף אחד לא מגיע" הוא פחות מכניסה אחת לכל 10 שיתופים.</p>'}
box.innerHTML=h}

// drawer: usage, this week against last week, and how many devices the app is on, from both sources
{const box=$("use");if(!ev){box.innerHTML='<p class="note">אין נתון מגוגל אנליטיקס.</p>'}else{
// every action GA4 counted in the two weeks, not only the named ones: the 14 biggest of ours in view, the rest and Google's automatic ones under "עוד"; a name the dashboard does not know
// yet (an event added in a new version) is shown as sent and marked, so nothing the app or site sends is hidden (Dudu, 25.10: full monitoring)
const all=[...new Set([...Object.keys(E0||{}),...Object.keys(E1||{})])].filter(k=>k&&k!=="(not set)"&&(ge(E0,k)||ge(E1,k))).sort((a,b)=>(AUTO[a]?1:0)-(AUTO[b]?1:0)||ge(E0,b)-ge(E0,a)||ge(E1,b)-ge(E1,a)),rows=all.filter(k=>!AUTO[k]).slice(0,14),more=all.filter(k=>!rows.includes(k)),unk=all.filter(k=>!N[k]&&!AUTO[k]);
const E28=W.e28,wk=(o,p)=>o[p].slice(21).reduce((x,y)=>x+y,0),split=k=>{const o=E28&&E28[k];if(!o)return "";const a=wk(o,"a"),w=wk(o,"w");return a&&w?'<small class="flat" style="display:block">באפליקציה '+n(a)+", באתר "+n(w)+"</small>":!a&&w?'<small class="flat" style="display:block">באתר</small>':""};
const lab=k=>N[k]||(AUTO[k]?'<span class="flat">'+AUTO[k]+"</span>":esc(k)+' <small class="flat">(חדש, עוד בלי שם)</small>'),trs=a=>a.map(k=>'<tr'+(E28&&E28[k]?' data-ev="'+esc(k)+'" title="לחיצה: יום אחרי יום"':"")+'><td class="w">'+lab(k)+split(k)+'</td><td class="n">'+n(ge(E0,k))+'</td><td class="n">'+n(ge(E1,k))+"</td></tr>").join("");
// saving is an app feature, so the share is of app devices; without that answer there is no fair stand-in (site "users" are page loads)
const SV=W.savers,Lu=SV?SV.car_lookup||0:null,Su=SV?SV.car_save||0:null;
const kvr=r=>"<li><span>"+r[0]+(r[2]!=null?" (שבוע קודם "+n(r[2])+")":"")+"</span><b>"+n(r[1])+"</b></li>";
box.innerHTML='<h4>שמירת רכב</h4><p class="note" style="margin:0 0 6px">'+(!SV?"אין נתון מגוגל אנליטיקס על מכשירים ששמרו רכב.":Lu>=50?n1(Su/Lu*100)+"% מהמכשירים באפליקציה שבדקו רכב שמרו אותו ברשימה (היעד 15%).":"מעט מדי מכשירים באפליקציה בדקו רכב השבוע כדי לחשב אחוז: "+n(Su)+" שמרו מתוך "+n(Lu)+".")+"</p>"
+'<h4>פעולות ('+rng(W.W)+") · "+n(all.length)+" סוגים</h4>"+'<table class="t"><thead><tr><th>פעולה</th><th class="n">השבוע</th><th class="n">שבוע קודם</th></tr></thead><tbody>'+trs(rows)+"</tbody></table>"
+(more.length?'<details class="evmore"><summary>עוד '+n(more.length)+" פעולות</summary>"+'<table class="t"><tbody>'+trs(more)+"</tbody></table></details>":"")
+(E28?'<p class="note" style="margin:4px 0 0">לחיצה על פעולה מציגה אותה יום אחרי יום ב-28 הימים האחרונים, באפליקציה ובאתר.</p>':"")
+(unk.length?'<p class="note" style="margin:4px 0 0">'+n(unk.length)+" פעולות עוד בלי שם בדשבורד, כנראה מגרסה חדשה. הן נספרות, והשם יתווסף.</p>":"")
+(W.door&&(W.door.shown||W.door.overview||W.door.menu||W.door.home)?(()=>{const D=W.door,g=(k,i)=>D[k]?D[k][i]:0,sh=g("shown",0),ov=g("overview",0);
return '<h4>תיק הרכב: הדלת בסקירה (מ-1.38)</h4><ul class="kv">'+kvr(["הצגת השורה «פתיחת תיק»",sh,g("shown",1)])+kvr(["תיקים שנפתחו מהשורה",ov,g("overview",1)])+kvr(["תיקים שנפתחו מהתפריט",g("menu",0),g("menu",1)])+kvr(["תיקים שנפתחו ממסך הבית",g("home",0),g("home",1)])+(g("other",0)||g("other",1)?kvr(["תיקים שנפתחו בלי מקור (גרסה ישנה)",g("other",0),g("other",1)]):"")+"</ul>"
+'<p class="note" style="margin:0 0 6px">'+(sh>=20?"מתוך מי שראה את השורה, "+n1(ov/sh*100)+"% פתחו תיק. כך אפשר להבדיל בין «לא ראו» לבין «לא רצו».":"עדיין מעט הצגות של השורה כדי לחשב אחוז.")+"</p>"})():"")
+(inst!=null?'<h4>כמה מכשירים יש לאפליקציה עכשיו (הערכה)</h4><ul class="kv">'+kvr(["מותקנת בישראל, "+(instMin?"לפחות":"בערך"),inst,null])+'</ul><p class="note" style="margin:0 0 6px">'+instHow+". כולל הטלפונים שלך ושל הבודקים.</p>":"")
+(PS?'<h4>לפי Google Play: המספרים המדויקים, עד '+dm(PS.last)+"</h4>"+'<ul class="kv">'+[PS.active!=null?["מכשירים בישראל שהאפליקציה מותקנת בהם, ב-"+dm(PS.activeDay),PS.active,null]:null,["התקנות חדשות בישראל, "+rng(PS.W),PS.cur.users,PS.prev.users],["הסרות, "+rng(PS.W),PS.cur.uninstalls,PS.prev.uninstalls],PS.store&&(PS.cur.visitors||PS.prev.visitors)?["ביקרו בדף האפליקציה בחנות",PS.cur.visitors,PS.prev.visitors]:null,PS.store&&(PS.cur.acquisitions||PS.prev.acquisitions)?["התקינו מתוך דף החנות",PS.cur.acquisitions,PS.prev.acquisitions]:null].filter(Boolean).map(kvr).join("")+'</ul><p class="note" style="margin:0 0 6px">Google Play סופר כל מי שהתקין, גם אם עוד לא פתח. הוא מוסר את המספרים באיחור של כמה ימים, ולכן התאריכים כאן מוקדמים משאר המסך.</p>':"")
+(W.app?'<h4>לפי גוגל אנליטיקס</h4><ul class="kv">'+[["התקנות חדשות בישראל, "+rng(W.W),W.app[0].newUsers,W.app[1].newUsers],["משתמשים באפליקציה בישראל, 28 ימים",W.app[2].activeUsers,null],['משתמשים בחו"ל, לא נספרים',W.app[2].abroadActive,null]].map(kvr).join("")+'</ul><p class="note" style="margin:0 0 6px">גוגל אנליטיקס רואה התקנה כשפותחים את האפליקציה בפעם הראשונה (האירוע first_open), ולכן מי שהתקין ועוד לא פתח לא נספר. עדכון גרסה לא נספר כהתקנה, אבל התקנה מחדש או מחיקת נתוני האפליקציה נספרות כהתקנה חדשה. מכשירים בחו"ל לא נספרים במסך: רובם מכשירי הבדיקה של גוגל, שמתקינה עליהם כל גרסה חדשה.</p>':"")
+(W.shared?'<h4>קישורים ששותפו והביאו אנשים, לפי סוג</h4><p class="note" style="margin:0">'+(Object.entries(W.shared[0].by).map(e=>(VIA[e[0]]||esc(e[0]))+": "+n(e[1])).join(" · ")||"עדיין אין כניסות מקישור ששותף.")+"</p>"
+(W.shared[0].bar?'<p class="note" style="margin:4px 0 0">ועוד '+n(W.shared[0].bar)+' פתיחות מהבר "פתחו באפליקציה" או מ"העתקת הקישור" בדף שכבר היה פתוח. זה אותו ביקור, ולכן הן לא נספרות כהגעה מקישור.</p>':""):"")}}

// drawer: the site
{const SRC=h=>!h?"בלי אתר מפנה (הקלדה, וואטסאפ, הודעות)":/google\\./.test(h)?"גוגל":/bing\\.|duckduckgo|yahoo|ecosia|yandex/.test(h)?"מנועי חיפוש אחרים":/whatsapp|^wa\\.me$/.test(h)?"וואטסאפ":/facebook|^fb\\.|^l\\.fb\\./.test(h)?"פייסבוק":/instagram/.test(h)?"אינסטגרם":/tiktok/.test(h)?"טיקטוק":/youtube|^youtu\\.be$/.test(h)?"יוטיוב":/^t\\.co$|twitter|^x\\.com$/.test(h)?"X (טוויטר)":/linkedin|^lnkd\\.in$/.test(h)?"לינקדאין":/telegram|^t\\.me$/.test(h)?"טלגרם":/luchit\\.app/.test(h)?"מתוך האתר":h;
const agg=(arr,f)=>{const m={};(arr||[]).forEach(r=>{const k=f(r[0]);m[k]=(m[k]||0)+r[1]});return Object.entries(m).sort((a,b)=>b[1]-a[1])};
const S7=W&&W.sources,tot=S7?S7.reduce((a,r)=>a+r[1],0):null,kv=a=>a&&a.length?'<ul class="kv">'+a.map(r=>"<li><span>"+r[0]+"</span><b>"+n(r[1])+"</b></li>").join("")+"</ul>":'<p class="note" style="margin:0">אין נתונים</p>';
$("web").innerHTML='<h4>ביקורים ב-7 ימים ('+rng(W&&W.CW)+"): "+n(tot)+"</h4>"+kv(S7?agg(S7,SRC).filter(r=>r[1]>0).map(r=>[esc(r[0]),r[1]]):null)
+"<h4>הדפים שהכי נצפו</h4>"+kv(W&&W.pages?W.pages.slice(0,8).map(r=>[PG(r[0]),r[2]]):null)
+'<p class="note">לפי Cloudflare, בכל דפי האתר. ביקור הוא כניסה לאתר מבחוץ, ומעבר בין דפים באותו ביקור לא נספר שוב; בדפים נספרת כל צפייה. Cloudflare סופר במדגם, ולכן המספרים מעוגלים לעשרות. וואטסאפ בדרך כלל לא מוסר מאיפה הגיעו, ולכן רוב הכניסות ממנו נספרות כ"בלי אתר מפנה". הפירוט לפי רשת, לאתר ולאפליקציה, נמצא במגירה "מקורות".</p>'}

// drawer: Google search
{const S=d.seo,box=$("seo");if(!S||!S.cur){box.innerHTML='<p class="note">'+(S?"אין עדיין נתוני חיפוש.":"Search Console לא ענה.")+"</p>"}else{
const qs=S.queries||[],ps=x=>n(x),X=d.metrics&&d.metrics.index;
const TB=(heads,rows)=>rows.length?'<table class="t"><thead><tr>'+heads.map((h,i)=>"<th"+(i?' class="n"':"")+">"+h+"</th>").join("")+"</tr></thead><tbody>"+rows.map(r=>'<tr><td class="w">'+r[0]+"</td>"+r.slice(1).map(x=>'<td class="n">'+x+"</td>").join("")+"</tr>").join("")+"</tbody></table>":'<p class="note" style="margin:0">אין נתונים</p>';
const dd=(S.days||[]).slice(-28),mx=Math.max(1,...dd.map(x=>x[1]));
box.innerHTML="<h4>כניסות מגוגל לפי יום, 28 ימים</h4>"+'<svg class="spark" viewBox="0 0 280 60" role="img" aria-label="כניסות מגוגל לפי יום">'+dd.map((x,i)=>{const h=x[1]?Math.max(3,x[1]/mx*52):0;return '<rect x="'+(i*10+1)+'" y="'+(56-h)+'" width="7" height="'+h+'" rx="1.5"/>'}).join("")+"</svg>"+'<div class="axis"><span>'+(dd[0]?dm(dd[0][0]):"")+"</span><span>"+(dd.length?dm(dd[dd.length-1][0]):"")+"</span></div>"
+"<h4>הדפים שלנו בגוגל</h4>"+(X?'<ul class="kv"><li><span>מופיעים בגוגל</span><b>'+n(X.indexed)+"</b></li><li><span>גוגל ראה ועוד לא הכניס לתוצאות</span><b>"+n(X.crawledNotIndexed)+"</b></li><li><span>נבדקו בסך הכול</span><b>"+n(X.inspected)+"</b></li></ul>":'<p class="note" style="margin:0">אין נתון</p>')
+"<h4>מה חיפשו בגוגל כשהופענו (28 ימים)</h4>"+TB(["חיפוש","נכנסו","הופענו","מקום ממוצע"],qs.slice().sort((a,b)=>b[1]-a[1]||b[2]-a[2]).slice(0,10).map(r=>[esc(r[0]),n(r[1]),n(r[2]),ps(r[4])]))
+"<h4>חיפושים שקרובים לעמוד הראשון</h4>"+TB(["חיפוש","הופענו","מקום ממוצע"],qs.filter(r=>r[4]>=8&&r[4]<=20&&r[2]>=3).sort((a,b)=>b[2]-a[2]).slice(0,8).map(r=>[esc(r[0]),n(r[2]),ps(r[4])]))
+"<h4>הדפים שגוגל הציג (28 ימים)</h4>"+TB(["דף","נכנסו","הופענו"],(S.pages||[]).slice(0,8).map(r=>[PG(r[0]),n(r[1]),n(r[2])]))
+'<p class="note">נכנסו: לחצו על התוצאה ונכנסו לאתר. הופענו: כמה פעמים הופענו בתוצאות החיפוש. מקום ממוצע: המקום שלנו בתוצאות, כש-1 עד 10 הם העמוד הראשון.</p>'
+(S.sitemaps&&S.sitemaps.some(r=>r.errors||r.warnings)?'<p class="note">במפת האתר יש שגיאות או אזהרות. אני בודק ומתקן בסקירה השבועית.</p>':"")}}

// drawer: agent news
{const tm=t=>new Date(t).toLocaleTimeString("he-IL",{timeZone:"Asia/Jerusalem",hour:"2-digit",minute:"2-digit"});
$("fl").innerHTML=(d.flashes||[]).slice(0,12).map(f=>'<li><span class="ft">'+dm(new Date(f.t).toLocaleDateString("en-CA",{timeZone:"Asia/Jerusalem"}))+" "+tm(f.t)+'</span><span><span class="lv '+(f.l==="alert"||f.l==="wait"?"alert":"")+'">'+(f.l==="alert"||f.l==="wait"?"●":"○")+"</span> <b>"+esc(FK[f.k]||f.k)+":</b> "+esc(String(f.x||"").replace(/\\s*פירוט:[\\s\\S]*$/,""))+(f.u&&/^https:\\/\\//.test(f.u)?' <a href="'+esc(f.u)+'" target="_blank" rel="noopener">קישור</a>':"")+"</span></li>").join("")||'<li><span class="note">אין מבזקים עדיין.</span></li>'}

// drawer: what changed by itself (autopilot): each zone's mode, then the latest changes and would-be changes
window.LVD=d;renderCal();
{const A=d.auto,ZN={A:"לוח החלטות (בדיקות בזמנים קבועים)",B:"שיווק ותוכן",C:"ניסויי ניסוח",D:"הודעות באפליקציה",E:"סידור המסך",SEO:"SEO"},MD={on:["ok","פועל"],observe:["wait","בתצפית, לא משנה"],off:["cal","כבוי"]},RS={kept:"נשאר",reverted:"הוחזר",pending:"בבדיקה"};
$("auto").innerHTML=!A?'<p class="note" style="margin:0">אין עדיין יומן שינויים.</p>':"<h4>מצב כל אזור</h4>"+'<ul class="kv">'+Object.keys(ZN).map(z=>{const m=MD[(A.modes||{})[z]]||MD.off;return "<li><span>"+ZN[z]+"</span><b>"+chip(m[0],z==="E"&&(A.modes||{})[z]!=="on"?"לא אושר עדיין":m[1])+"</b></li>"}).join("")+"</ul>"
+"<h4>שינויים אחרונים</h4>"+((A.rows||[]).length?'<ul class="kv fl">'+A.rows.slice(0,12).map(r=>'<li><span class="ft">'+(r.d?dm(r.d):"")+"</span><span><b>"+esc(ZN[r.z]||r.z||"")+":</b> "+(r.m==="observe"?"היה משנה: ":r.m==="on"?"שינה: ":"")+esc(r.x||"")+(RS[r.r]?' <span class="note">('+RS[r.r]+")</span>":"")+"</span></li>").join("")+"</ul>":'<p class="note" style="margin:0">עוד לא היו שינויים.</p>')
+'<p class="note">בתצפית: הבוט רק רושם מה היה משנה, ולא משנה כלום. כל שינוי נבדק אחרי שבוע, ומוחזר לבד אם המדד שלו ירד. המספרים עצמם נשמרים ביומן הפרטי.'+(A.at?" עודכן "+dm(String(A.at).slice(0,10))+".":"")+"</p>"}

// drawer: technical
{const fk=W&&W.fails?W.fails[0]:null;
const li=(l,v)=>"<li><span>"+l+"</span><b>"+v+"</b></li>";
$("tec").innerHTML="<h4>בדיקות שלא החזירו תוצאה, לפי סיבה ("+rng(W&&W.W)+")</h4>"+(fk?'<ul class="kv">'+(Object.entries(fk).sort((a,b)=>b[1]-a[1]).map(e=>li(KIND[e[0]]||esc(e[0]),n(e[1]))).join("")||li("אין","0"))+"</ul>":'<p class="note" style="margin:0">אין נתון</p>')
+'<p class="note">'+(H.att!=null?"מתוך "+n(H.att)+" ניסיונות בדיקה. בתקינות השירות נספרות רק שתי סיבות: משרד התחבורה לא ענה, ולא התקבלה תשובה. מספר שהוקלד לא נכון אינו תקלה.":"")+"</p>"
+"<h4>עוד סימנים טכניים השבוע</h4>"+'<ul class="kv">'+(()=>{const c=SL5&&SL5.c,p=SL5&&SL5.p,hi=c&&c.k>=50&&c.p>10;return "<li><span>בדיקות איטיות (יותר מ-5 שניות)<small>"+(c?"מתוך "+n(c.k)+" בדיקות. יותר מ-10 שניות: <bdi>"+n1(c.p10)+"%</bdi> מהבדיקות."+(p?" בשבוע הקודם: <bdi>"+n1(p.p)+"%</bdi> יותר מ-5 שניות.":"")+" דורש תשומת לב מעל 10%.":"אין נתון על משך הבדיקות")+"</small></span><b>"+(hi?chip("warn","מעל 10%")+" ":"")+(c?n1(c.p)+"%":"-")+"</b></li>"})()+[["בדיקות שבוטלו באמצע","lookup_abort"],["קריסות של האפליקציה","app_exception"],["חיפושי דגם בלי תוצאה","search_no_result"]].map(x=>li(x[0],ev?n(ge(E0,x[1])):"-")).join("")+"</ul>"
+"<h4>אזור הזמן של גוגל אנליטיקס</h4>"+'<p class="note" style="margin:0">'+(!d.gaTz?"לא נבדק":d.gaTz.ok?stl(d.gaTz)+(d.gaTz.tz==="Asia/Jerusalem"?"שעון ישראל, כמו שהמסך מניח ✓":"<b>"+esc(d.gaTz.tz||"לא ידוע")+"</b>: לא שעון ישראל, ולכן ימים ושבועות במסך נחתכים בשעה אחרת. אפשר לשנות ב-Analytics, בהגדרות הנכס."):"לא נבדק: "+(/not been used|disabled/i.test(d.gaTz.why||"")?"צריך להפעיל את Google Analytics Admin API בפרויקט של חשבון השירות. ":"")+'<bdi dir="ltr">('+esc(whyT(d.gaTz.why))+")</bdi>")+"</p>"
+"<h4>דוחות Google Play (התקנות)</h4>"+'<p class="note" style="margin:0">'+(PS?stl(d.stats)+"מחובר. היום האחרון שגוגל מסרה: "+dm(PS.last)+".":!d.stats?"לא נבדק":d.stats.why==="no bucket"?"לא מחובר עדיין: חסר שם הדלי של הדוחות. עד אז מספר המכשירים מחושב מגוגל אנליטיקס בלבד.":"לא מחובר עדיין"+(/^40[13]/.test(d.stats.why||"")?": לחשבון השירות אין עדיין הרשאה להוריד דוחות. צריך הרשאה ברמת החשבון ב-Play Console, והיא יכולה להיכנס לתוקף רק אחרי עד 48 שעות.":/^404/.test(d.stats.why||"")?": לא נמצאו דוחות התקנות. כדאי לבדוק את שם הדלי.":".")+' <bdi dir="ltr">('+esc(whyT(d.stats.why))+")</bdi>")+"</p>"
+"<h4>Play Console</h4>"+'<p class="note" style="margin:0">'+(d.release?d.release.ok?stl(d.release)+"מחובר. מצב הגרסאות בחנות נקרא משם.":"לא מחובר עדיין"+(/not been used|disabled/i.test(d.release.why||"")?": צריך להפעיל את Google Play Android Developer API בפרויקט של חשבון השירות ב-Google Cloud.":/permission|^40[13]/i.test(d.release.why||"")?": לחשבון השירות אין עדיין הרשאת צפייה באפליקציה ב-Play Console.":".")+' <bdi dir="ltr">('+esc(whyT(d.release.why))+")</bdi>":"לא נבדק")+"</p>"
+"<h4>מקורות נתונים</h4>"+'<ul class="kv">'+(Object.entries(d.errors||{}).map(e=>li(esc(e[0]),'<span style="font-weight:400">'+esc(whyT(e[1]))+"</span>")).join("")||li("כל המקורות ענו","✓"))+"</ul>"}

$("build").textContent="גרסה "+(d.build||"");
}

async function go(){const meta=$("meta");try{const r=await fetch("/live/data",{cache:"no-store",signal:AbortSignal.timeout?AbortSignal.timeout(35e3):undefined});if(!r.ok)throw r.status;const d=await r.json();window.lastD=d;render(d);
const tm=new Date(d.at).toLocaleTimeString("he-IL",{timeZone:"Asia/Jerusalem",hour:"2-digit",minute:"2-digit"});
meta.className="meta"+(d.stale||d.late?" stale":"");meta.innerHTML='<span class="dot"></span>'+(d.late?"נתונים מ-"+tm+": השרת לא ענה בזמן, ננסה שוב בעוד דקה":d.stale?"נתונים ישנים מ-"+tm+", גוגל הגביל זמנית את מספר הבקשות":"עודכן "+tm)}
catch(e){meta.className="meta stale";meta.innerHTML='<span class="dot"></span>'+(e===504?"השרת לא ענה בזמן, ננסה שוב בעוד דקה":"אין חיבור")+(window.lastD?". מוצגים הנתונים האחרונים":"")}}
document.addEventListener("click",e=>{const a=e.target.closest("[data-open]");if(a){const el=$(a.dataset.open);if(el){e.preventDefault();el.open=true;el.scrollIntoView({behavior:"smooth",block:"start"});el.classList.remove("hit");void el.offsetWidth;el.classList.add("hit");setTimeout(()=>el.classList.remove("hit"),1800)}return}
const tr=e.target.closest("tr[data-ev]");if(tr&&!e.target.closest("a")){const nx=tr.nextElementSibling;if(nx&&nx.classList.contains("skr")){nx.remove();return}const D=window.lastD,Wk=D&&D.weekly,o=Wk&&Wk.e28&&Wk.e28[tr.dataset.ev];if(!o)return;const r=document.createElement("tr");r.className="skr";r.innerHTML='<td colspan="3">'+spark28(o,Wk.M)+"</td>";tr.after(r);return}
// phones: a tile or a health cell shows its chart and lines on a tap
const k=e.target.closest(".kpi,.hc");if(k&&!e.target.closest("a")&&matchMedia("(max-width:560px)").matches)k.classList.toggle("open")});
// the top line on its own every 30 seconds; when the screen comes back (phone unlocked, tab reopened) everything at once, not at the next tick
function onl(o,stale,at){const e=$("onl");if(!o){if(!window.lastOnl)e.hidden=true;return}window.lastOnl=o;e.hidden=false;const tm=at?new Date(at).toLocaleTimeString("he-IL",{timeZone:"Asia/Jerusalem",hour:"2-digit",minute:"2-digit"}):"";e.innerHTML='<span><i class="pd"></i> מחוברים עכשיו:</span><span><b>'+o.app.toLocaleString("he-IL")+"</b> באפליקציה</span><span><b>"+o.web.toLocaleString("he-IL")+'</b> באתר</span><small>5 הדקות האחרונות'+(stale?", נתון אחרון שנשמר":"")+(tm?" · "+tm:"")+"</small>"}
async function now(){try{const r=await fetch("/live/now",{cache:"no-store",signal:AbortSignal.timeout?AbortSignal.timeout(15e3):undefined});if(!r.ok)return;const j=await r.json();onl(j.online,j.stale,j.at)}catch(e){}}
let lastGo=Date.now();const tick=()=>{if(document.hidden)return;if(Date.now()-lastGo>=59e3){lastGo=Date.now();go()}else now()};
go();setInterval(tick,30000);document.addEventListener("visibilitychange",()=>{if(!document.hidden){lastGo=Date.now();go()}});
// the tasks and the calendar (Dudu 26.10): what needs Dudu first, a "בוצע" button that also reaches Claude, the bots' own plans folded
const calLocal={};
function renderCal(){const d=window.LVD||{},C=d.cal,box=$("calb");if(!box)return;if(!C){box.innerHTML='<p class="note">היומן עוד לא זמין.</p>';$("cals").textContent="";return}
const done=Object.assign({},d.calDone||{});for(const k in calLocal){if(calLocal[k])done[k]=calLocal[k];else delete done[k]}
const today=new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Jerusalem"}),DN=["ראשון","שני","שלישי","רביעי","חמישי","שישי","שבת"];
const days=x=>Math.round((Date.parse(x+"T12:00:00Z")-Date.parse(today+"T12:00:00Z"))/864e5);
const when=o=>{if(!o.d)return "אפשר כבר עכשיו";const x=new Date(o.d+"T12:00:00Z"),n=days(o.d),dm=x.getUTCDate()+"."+(x.getUTCMonth()+1)+(o.d.slice(0,4)!==today.slice(0,4)?"."+o.d.slice(2,4):"");return (n===0?"היום":n===1?"מחר":"יום "+DN[x.getUTCDay()]+" "+dm)+(o.t?" ב-"+o.t:"")};
const gcal=o=>{const st=o.d.replace(/-/g,"")+(o.t?"T"+o.t.replace(":","")+"00":""),en=o.t?(()=>{const m=+o.t.slice(0,2)*60+ +o.t.slice(3)+30;return o.d.replace(/-/g,"")+"T"+String(Math.floor(m/60)%24).padStart(2,"0")+String(m%60).padStart(2,"0")+"00"})():(()=>{const x=new Date(o.d+"T12:00:00Z");x.setUTCDate(x.getUTCDate()+1);return x.toISOString().slice(0,10).replace(/-/g,"")})();
return "https://calendar.google.com/calendar/render?action=TEMPLATE&text="+encodeURIComponent("לוחית: "+o.what)+"&dates="+st+"/"+en+"&ctz=Asia/Jerusalem&details="+encodeURIComponent((o.ask?o.ask+" ":"")+"https://luchit.app/live")};
const all=[...(C.open||[]),...(C.items||[]).filter(o=>o.d>=today)],mine=all.filter(o=>o.me&&o.id&&!done[o.id]).sort((x,y)=>(x.d||"0")+(x.t||"")<(y.d||"0")+(y.t||"")?-1:1);
const soon=mine.filter(o=>!o.d||days(o.d)<=7),later=mine.filter(o=>o.d&&days(o.d)>7),bots=(C.items||[]).filter(o=>!o.me&&o.d>=today).sort((x,y)=>(x.d+x.t)<(y.d+y.t)?-1:1),fin=all.filter(o=>o.id&&done[o.id]);
const task=o=>'<li class="tk"><div class="tw"><b>'+esc(o.what)+"</b>"+(o.ask?'<span class="ca">'+esc(o.ask)+"</span>":"")+'<span class="co">'+(o.d&&days(o.d)<=1?'<b class="due">'+when(o)+"</b>":when(o))+" · "+esc(o.owner)+'</span></div><div class="tb"><button type="button" class="okb" data-done="'+o.id+'">✓ בוצע</button>'+(o.d?'<a href="'+gcal(o)+'" target="_blank" rel="noopener">ליומן</a>':"")+"</div></li>";
const fold=(t,n,inner)=>n?'<details class="dr"><summary>'+t+" ("+n+")</summary>"+inner+"</details>":"";
$("cals").textContent=soon.length?(soon.length===1?"משימה אחת מחכה לך עכשיו או השבוע":soon.length+" משימות מחכות לך עכשיו או השבוע"):"שום דבר לא מחכה לך השבוע";
box.innerHTML=(soon.length?'<ul class="tks">'+soon.map(task).join("")+"</ul>":'<p class="note">אין משימות שלך השבוע.</p>')
+fold("המשימות שלך בהמשך",later.length,'<ul class="tks">'+later.map(task).join("")+"</ul>")
+fold("מה הבוטים עושים לבד, בלי שצריך אותך",bots.length,'<ul class="bl">'+bots.map(o=>"<li><span>"+when(o)+"</span>"+esc(o.what)+' <span class="co">'+esc(o.owner)+"</span></li>").join("")+"</ul>")
+fold("מה קורה כל שבוע",(C.weekly||[]).length,'<ul class="bl">'+(C.weekly||[]).map(o=>"<li><span>"+esc(o.when)+"</span>"+esc(o.what)+' <span class="co">'+esc(o.owner)+"</span></li>").join("")+"</ul>")
+fold("סימנת שבוצע",fin.length,'<ul class="bl">'+fin.map(o=>"<li><s>"+esc(o.what)+'</s> <button type="button" class="un" data-undo="'+o.id+'">ביטול</button></li>').join("")+"</ul>")
+(C.at?'<p class="note">הרשימה עודכנה '+new Date(C.at).toLocaleString("he-IL",{timeZone:"Asia/Jerusalem",day:"numeric",month:"numeric",hour:"2-digit",minute:"2-digit"})+".</p>":"")}
{const x=$("calx"),K="lv-cal-open";try{if(localStorage.getItem(K)==="0")x.open=false}catch(e){}x.addEventListener("toggle",()=>{try{localStorage.setItem(K,x.open?"1":"0")}catch(e){}});
$("cal").addEventListener("click",async e=>{const b=e.target.closest("[data-done],[data-undo]");if(!b)return;const id=b.getAttribute("data-done")||b.getAttribute("data-undo"),on=b.hasAttribute("data-done");b.disabled=true;
try{const r=await fetch("/live/cal",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:id,done:on})});if(!r.ok)throw r.status;calLocal[id]=on?new Date().toISOString():null;renderCal()}catch(err){b.disabled=false;b.textContent="לא נשמר, לנסות שוב"}})}
{const hb=$("hb"),HK="lv-help",set=on=>{document.body.classList.toggle("hp",on);hb.setAttribute("aria-pressed",on?"true":"false");hb.textContent=on?"בלי הסברים":"הסבר"};
hb.addEventListener("click",()=>{const on=!document.body.classList.contains("hp");set(on);try{localStorage.setItem(HK,on?"1":"0")}catch(e){}});let on=true;try{on=localStorage.getItem(HK)!=="0"}catch(e){}set(on)}
</script></body></html>`;

// /live/data answers within 25 s whatever an outside call does: on time = fresh data, kept as the last good answer (this isolate, and this
// data centre's cache for a new isolate); late or failed = that last good answer marked late, which the page shows with its time, or a
// 504 when there is none. On 20.10 one hung call kept every load of the screen on "loading" for two hours.
const DEADLINE = 25e3, LAST = "https://luchit.app/live/_last";
let lastGood = null;
async function liveData(env, ctx) {
  let timer, failed = false;
  const work = (async () => ({ ...(await collect(env)), flashes: (await getFlashes()).slice(0, 15), metrics: slimMetrics(await getMetrics()), auto: slimAuto(await getAuto()), cal: slimCal(await getCal()), calDone: await calDone(env), acts: await actsGet(env) }))();
  const late = new Promise(r => { timer = setTimeout(() => r(null), DEADLINE); });
  const d = await Promise.race([work.catch(() => { failed = true; return null; }), late]);
  clearTimeout(timer);
  if (d) {
    lastGood = d;
    ctx?.waitUntil?.(caches.default.put(LAST, new Response(JSON.stringify(d), { headers: { "content-type": "application/json", "cache-control": "max-age=172800" } })).catch(() => {}));
    return json(d);
  }
  let keep = lastGood;
  if (!keep) try { const r = await caches.default.match(LAST); keep = r ? await r.json() : null; } catch {}
  return keep ? json({ ...keep, late: true }) : failed ? json({ error: "unavailable" }, 502) : json({ error: "timeout" }, 504);
}

// the new screen (3.11.2026, spec in the measurement thread): one registry of metrics with their definitions, sources and owners, one status engine,
// three lenses (CEO, division, department) and a drill-down panel, reading the same /live/data. Served at /live (and /live/v2) since Dudu's second "שחרר" of 3.11.2026; the old
// page stays at /live/v1 for a while. String.raw keeps the page's backslashes as written; the page holds no backtick and no "${".
const PAGE2 = String.raw`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark"><title>לוחית · מצב העסק</title><link rel="icon" href="https://luchit.app/icon-192.png">
<style>
:root{--bg:#F3F4F2;--card:#FFFFFF;--line:#E2E5E3;--fg:#1A1D21;--muted:#5B6470;--muted2:#69727D;--soft:#F7F8F7;--soft2:#EEF0F2;--plate:#F6C945;--app:#2A78D6;--site:#EB6834;--aqua:#1BAF7A;--prev:#C9CDCB;--ok:#1B7F3B;--ok-bg:#E6F4EA;--warn:#8A5B00;--warn-bg:#FFF3D6;--bad:#A8271F;--bad-bg:#FBE9E7;--nt:#5B6470;--nt-bg:#EEF0F2;--link:#1A4F8A;--decide:#FFF8E1;--ink-on-plate:#1A1D21;--shade:rgba(26,29,33,.28)}
@media(prefers-color-scheme:dark){:root{--bg:#0F1316;--card:#171C21;--line:#2A3139;--fg:#E8ECEF;--muted:#A3ACB6;--muted2:#8C96A0;--soft:#1D2329;--soft2:#242B32;--plate:#F6C945;--app:#6FA3EE;--site:#F0865E;--aqua:#3FC495;--prev:#4A535C;--ok:#6FCB97;--ok-bg:#15281E;--warn:#E3A957;--warn-bg:#2B2316;--bad:#F2908A;--bad-bg:#2F1C1C;--nt:#A3ACB6;--nt-bg:#242B32;--link:#8FB4EC;--decide:#2A2612;--shade:rgba(0,0,0,.5)}}
[hidden]{display:none!important}*{box-sizing:border-box}html{direction:rtl}body{margin:0;background:var(--bg);color:var(--fg);font-family:Arial,"Arial Hebrew","Liberation Sans",Helvetica,sans-serif;font-variant-numeric:tabular-nums;line-height:1.45;font-size:14px;text-align:right}
h1,h2,h3,h4,p,ul,ol{margin:0}a.card,a.q{text-decoration:none;color:inherit}ul,ol{padding:0;list-style:none}a{color:var(--link)}button{font-family:inherit;font-size:inherit;color:inherit}
.top{background:var(--card);border-bottom:1px solid var(--line);padding:10px 20px;display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px;position:sticky;top:0;z-index:5}
.brand{display:flex;align-items:center;gap:10px}.brand .pl{display:inline-block;background:var(--plate);color:var(--ink-on-plate);border:2px solid #1A1D21;border-radius:5px;padding:1px 9px;font-weight:700;font-size:15px;letter-spacing:1px}.brand h1{font-size:16px;font-weight:700}
.seg{display:flex;gap:3px;background:var(--soft2);border-radius:999px;padding:3px}.seg button,.seg a{border:0;background:transparent;color:var(--fg);border-radius:999px;padding:6px 13px;cursor:pointer;text-decoration:none;white-space:nowrap;font-size:14px}.seg .on{background:var(--fg);color:var(--card);font-weight:700}
.meta{color:var(--muted);font-size:13px;display:flex;align-items:center;gap:6px}.meta .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--nt)}.meta.stale{color:var(--warn)}.meta.stale .dot{background:var(--warn)}
.onl{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}.onl b{color:var(--fg)}.onl .pd{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--ok)}
.hr{margin-inline-start:auto;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
main{max-width:1320px;margin:0 auto;padding:16px 20px 32px;display:flex;flex-direction:column;gap:14px}
.crumb{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;color:var(--muted);font-size:13px}.crumb a{color:var(--link);text-decoration:none}.crumb b{color:var(--fg)}
.tabs{display:flex;flex-wrap:wrap;gap:6px}.tabs a{display:inline-flex;align-items:center;gap:8px;text-decoration:none;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:5px 12px;font-size:13px}.tabs a.on{border-color:var(--fg);font-weight:700}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;min-width:0;display:flex;flex-direction:column;gap:10px}
.card h2{font-size:15px;font-weight:700}.ch{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:6px 12px}.ch small,.win{color:var(--muted);font-size:12px;font-weight:400}
.g3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.g2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.span2{grid-column:span 2}
.chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:700;white-space:nowrap;background:var(--sb);color:var(--s)}.chip i{font-style:normal}
.s-ok{--s:var(--ok);--sb:var(--ok-bg)}.s-warn{--s:var(--warn);--sb:var(--warn-bg)}.s-bad{--s:var(--bad);--sb:var(--bad-bg)}.s-early,.s-nodata,.s-live,.s-ref,.s-wait,.s-cal{--s:var(--nt);--sb:var(--nt-bg)}
.verdict{flex-direction:row;flex-wrap:wrap;align-items:center;gap:10px 16px}.verdict p{font-size:17px;font-weight:700;flex:1 1 380px;min-width:0}.verdict small{color:var(--muted);font-size:12px}
.plate{display:inline-flex;align-items:center;background:var(--plate);color:var(--ink-on-plate);border:3px solid #1A1D21;border-radius:8px;padding:4px 16px;font-size:50px;font-weight:700;line-height:1.05;text-decoration:none}.plate.sm{font-size:40px;padding:3px 14px}
.hero{display:flex;flex-wrap:wrap;align-items:center;gap:12px 26px}.hero .lines{display:flex;flex-direction:column;gap:5px;min-width:0}.hero .split{margin-inline-start:auto;display:flex;flex-direction:column;gap:3px;font-size:13px;color:var(--muted)}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:middle;margin-inline-end:6px}.sw.app{background:var(--app)}.sw.site{background:var(--site)}.sw.prev{background:var(--prev)}.sw.aqua{background:var(--aqua)}.sw.goal{width:14px;height:0;border-top:2px solid var(--fg)}
.up{color:var(--ok);font-weight:700}.down{color:var(--bad);font-weight:700}.flat{color:var(--muted)}
.bars{position:relative;direction:ltr;border-bottom:1px solid var(--prev);display:flex;align-items:flex-end;gap:8px;padding:0 2px;height:160px}.bars.sm{height:110px;gap:5px}.bars .b{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;position:relative}.bars .b i{display:block;width:100%;max-width:56px}.bars .b .a{background:var(--app);margin-top:2px}.bars .b .w{background:var(--site);border-radius:4px 4px 0 0}.bars .b .one{border-radius:4px 4px 0 0}.bars .b .g{position:absolute;left:50%;right:auto;width:76px;max-width:none;margin-left:-38px;height:0;border-top:2px solid var(--fg);z-index:1}.bars .b .v{font-size:12px;font-weight:700;margin-bottom:3px}.bars .b .l{position:absolute;top:100%;margin-top:5px;font-size:11px;color:var(--muted);white-space:nowrap}.bars .b.cur .l{color:var(--fg);font-weight:700}.bars+.ax{height:16px}
.lg{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px}.tiles.k5{grid-template-columns:repeat(5,minmax(0,1fr))}.tiles.k4{grid-template-columns:repeat(4,minmax(0,1fr))}.tiles.k3{grid-template-columns:repeat(3,minmax(0,1fr))}
.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px 14px 11px;display:flex;flex-direction:column;gap:5px;min-width:0;text-decoration:none;color:inherit;cursor:pointer;text-align:right}.tile:hover{border-color:var(--fg)}.tile .nm{font-size:13px;color:var(--muted)}.tile .bg{font-size:28px;font-weight:700;line-height:1.1}.tile .bg small{font-size:13px;font-weight:400;color:var(--muted)}.tile .dl{font-size:12px}.tile .tg{font-size:12px}.tile .fr{font-size:11px;color:var(--muted2)}
.meter{height:6px;background:var(--soft2);border-radius:999px;overflow:hidden}.meter i{display:block;height:100%;border-radius:999px;background:var(--s)}
.todo{display:flex;flex-direction:column;gap:9px}.todo li{display:flex;flex-direction:column;gap:5px;padding:10px 12px;background:var(--soft);border-radius:10px}.todo li.dec{background:var(--decide)}.todo .tag{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--muted)}.todo .tag b{background:var(--fg);color:var(--card);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:400}.todo .tag .fix{background:var(--bad-bg);color:var(--bad)}.todo .tag .fyi{background:var(--nt-bg);color:var(--nt)}.todo .what{font-weight:700}.todo .btns{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.todo small{color:var(--muted);font-size:12px}
.btn{background:var(--fg);color:var(--card);border:0;border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer}.btn.sec{background:var(--card);color:var(--fg);border:1px solid var(--prev)}.btn:disabled{opacity:.6;cursor:default}.btn.done{background:var(--ok-bg);color:var(--ok);border:1px solid var(--ok-bg)}
.fun{display:flex;flex-direction:column;gap:7px;min-width:0}.fun h4{font-size:13px}.fr{display:flex;align-items:center;gap:10px}.fr span{width:132px;font-size:13px;flex:none}.fr .bb{flex:1;height:20px;background:var(--soft2);border-radius:4px;overflow:hidden;position:relative}.fr .bb i{display:block;height:100%;background:var(--c);opacity:.85}.fr .bb i.p{position:absolute;top:0;left:0;height:100%;background:transparent;border-left:2px solid var(--muted)}.fr b{width:60px;text-align:left;flex:none;direction:ltr}.fr .pc{width:56px;font-size:12px;color:var(--muted);flex:none}
.rows{display:flex;flex-direction:column;gap:8px}.row{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;text-decoration:none;color:inherit}.row:hover{border-color:var(--fg)}.row .h{display:flex;justify-content:space-between;align-items:center;gap:8px}.row small{color:var(--muted);font-size:12px}
.qs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.q{display:flex;flex-direction:column;gap:6px;padding:12px;background:var(--soft);border-radius:10px}.q small{font-size:12px;color:var(--muted)}.q .chip{align-self:flex-start}
.kv{display:flex;flex-direction:column;gap:5px;font-size:13px}.kv li{display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid var(--soft2);padding-bottom:4px}.kv li span{min-width:0}.kv li small{display:block;color:var(--muted);font-size:12px}.kv li b{text-align:left;direction:ltr;white-space:nowrap}
.note{font-size:12px;color:var(--muted)}.help{font-size:12px;color:var(--muted);background:var(--soft);border-radius:8px;padding:8px 10px}
table.t{border-collapse:collapse;width:100%;font-size:13px}.t th{text-align:right;color:var(--muted);font-weight:400;font-size:12px;padding:5px 6px;border-bottom:1px solid var(--prev)}.t td{padding:6px 6px;border-bottom:1px solid var(--soft2);vertical-align:top}.t td.n,.t th.n{text-align:left;direction:ltr;white-space:nowrap}.t td.w{min-width:120px}.tw{overflow-x:auto}
.foot{color:var(--muted2);font-size:12px;display:flex;flex-wrap:wrap;gap:6px 18px}
.shade{position:fixed;inset:0;background:var(--shade);z-index:20}.panel{position:fixed;top:0;bottom:0;right:0;width:min(640px,100%);background:var(--card);box-shadow:-10px 0 28px rgba(0,0,0,.22);z-index:21;overflow-y:auto;display:flex;flex-direction:column}
.ph{position:sticky;top:0;background:var(--card);border-bottom:1px solid var(--line);padding:14px 20px 12px;display:flex;flex-direction:column;gap:10px;z-index:2}.ph h2{font-size:19px}.ph .r1{display:flex;align-items:flex-start;gap:12px}.ph .r1 div{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}.ph .r2{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pb{padding:16px 20px 28px;display:flex;flex-direction:column;gap:16px}.pb h3{font-size:14px}.pb section{display:flex;flex-direction:column;gap:7px}
.brk{display:flex;align-items:center;gap:8px}.brk span{width:120px;font-size:13px;flex:none}.brk .bb{flex:1;height:14px;background:var(--soft2);border-radius:3px;overflow:hidden}.brk .bb i{display:block;height:100%;background:var(--c)}.brk b{width:48px;text-align:left;direction:ltr;font-size:13px;flex:none}
.tbtn{background:var(--card);color:var(--fg);border:1px solid var(--prev);border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer}
.dots span{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--ok);margin:0 1px 2px 0;vertical-align:middle;font-size:0}.dots .s-bad{background:var(--bad)}.dots .s-warn{background:var(--warn)}.dots .s-early,.dots .s-nodata{background:var(--prev)}
.lv{color:var(--muted)}.lv.alert{color:var(--bad)}.ft{color:var(--muted);font-size:12px;white-space:nowrap}
.spark{width:100%;height:50px;display:block}.spark rect{fill:var(--app)}.spark .t-site{fill:var(--site)}.axis{display:flex;justify-content:space-between;font-size:11px;color:var(--muted)}
.sec{font-size:15px;font-weight:700;margin-top:4px}
@media(max-width:900px){.g3,.g2{grid-template-columns:1fr}.span2{grid-column:auto}.tiles,.tiles.k5,.tiles.k4{grid-template-columns:repeat(3,minmax(0,1fr))}.qs{grid-template-columns:1fr}}
@media(max-width:700px){body{font-size:13px}.top{padding:8px 12px;gap:8px 12px}.hr{margin-inline-start:0;width:100%;justify-content:space-between}main{padding:10px 12px 24px;gap:10px}.card{padding:12px 13px}.tiles,.tiles.k5,.tiles.k4,.tiles.k3{grid-template-columns:repeat(2,minmax(0,1fr))}.plate{font-size:40px;padding:3px 12px}.bars{height:110px;gap:5px}.fr span{width:96px;font-size:12px}.fr b{width:46px}.fr .pc{width:36px}.panel{width:100%;box-shadow:none}.seg button,.seg a{padding:5px 10px;font-size:13px}.verdict p{font-size:15px}.brk span{width:90px}}
@media(prefers-reduced-motion:no-preference){.panel{animation:in .18s ease-out}@keyframes in{from{transform:translateX(100%)}to{transform:none}}}
</style></head><body>
<header class="top">
 <div class="brand"><span class="pl">לוחית</span><h1>מצב העסק</h1></div>
 <nav class="seg" id="lens" aria-label="עדשה"></nav>
 <div class="seg" id="wins" role="group" aria-label="חלון זמן"></div>
 <div class="hr"><span class="onl" id="onl" hidden></span><span class="meta" id="meta"><span class="dot"></span>טוען</span></div>
</header>
<main id="main"><p class="note" style="padding:20px">טוען את הנתונים</p></main>
<div class="shade" id="shade" hidden></div>
<aside class="panel" id="panel" role="dialog" aria-modal="true" aria-label="פירוט מדד" hidden></aside>
<script>
"use strict";
// לוחית · מצב העסק: one registry of metrics, one status engine, three lenses (CEO, division, department) and a drill-down panel.
// Everything is computed here from /live/data (the same answer the old page reads), so no number has a second pipeline.
const CAL_END="2026-11-02";        // the base week 26.10-1.11: before its end only health, Google pages and the store had a colour
const COLS=new Date(Date.parse(CAL_END+"T12:00:00Z")+864e5).toISOString().slice(0,10);
const SITE_FROM="2026-10-15";      // car checks on the site are counted from this day (the app's from the start)
// Yearly goals from the CMO plan (reports/marketing-goals-2026-10.json): per month [cons, base, opt], Nov 2026 to Oct 2027 (same table as the old page)
const GOALS={first:"2026-11",k:{weekly_checks:[[160,190,240],[190,240,330],[250,330,490],[270,380,600],[320,470,800],[360,550,990],[430,680,1310],[500,820,1670],[560,970,2080],[640,1150,2600],[690,1290,3050],[740,1430,3540]],installs_week:[[30,40,50],[35,50,70],[50,70,105],[50,75,120],[60,90,155],[65,100,185],[75,125,245],[85,145,300],[95,165,360],[105,190,435],[105,200,480],[105,210,525]],google_clicks_week:[[4,5,6],[7,9,13],[11,15,23],[15,22,36],[22,33,57],[29,45,83],[37,60,117],[47,80,165],[60,105,228],[74,135,308],[84,160,383],[95,190,475]],pages_indexed:[[100,120,150],[110,150,180],[120,165,200],[130,180,220],[140,195,240],[145,210,255],[150,220,265],[155,230,275],[160,240,285],[165,250,295],[170,260,300],[175,270,305]],share_per_100:[[2,3,4],[3,4,5],[3,4,6],[3,5,7],[4,6,8],[4,6,9],[4,7,9],[5,7,10],[5,8,11],[5,9,12],[6,9,13],[6,10,14]],app_active_28d:[[110,150,190],[150,200,280],[210,300,450],[240,350,550],[290,430,730],[330,510,900],[410,650,1200],[480,780,1510],[540,910,1860],[620,1080,2300],[670,1200,2650],[720,1320,3030]],failures_pct:[[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5]],subscribers_total:[[5,15,45],[10,30,90],[20,50,150],[30,70,210],[35,90,270],[50,120,360],[60,150,450],[80,200,600],[100,250,750],[120,300,900],[140,350,1050],[160,400,1200]]},
 from:{weekly_checks:["2026-10-25",170],google_clicks_week:["2026-10-14",0],pages_indexed:["2026-10-17",90],app_active_28d:["2026-10-18",23],subscribers_total:["2026-10-01",0]},
 calib:{keys:["weekly_checks","installs_week"],end:"2026-11-01",lo:.5,hi:20}};
const SUBMITTED="2026-10-17",PRO_MAU=2000,QF="2026-10-21",QE="2026-11-22";
const N={car_lookup:"בדיקת רכב",car_save:"שמירת רכב ברשימה",share:"שיתוף (דוח רכב או השוואה)",compare_open:"השוואת רכבים",tab_view:"מעבר בין לשוניות",link_out:"לחיצה על קישור חיצוני",alerts_toggle:"הדלקה או כיבוי של התראות",alert_kind:"בחירת סוג התראה",upgrade_open:"פתיחת חלונית המנוי (PRO)",voice_search:"חיפוש בקול",bulk_check:"בדיקת כמה רכבים יחד",camera_scan:"סריקת לוחית במצלמה",buy_card_open:"פתיחת כרטיס בלשונית קנייה",settlement_shown:"הצגת הסדר פשרה",checklist_pdf:"הורדת רשימת בדיקה",doc_add:"הוספת מסמך לרכב",doc_exp:"תאריך תוקף למסמך (הוספה או שינוי)",doc_scan:"קריאת תאריך התוקף מהמסמך (בטלפון)",simple_view:"מעבר לתצוגה פשוטה",search_no_result:"חיפוש דגם בלי תוצאה",user_screenshot:"צילום מסך",first_open:"התקנה חדשה (פתיחה ראשונה)",lookup_repeat:"פתיחה חוזרת של רכב (רענון)",notif_open:"פתיחת התראה מהטלפון",notif_sent:"התראה שנשלחה לטלפון",web_hint_click:"לחיצה על הצעה להתקין מהאתר",web_install_click:"מעבר מהאתר להתקנה",calendar_reminder_click:"הוספת תזכורת ליומן",link_landing:"כניסה לאתר מקישור",link_open:"פתיחת קישור באפליקציה",web_visit:"כניסה לאתר",referral_open:"פתיחה ראשונה אחרי התקנה מקישור ששותף",share_open:"פתיחת חלון השיתוף",nav:"מעבר בתפריט התחתון",cars_mode:"החלפת תצוגה ברכבים שלי",alert_item:"לחיצה על פריט במסך ההתראות",road_docs:"פתיחת מסמכים לנסיעה",history_pdf:"הפקת דוח היסטוריה (PDF)",mine_set:"פתיחת תיק לרכב שלי",mine_unset:"ביטול סימון הרכב שלי",car_unsave:"הסרת רכב מהרכבים שלי",home_open:"פתיחה מהאייקון במסך הבית (אתר)",home_sheet:"הצעה באייפון להוסיף למסך הבית",first_save:"שמירת רכב ראשונה (ביום ההתקנה)",app_return:"חזרה לאפליקציה בשבוע הראשון",zombie_shown:"הצגת רכב שירד מהכביש וחזר",lookup_from_cache:"הצגת בדיקה שמורה (בלי חיבור)",buy_step_done:"סימון שלב ברשימת הקנייה",check_open:"פתיחת סעיף ברשימת הבדיקה",simple_more:"הרחבה בתצוגה הפשוטה",calendar_reminder_shown:"הצגת הצעה לתזכורת ביומן",car_nick:"כינוי לרכב",web_install_prompt:"הצגת הצעה להתקין (באתר)",svc_add:"רישום טיפול או קילומטראז' לרכב",svc_cal:"הטיפול הבא ליומן",trial_start:"התחלת ניסיון PRO",trial_end_shown:"הודעת סוף ניסיון PRO",upgrade_purchase_start:"התחלת רכישת PRO",update_prompt:"הצעה לעדכן גרסה",update_start:"התחלת עדכון גרסה",update_done:"התקנת עדכון גרסה",file_cta_shown:"הצגת השורה «פתיחת תיק» בסקירת הרכב",exp_expose:"הצגת נוסח בניסוי",js_error:"שגיאת קוד באתר או באפליקציה",lookup_abort:"בדיקה שבוטלה באמצע",lookup_failed:"בדיקה שנכשלה",lookup_slow:"בדיקה איטית (הופיעה הודעת המתנה)",lookup_timeout:"בדיקה שלא הסתיימה בזמן",app_exception:"קריסה של האפליקציה",newsletter_confirm:"אישור הרשמה למגזין",b2b_lead_submit:"פנייה עסקית מהאתר"};
const AUTO={session_start:"פתיחה (אוטומטי)",user_engagement:"זמן שימוש (אוטומטי)",screen_view:"מעבר מסך באפליקציה (אוטומטי)",page_view:"צפייה בדף (אוטומטי)",first_visit:"כניסה ראשונה לאתר (אוטומטי)",app_remove:"הסרת האפליקציה (אוטומטי)",app_update:"עדכון האפליקציה (אוטומטי)",os_update:"עדכון מערכת בטלפון (אוטומטי)",app_clear_data:"ניקוי נתוני האפליקציה (אוטומטי)",firebase_campaign:"פתיחה מקמפיין (אוטומטי)",notification_receive:"קבלת התראה (אוטומטי)",notification_open:"פתיחת התראה (אוטומטי)",notification_dismiss:"סגירת התראה (אוטומטי)",notification_foreground:"התראה כשהאפליקציה פתוחה (אוטומטי)",screen_view_web:"מעבר מסך (אוטומטי)",scroll:"גלילה בדף (אוטומטי)",click:"לחיצה על קישור יוצא (אוטומטי)",form_start:"התחלת מילוי טופס (אוטומטי)",form_submit:"שליחת טופס (אוטומטי)",file_download:"הורדת קובץ (אוטומטי)",view_search_results:"תוצאות חיפוש באתר (אוטומטי)",video_start:"התחלת וידאו (אוטומטי)",in_app_purchase:"רכישה באפליקציה (אוטומטי)"};
const KIND={source_down:"משרד התחבורה לא ענה",offline:"לא התקבלה תשובה (חיבור או זמן המתנה)",not_found:"מספר שלא קיים (הוקלד לא נכון)",net_err:"החיבור למאגרי משרד התחבורה נכשל",js_err:"תקלה בקוד שלנו בזמן הבדיקה","(not set)":"לא ידוע"};
const FK={data:"נתונים",infra:"תשתית",content:"תוכן",release:"שחרור",experiment:"ניסוי",reviews:"ביקורות"};
const VIA={img:"תמונה",full:"תמונה מלאה",pdf:"PDF",txt:"טקסט",cmp:"השוואה"};
const ST={ok:["תקין","✓"],warn:["דורש תשומת לב","!"],bad:["מתחת ליעד","✕"],early:["מוקדם לשפוט","◷"],nodata:["אין נתון","?"],cal:["בלי יעד עדיין","·"],wait:["ממתין","◷"],ref:["בלי יעד","·"],live:["עכשיו","●"]};
const RANK={bad:0,nodata:1,warn:2};
const RS={draft:["טיוטה בקונסול","wait"],not_sent_for_review:["מוכנה, עוד לא נשלחה לבדיקה","wait"],in_review:["בבדיקה של גוגל","wait"],approved_not_published:["אושרה, מחכה שתפרסם","wait"],not_approved:["נדחתה בבדיקה","bad"],published:["פורסמה","ok"]};
// the bots board: each scheduled workflow's name and group
const BN={"alert-daily.yml":["צלצול הבוקר של ההתראות","ניטור"],"live-watch.yml":["שומר הדשבורד","ניטור"],"web-watch.yml":["שומר האתר היומי","ניטור"],"explore.yml":["הסיור השבועי באפליקציה","ניטור"],"site-smoke.yml":["בדיקת האתר החי","ניטור"],"data-guard.yml":["שומר הנתונים","ניטור"],"data-truth.yml":["בדיקת אמת מול משרד התחבורה","ניטור"],"ministry-watch.yml":["שומר מאגרי משרד התחבורה","ניטור"],"release-watch.yml":["שומר הקריסות אחרי שחרור","ניטור"],"release-guard.yml":["שומר הגרסה החדשה","ניטור"],"app-guardian.yml":["שומר העיצוב באפליקציה","ניטור"],"ui-guardian.yml":["שומר העיצוב","ניטור"],"copy-audit.yml":["בדיקת הנוסח השבועית","ניטור"],"notes-draft.yml":["טיוטת הערות השחרור","פריסה"],"reviews-monitor.yml":["שומר הביקורות","ניטור"],
 "catalog.yml":["קטלוג הדגמים","נתונים"],"fuel.yml":["מחיר הדלק","נתונים"],"market.yml":["נתוני השוק","נתונים"],"models.yml":["שמות הדגמים","נתונים"],"modelstats.yml":["סטטיסטיקת הדגמים","נתונים"],"own-data.yml":["העתק נתוני הבעלות","נתונים"],"settlements.yml":["הסדרי פשרה","נתונים"],"zombie.yml":["גלאי רכבים שחזרו לכביש","נתונים"],
 "seo-data.yml":["צילום נתוני SEO","גוגל"],"seo-daily.yml":["סיכום SEO יומי","גוגל"],"seo-check.yml":["בדיקת SEO","גוגל"],"seo-publish.yml":["פרסום SEO אוטומטי","גוגל"],
 "magazine.yml":["המגזין","תוכן ושיווק"],"social-publish.yml":["הפרסום האוטומטי לפייסבוק ואינסטגרם","תוכן ושיווק"],"camp-data.yml":["צילום נתוני הקמפיינים","תוכן ושיווק"],"competitor-check.yml":["בדיקת המתחרים החודשית","תוכן ושיווק"],"kit-draft.yml":["טיוטת ערכת התוכן השבועית","תוכן ושיווק"],"kit-qa.yml":["הבדיקה הוויזואלית של ערכת התוכן","תוכן ושיווק"],"weekly-analytics.yml":["הדוח השבועי","תוכן ושיווק"],
 "web-deploy.yml":["פריסת האתר","פריסה"],"workers-deploy.yml":["פריסת ה-Workers","פריסה"],"ship-tail.yml":["זנב השחרור (העלאה ל-Alpha)","פריסה"]};
const BD={"copy-audit.yml":"פעם בשבוע: קורא את כל הנוסח בעברית באפליקציה, באתר ובדף החנות, ומסמן ניסוח לא אחיד, הבטחה שלא מתקיימת, פנייה במגדר או שגיאת כתיב. רק מציע, לא משנה כלום.","notes-draft.yml":"כשמכינים גרסה חדשה: כותב טיוטה בעברית להערות השחרור ב-Google Play מתוך השינויים. רק טיוטה, לא נשלחת לבד.","kit-draft.yml":"ביום רביעי בלילה: טיוטה של טקסטי ערכת התוכן השבועית מהעובדות המאומתות.","kit-qa.yml":"אחרי שערכת התוכן נכנסת לתור הפרסום: בדיקה של כל תמונה ופריימים מהסרטון: טקסט חתוך, טעות כתיב, תג חסר או לוחית שאינה לדוגמה.","competitor-check.yml":"פעם בחודש: שינויים אצל אפליקציות ושירותים דומים (מחיר, התראות, גרסה חדשה), רק עם מקור.","app-guardian.yml":"כל לילה: פותח את האפליקציה האמיתית על אנדרואיד 12 ו-15, בכמה גדלי מסך וגופן, ובודק שכל מסך במקום.","ui-guardian.yml":"כל לילה: עובר בדפדפן על כל המסכים באפליקציה ובאתר, בטלפון, בטאבלט ובמחשב, בהיר וכהה.","alert-daily.yml":"סיכום הבוקר בטלגרם: מה קרה בלילה ומה מחכה להחלטה.","live-watch.yml":"בודק כל חצי שעה שהדשבורד הזה עונה, ומעדכן את לוח הבוטים.","web-watch.yml":"פעם ביום: מהירות האתר בטלפון וזמן הטעינה האמיתי, ובדיקה שצינור הנתונים (אנליטיקס מול Cloudflare) תקין.","site-smoke.yml":"פותח את האתר החי בדפדפן אמיתי, בודק רכב ודפים מרכזיים, ועוקב אחרי תוקף האבטחה והדומיין.","data-guard.yml":"משווה כל יום את מבנה מאגרי משרד התחבורה לבסיס שמור, ועוצר בניית גרסה כשמשהו נשבר.","data-truth.yml":"פותח מדגם של כ-40 רכבים באתר כמו משתמש, ומשווה כל לשונית למאגר של משרד התחבורה.","ministry-watch.yml":"פעם ביום: המאגרים של משרד התחבורה שהאפליקציה קוראת זמינים ועודכנו.","release-watch.yml":"72 שעות אחרי שגרסה מגיעה ל-Google Play: קריסות ותקיעות חדשות באותה גרסה.","release-guard.yml":"ביום 1, 3 ו-7 אחרי גרסה חדשה: משווה את השימוש לגרסה הקודמת, לכל 100 בדיקות.","reviews-monitor.yml":"שלוש פעמים ביום: ביקורות חדשות של 1 עד 3 כוכבים וחריגות בקריסות, לטלגרם.",
 "catalog.yml":"בונה את קטלוג הדגמים להשוואה מנתוני משרד התחבורה.","fuel.yml":"מחיר הדלק המפוקח, לחישובי העלות.","market.yml":"נתוני השוק החודשיים ממשרד התחבורה.","models.yml":"שמות הדגמים בעברית, מהרישוי.","modelstats.yml":"סטטיסטיקה לכל דגם, פעם בחודש.","own-data.yml":"העתק יומי של קובץ היסטוריית הבעלות.","settlements.yml":"רשימת הסדרי הפשרה שהאפליקציה קוראת מהאתר, פעם בשבוע.","zombie.yml":"פעם בחודש: רכבים שירדו מהכביש וחזרו.",
 "seo-data.yml":"צילום יומי מ-Search Console: חיפושים, דפים ומצב האינדוקס, והתראה כשמספר הדפים בגוגל יורד.","seo-daily.yml":"סיכום יומי של החיפוש בגוגל לטלגרם, ואזכורים חדשים של luchit.app ברשת.","seo-check.yml":"בדיקות SEO לאתר על כל שינוי.","seo-publish.yml":"מפרסם שינויי SEO שהוכנו מראש, אחרי כיום, כשכל הבדיקות עוברות.",
 "magazine.yml":"כתבת נתונים שבועית (חמישי) וכתבה חודשית (ב-6 בחודש) במגזין.","social-publish.yml":"מפרסם את ערכת התוכן השבועית לעמוד הפייסבוק ולאינסטגרם, לפי התור.","camp-data.yml":"צילום שבועי של מה שכל נושא קמפיין הביא.","weekly-analytics.yml":"הדוח השבועי בטלגרם: 7 הימים האחרונים, חריגות והמגמה.","explore.yml":"פעם בשבוע: שימוש באפליקציה ובאתר כמו אדם סקרן, עם לוחיות לדוגמה בלבד, ורישום מה נראה שבור או מבלבל.",
 "web-deploy.yml":"בונה את האתר לפרסום.","workers-deploy.yml":"אחרי כל שינוי ב-main: מעלה את השרתים (הדשבורד, ההתראות והקישורים).","ship-tail.yml":"אחרי בניית גרסה: מעלה אותה ל-Alpha, מסנכרן את אנליטיקס ושולח הודעה אחת."};
// which department each bot reports to (by file first, then by its group)
const BDEPT={"data-guard.yml":"data","data-truth.yml":"data","ministry-watch.yml":"data","weekly-analytics.yml":"data","release-watch.yml":"release","release-guard.yml":"release","reviews-monitor.yml":"release","notes-draft.yml":"release","app-guardian.yml":"release","ui-guardian.yml":"release","copy-audit.yml":"release","explore.yml":"release","site-smoke.yml":"release"};
const GDEPT={"ניטור":"ops","נתונים":"data","גוגל":"seo","תוכן ושיווק":"marketing","פריסה":"ops","אחר":"ops"};
const FDEPT={data:"data",infra:"ops",content:"marketing",release:"release",experiment:"release",reviews:"release"};
const every=p=>!p?"אחרי כל שחרור":p<=15?"כל רבע שעה":p<=30?"כל חצי שעה":p<=60?"כל שעה":p<=13*60?"כמה פעמים ביום":p<=1500?"פעם ביום":p<=10600?"פעם בשבוע":"פעם בחודש";
// off / failed / unread / never / skipped / cancelled / running now (the board is written by the run in progress, so its own time is the previous run's) / late / ok
const bst=o=>o.s==="off"?["warn","כבוי"]:o.c==="failure"||o.c==="timed_out"?["bad","נכשל"]:o.c==="unread"?["nodata","לא נקרא"]:o.c==="none"?["early","עוד לא רץ"]:o.c==="skipped"?["early","דילג, לא היה צורך"]:o.c==="cancelled"?["warn","בוטל"]:o.run?["ok","רץ עכשיו"]:o.p&&o.t&&Date.now()-Date.parse(o.t)>(o.p+Math.max(90,o.p*.25))*60e3?["warn","באיחור"]:["ok","תקין"];

const $=i=>document.getElementById(i);
const n=x=>x==null||!isFinite(x)?"-":Math.round(x).toLocaleString("en-US");
const n1=x=>x==null||!isFinite(x)?"-":(Math.round(x*10)/10).toLocaleString("en-US");
const pc=x=>x==null||!isFinite(x)?"-":n1(x)+"%";
const esc=t=>String(t==null?"":t).replace(/[<>&"]/g,"");
const TOUT=/abort|timed? ?out/i,whyT=w=>TOUT.test(w||"")?"לא ענה בזמן. ייבדק שוב בעוד כמה דקות":(w||"");
const dm=s=>{const p=String(s).slice(0,10).split("-");return Number(p[2])+"."+Number(p[1])};
const rng=w=>w?dm(w[0])+" עד "+dm(w[1]):"";
const addD=(d,k)=>new Date(Date.parse(d+"T12:00:00Z")+k*864e5).toISOString().slice(0,10);
const between=(a,b)=>Math.round((Date.parse(b+"T12:00:00Z")-Date.parse(a+"T12:00:00Z"))/864e5);
const today=()=>new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Jerusalem"});
const chip=(s,w)=>'<span class="chip s-'+s+'"><i aria-hidden="true">'+ST[s][1]+'</i>'+(w||ST[s][0])+'</span>';
const dot=s=>'<span class="s-'+s+'" title="'+ST[s][0]+'"></span>';
const pois=(a,lam)=>{let t=Math.exp(-lam),s=t;for(let k=1;k<=a;k++){t*=lam/k;s+=t}return s};
const mEnd=m=>addD((Number(m.slice(5))===12?(Number(m.slice(0,4))+1)+"-01":m.slice(0,5)+String(Number(m.slice(5))+1).padStart(2,"0"))+"-01",-1);
const MONTHS=GOALS.k.weekly_checks.map((x,i)=>{const y=2026+Math.floor((10+i)/12),mo=(10+i)%12+1;return y+"-"+String(mo).padStart(2,"0")});
function goal(key,day,r){const k=GOALS.k[key];if(!k||!day)return null;const pts=MONTHS.map((m,i)=>[mEnd(m),k[i]]),f=GOALS.from[key];if(f)pts.unshift([f[0],[f[1],f[1],f[1]]]);
 let v=pts[0][1];if(day>=pts[pts.length-1][0])v=pts[pts.length-1][1];else for(let i=0;i+1<pts.length;i++)if(day>=pts[i][0]&&day<pts[i+1][0]){const t=between(pts[i][0],day)/between(pts[i][0],pts[i+1][0]);v=pts[i][1].map((a,j)=>a+(pts[i+1][1][j]-a)*t);break}
 return v.map(x=>x*(r||1))}
function calib(key,actual){const C=GOALS.calib;return actual==null||C.keys.indexOf(key)<0?null:Math.min(C.hi,Math.max(C.lo,actual/goal(key,C.end)[1]))}
// at or above base ok, cons to base warn, below cons bad; small counts only bad when it cannot be bad luck; lower=true flips it (failures)
function band(a,g,lower,small){if(a==null)return "nodata";if(!g)return "early";const c=g[0],b=g[1];if(lower)return a<=b?"ok":a<=c?"warn":"bad";if(a>=b)return "ok";if(a>=c)return "warn";if(small&&c<20&&pois(a,c)>=.05)return "warn";return "bad"}
const gtxt=g=>g?"היעד "+n1(g[1])+" (טווח "+n1(g[0])+" עד "+n1(g[2])+")":"";
const MN=["ינואר","פברואר","מרץ","אפריל","מאי","יוני","יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];
const mname=(m,y)=>MN[Number(m.slice(5,7))-1]+(y?" "+m.slice(0,4):"");
const gtxtN=(key,g,day)=>{if(!g)return "";if(g[1]>=1)return "היעד "+n(g[1])+" (טווח "+n(g[0])+" עד "+n(g[2])+")";const m=MONTHS.find(x=>mEnd(x)>=day)||MONTHS[0];return "היעד לסוף "+mname(m)+": "+n(goal(key,mEnd(m))[1])+" בשבוע"};
const hm=ts=>{if(!ts)return "";const o={timeZone:"Asia/Jerusalem"},t=new Date(ts),day=t.toLocaleDateString("en-CA",o);return (day!==today()?dm(day)+" ":"")+t.toLocaleTimeString("he-IL",{...o,hour:"2-digit",minute:"2-digit"})};
const delta=(a,b,what)=>{if(a==null||b==null)return "";const d=Math.round(a-b),w=what||"מהשבוע הקודם";return d>0?'<span class="up">▲ '+n(d)+'</span> יותר '+w:d<0?'<span class="down">▼ '+n(-d)+'</span> פחות '+w:'<span class="flat">כמו '+(what?what.replace(/^מ/,"ב"):"בשבוע הקודם")+'</span>'};
const delta1=(a,b)=>{if(a==null||b==null)return "";return a>b+.05?'<span class="up">▲ '+n1(a-b)+'</span> יותר מהשבוע הקודם ('+n1(b)+')':a<b-.05?'<span class="down">▼ '+n1(b-a)+'</span> פחות מהשבוע הקודם ('+n1(b)+')':'<span class="flat">כמו בשבוע הקודם</span>'};
const pcd=(a,b)=>a==null||b==null?"-":!b?(a?"חדש":"-"):a===b?'<span class="flat">0%</span>':a>b?'<span class="up">▲ '+n((a-b)/b*100)+"%</span>":'<span class="down">▼ '+n((b-a)/b*100)+"%</span>";
const PGN=[[/^\/$/,"דף הבית: בדיקת רכב"],[/^\/magazine\//,"מגזין"],[/^\/model\/$/,"כל הדגמים"],[/^\/model\//,"דף דגם"],[/^\/check\/$/,"כל הבדיקות"],[/^\/check\/recall\//,"בדיקת ריקול"],[/^\/check\/settlements\//,"הסדרי פשרה"],[/^\/check\/license-fee\//,"אגרת רישוי"],[/^\/check\/owners\//,"כמה ידיים היו לרכב"],[/^\/check\/test\//,"מתי הטסט"],[/^\/check\/off-road\//,"רכב שירד מהכביש"],[/^\/check\/value\//,"שווי רכב"],[/^\/business\//,"לעסקים"],[/^\/guide\//,"מדריך"],[/^\/go(\/|$)/,"קישור מרשת חברתית"]];
const PG=u=>{const p=String(u||"/").replace(/^https?:\/\/[^/]+/,"").replace(/[?#].*$/,"")||"/",m=PGN.find(x=>x[0].test(p));return (m?m[1]:"דף אחר")+' <small><bdi dir="ltr">'+esc(p)+"</bdi></small>"};
const SL={google:"חיפוש בגוגל",search:"מנועי חיפוש אחרים",direct:"בלי מקור מזוהה (הקלדה, או קישור בלי סימון)",site:"מדף אחר באתר (דגמים, מגזין)",unknown:"לפני 20.10, כשהמקור עוד לא נמדד",app:"באפליקציה (בלי פירוט מקור)",share:"קישור לדוח רכב או להשוואה ששותפו",tiktok:"טיקטוק",instagram:"אינסטגרם",facebook:"פייסבוק",linkedin:"לינקדאין",youtube:"יוטיוב",whatsapp:"וואטסאפ",newsletter:"ניוזלטר",press:"כתבות",dealer:"סוחרים",qr:"QR ודפוס",other:"אתרים ואפליקציות אחרים",store:"חיפוש ב-Google Play",fromsite:"דרך האתר (כפתור ההורדה)",nolink:"בלי מקור מזוהה (הקלדה, או קישור בלי סימון)"};
const TOP={bio:"קישור בביו",post:"פוסט",message:"הודעה",magazine:"גיליון המגזין",article:"כתבה",qr:"קוד QR",dealer:"סוחר",market:"פוסט על השוק",offroad:"פוסט על רכבים שירדו מהכביש",one_line:"פוסט בשורה אחת",fb_group:"קבוצת פייסבוק",fb_groups:"קבוצות פייסבוק",friend_post:"פוסט של חבר",personal_post:"פוסט אישי"};
// small building blocks of markup
const kv=(l,v,sub)=>"<li><span>"+l+(sub?"<small>"+sub+"</small>":"")+"</span><b>"+v+"</b></li>";
const tbl=(heads,rows,cls)=>rows.length?'<div class="tw"><table class="t'+(cls?" "+cls:"")+'"><thead><tr>'+heads.map((h,i)=>"<th"+(i?' class="n"':"")+">"+h+"</th>").join("")+"</tr></thead><tbody>"+rows.map(r=>'<tr><td class="w">'+r[0]+"</td>"+r.slice(1).map(x=>'<td class="n">'+x+"</td>").join("")+"</tr>").join("")+"</tbody></table></div>":'<p class="note">אין נתונים</p>';
const note=t=>t?'<p class="note">'+t+"</p>":"";
// a column chart of a few weeks: the app below, the site above, a goal line where there is one; the last column is the window shown
function bars(cols,opts){const o=opts||{},H=o.h||(o.sm?92:140),mx=Math.max(1e-9,...cols.map(c=>Math.max(c.v||0,c.g||0))),k=cols.length;if(!k)return "";
 return '<div class="bars'+(o.sm?" sm":"")+'" style="height:'+(H+20)+'px" role="img" aria-label="'+esc(cols.map(c=>c.l+": "+n(c.v)).join(", "))+'">'+cols.map((c,i)=>{const v=c.v||0,s=Math.min(v,c.s||0),a=v-s,ha=a?Math.max(2,a/mx*H):0,hs=s?Math.max(2,s/mx*H):0;
 return '<div class="b'+(i===k-1?" cur":"")+'"><span class="v">'+(o.fmt||n)(c.v)+'</span>'+(hs?'<i class="w" style="height:'+hs+'px" title="באתר '+n(s)+'"></i>':"")+(ha?'<i class="'+(hs?"a":"one a")+'" style="height:'+ha+'px" title="באפליקציה '+n(a)+'"></i>':"")+(!ha&&!hs?'<i class="one" style="height:2px;background:var(--prev)"></i>':"")+(c.g?'<i class="g" style="bottom:'+(c.g/mx*H)+'px" title="היעד '+n(c.g)+'"></i>':"")+'<span class="l">'+esc(c.l)+"</span></div>"}).join("")+'</div><div class="ax"></div>'}
// day by day bars, 28 days, as a small svg
function spark(vals,labels,fmt){const v=vals.map(x=>x==null||!isFinite(x)?0:x),mx=Math.max(1e-9,...v),k=v.length,sw=280/k,bw=Math.max(2,sw*.7);if(!k)return "";
 return '<svg class="spark" viewBox="0 0 280 50" preserveAspectRatio="none" direction="ltr" style="direction:ltr" role="img" aria-label="'+esc(labels.map((l,i)=>l+": "+(fmt||n)(vals[i])).join(", "))+'">'+v.map((x,i)=>{if(!x)return "";const h=Math.max(2,x/mx*46);return '<rect x="'+(i*sw+(sw-bw)/2)+'" y="'+(48-h)+'" width="'+bw+'" height="'+h+'" rx="1.5"><title>'+esc(labels[i])+": "+(fmt||n)(vals[i])+"</title></rect>"}).join("")+'</svg><div class="axis"><span>'+esc(labels[0])+"</span><span>"+esc(labels[k-1])+"</span></div>"}

// the organisation: three divisions, six departments. A metric, a task, a bot and an alert each belong to one department
const DIVS={growth:{name:"אגף צמיחה",short:"צמיחה",depts:["marketing","seo"],what:"חשיפה, נחיתות באתר, בדיקות והתקנות: כל מה שמביא אנשים חדשים"},product:{name:"אגף מוצר ומערכת",short:"מוצר ומערכת",depts:["release","data","ops"],what:"בדיקה, שמירה, חזרה, שיתוף ודירוג: כל מה שקורה אחרי שהגיעו, והמערכת שמאחור"},business:{name:"אגף עסקים",short:"עסקים",depts:["strategy"],what:"הדרך למנוי PRO, פניות עסקיות ונרשמים"}};
const DEPTS={marketing:{name:"שיווק ותוכן",div:"growth",owners:["שיווק","תוכן","קמפיין"],metrics:["installs","visits","campChecks","shares","organic"]},seo:{name:"SEO",div:"growth",owners:["SEO","סאו"],metrics:["google","impressions","pages","googleChecks"]},release:{name:"מוצר ושחרורים",div:"product",owners:["מוצר","שחרור","QA"],metrics:["store","rating","crashes","saves","return7","shareOpen"]},data:{name:"נתונים ואמינות",div:"product",owners:["נתונים","מדידה","אמינות"],metrics:["health","slow","siteChecks","checksApp"]},ops:{name:"תפעול ובוטים",div:"product",owners:["תפעול","בוטים","ארכיטקטורה"],metrics:["bots","alerts24","auto"]},strategy:{name:"אסטרטגיה ועסקים",div:"business",owners:["אסטרטגיה","עסקים"],metrics:["active28","subs","leads","installedNow"]}};
const CEO_TILES=["installs","shares","google","return7","health","rating"];
const ownerDept=s=>{const t=String(s||"");for(const k in DEPTS)if(DEPTS[k].owners.some(o=>t.indexOf(o)>=0))return k;return null};
const botDept=(f,g)=>BDEPT[f]||GDEPT[g]||"ops";
const WIN={week:"שבוע",m28:"28 ימים",today:"היום"};

// everything the metrics share, computed once per answer
function ctx(d){
const C={d};
const W=C.W=d.weekly||null,ev=C.ev=W&&W.ev,E0=C.E0=ev?ev[0]:{},E1=C.E1=ev?ev[1]:{},E2=C.E2=ev?ev[2]:{};
const ge=C.ge=(o,k,i)=>o&&o[k]?o[k][i||0]:0;
const end=C.end=W?W.end:null,cal=C.cal=!end||end<CAL_END,days=C.days=W&&W.days;
const week=C.week=e=>{if(!days)return null;let s=0;for(let i=0;i<7;i++)s+=days[addD(e,-i)]||0;return s};
const SR=C.SR=W&&W.series,wsum=C.wsum=(k,e,len)=>{const o=SR&&SR[k];if(!o)return null;let s=0;for(let i=0;i<(len||7);i++)s+=o[addD(e,-i)]||0;return s};
const CB=C.CB=GOALS.calib,base=C.base=end>=CB.end,cw=C.cw=days&&base?week(CB.end):null,ci=C.ci=base?wsum("first_open",CB.end):null;
const RC=C.RC=cw!=null?calib("weekly_checks",cw):1,RI=C.RI=base?calib("installs_week",ci):1;C.RCAL={weekly_checks:RC,installs_week:RI};
C.nsGoal=e=>!days||e<CAL_END?null:goal("weekly_checks",e,RC);C.nsTarget=e=>{const g=C.nsGoal(e);return g?g[1]:null};
const ENDS=C.ENDS=[];if(end&&days){for(let i=7;i>=0;i--)ENDS.push(addD(end,-7*i));while(ENDS.length>2&&!week(ENDS[0]))ENDS.shift()}
C.wl=e=>"עד "+dm(e);C.td=today();C.yd=addD(C.td,-1);
C.D28=[];if(end)for(let i=27;i>=0;i--)C.D28.push(addD(end,-i));
C.mix=W&&W.W&&addD(W.W[0],-7)<SITE_FROM;   // the previous week began before the site was counted
// the bots board
const BO=C.BO=d.metrics&&d.metrics.bots;C.BL=BO?BO.list.map(o=>Object.assign({},o,{st:bst(o),he:(BN[o.f]||[o.he||o.n,"אחר"])[0],gr:(BN[o.f]||[o.n,"אחר"])[1],dept:botDept(o.f,(BN[o.f]||[0,"אחר"])[1])})):null;
// Google Play: the public store page says whether anyone can install; Play Console, when connected, where the production release stands
const RL=C.RL=d.release&&d.release.ok?d.release:null,top=C.top=RL&&RL.list&&RL.list[0]||null;
const PS=C.PS=d.stats&&d.stats.ok&&d.stats.cur?d.stats:null;
const RU={draft:"עדכון בטיוטה",not_sent_for_review:"עדכון שעוד לא נשלח לבדיקה",in_review:"עדכון בבדיקה",approved_not_published:"עדכון שאושר ומחכה שתפרסם",not_approved:"עדכון שנדחה בבדיקה"};
C.GP=d.play==="live"?{s:top&&top.state==="not_approved"?"bad":"ok",txt:"באוויר בחנות"+(top&&RU[top.state]?" · "+RU[top.state]:"")}:top?{s:(RS[top.state]||[0,"wait"])[1],txt:(RS[top.state]||[top.state?"מצב "+esc(top.state):"מצב לא ידוע"])[0]}:RL?{s:"wait",txt:"עוד אין גרסה בחנות"}:d.play==="review"?{s:"wait",txt:"עדיין לא פתוח לכולם"}:{s:"wait",txt:"לא הצלחתי לבדוק את דף החנות"};
C.live=d.play==="live";
// installed now: Play's devices on the last day its reports reached, plus first opens minus removals in Analytics since (as the old page)
{const LF=d.daily&&d.daily.life,td0=C.td,rf=(d.events||[]).find(e=>e[0]==="first_open"),rtf=d.rtToday?d.rtToday.first_open:rf?rf[1]:0,pa=PS&&PS.active!=null?PS.activeDay:"";
 let inst=null,instHow="",instMin=false;
 if(LF){const yd0=C.yd,rty=d.rtYday?d.rtYday.first_open||0:0;let fo=LF[td0]?0:rtf,rm=0;instMin=rtf>(LF[td0]?LF[td0][0]:0);if(yd0>pa&&!LF[yd0])fo+=rty;for(const k in LF){const v=LF[k];if(k>pa){fo+=k===td0?Math.max(v[0],rtf):k===yd0?Math.max(v[0],rty):v[0];rm+=v[1]}}
  inst=(pa?PS.active:0)+fo-rm;instHow=(pa?n(PS.active)+" מכשירים לפי Google Play ב-"+dm(pa)+", ועוד ":"")+n(fo)+" התקנות חדשות פחות "+n(rm)+" הסרות "+(pa?"מאז":"מ-1.10")+", לפי גוגל אנליטיקס"+(instMin?". ההתקנות של היום נספרות בינתיים בזמן אמת, כל 10 דקות, עד שגוגל אנליטיקס יעבד את היום":"")}
 else if(pa){inst=PS.active;instHow="לפי Google Play ב-"+dm(pa)}
 const tdv=LF&&LF[td0]?LF[td0][0]:null;C.inst=inst;C.instHow=instHow;C.instMin=instMin;C.instToday=tdv==null?rtf:Math.max(tdv,rtf);C.instTodayMin=tdv==null||rtf>tdv}
// today so far and the last 30 minutes (Analytics' day lags hours; realtime counts only while this screen is open: a minimum)
{const Ed=d.daily&&d.daily.events,T=C.T=Ed&&Ed.today||{},Y=C.Y=Ed&&Ed.yesterday||{},rt=d.events||[],g=C.rt=k=>(rt.find(e=>e[0]===k)||[0,0])[1];C.Ed=!!Ed;
 C.sofar=k=>{const t=Ed&&T[k]?T[k][0]:Ed?0:null,r=d.rtToday&&d.rtToday[k]!=null?d.rtToday[k]:d.events?g(k):0;return t==null?(d.rtToday||d.events?r:null):Math.max(t,r)};
 C.yfull=k=>Ed?Math.max(Y[k]?Y[k][0]:0,d.rtYday&&d.rtYday[k]||0):null;
 C.ck=C.sofar("car_lookup")}
// marks: done tasks and answered decisions, with what was pressed on this screen before the server's copy caught up
C.done=Object.assign({},d.calDone||{});for(const k in calLocal){if(calLocal[k])C.done[k]=calLocal[k];else delete C.done[k]}
C.acts=Object.assign({},d.acts||{});for(const k in actLocal){if(actLocal[k])C.acts[k]=actLocal[k];else delete C.acts[k]}
C.R={};C.att=[];C.M={};
return C}
const calLocal={},actLocal={};
// a metric's result for the answer, computed once
function M(C,id){if(C.R[id])return C.R[id];const m=REG[id];if(!m)return null;let r;try{r=m.calc(C)||{}}catch(e){r={s:"nodata",big:"-",lines:["החישוב נכשל: "+esc(e&&e.message||e)]}}
 r.id=id;r.name=m.name;r.m=m;if(!r.s)r.s="ref";if(r.big==null)r.big="-";if(!r.lines)r.lines=[];r.lines=r.lines.filter(Boolean);C.R[id]=r;C.M[id]=r.s;
 if(r.att&&RANK[r.s]!=null)C.att.push({key:id,s:r.s,prio:r.att.prio,ratio:r.att.ratio==null?1:r.att.ratio,text:r.att.text,short:r.att.short,w:r.att.w});return r}

// the registry: every number on the screen is one of these, with its definition, how it is computed, its source, its owner and its status rule.
// calc(C) returns {s, w, big, unit, dl, gl, gp, gn, lines, win, foot, chart, att, m28, today, drill}
const REG={};
REG.checks={name:"בדיקות רכב בשבוע",dept:null,def:"כמה בדיקות רכב נעשו באפליקציה ובאתר יחד בשבוע שהסתיים אתמול. זה המדד הראשי של לוחית.",how:"גוגל אנליטיקס, האירוע car_lookup, אפליקציה ואתר, 7 ימים עד אתמול (היום לא נספר, כי גוגל מסיים לספור אותו רק למחרת). האתר נספר מ-15.10. היעד: תוכנית השיווק כפול היחס של שבוע הבסיס 26.10 עד 1.11.",src:"גוגל אנליטיקס",owner:"מדידה",
 calc(C){const ev=C.ev,E0=C.E0,E1=C.E1,E2=C.E2,end=C.end,cal=C.cal,W=C.W,ge=C.ge,wsum=C.wsum,week=C.week,CB=C.CB;const L=ev?ge(E0,"car_lookup"):null,Lp=ev?ge(E1,"car_lookup"):null,G=end?C.nsGoal(end):null,tg=G?G[1]:null;let s;
  const BS=W&&W.bySource,La=BS&&BS[0].app?BS[0].app[1]:null,Lpa=BS&&BS[1].app?BS[1].app[1]:null,app1=C.mix&&La!=null&&Lpa!=null;
  if(!ev)s="nodata";else if(cal)s="cal";else{s=band(L,G,false,true);if(s==="ok"&&(app1?Lpa>=30&&La<.8*Lpa:Lp>=30&&L<.8*Lp))s="warn"}
  const site=wsum("site_lookup",end),wk=week(end),app=site!=null&&wk!=null?Math.max(0,wk-site):null,SV=W&&W.savers;
  const l1=!ev?"גוגל אנליטיקס לא ענה":tg?n(L/tg*100)+"% מהיעד ("+n(tg)+", טווח "+n(G[0])+" עד "+n(G[2])+")":"שבוע הבסיס הוא "+rng([addD(CB.end,-6),CB.end])+", ולפיו ייקבע היעד";
  const dl=!C.mix?delta(L,Lp):app1?"באפליקציה: "+delta(La,Lpa)+". את האתר עוד אי אפשר להשוות, הוא נספר מ-"+dm(SITE_FROM):"";
  const chart=C.ENDS.length?bars(C.ENDS.map(e=>({l:dm(e),v:week(e),s:Math.min(wsum("site_lookup",e)||0,week(e)||0),g:C.nsTarget(e)}))):"";
  const s28=C.SR?wsum("site_lookup",end,28):null,a28=ge(E2,"car_lookup");
  const by=BS?Object.keys(BS[0]).filter(k=>(BS[0][k]||[0,0])[1]||(BS[1][k]||[0,0])[1]).sort((a,b)=>(a==="app"?-1:b==="app"?1:0)||((BS[0][b]||[0,0])[1]-(BS[0][a]||[0,0])[1])):[],tc=by.reduce((a,k)=>a+(BS[0][k]||[0,0])[1],0),pSite=W&&W.W&&addD(W.W[0],-7)>=SITE_FROM,seen=W&&W.srcSeen||[true,true];
  const pv=k=>k==="app"?(BS[1][k]||[0,0])[1]:!pSite||(k!=="unknown"&&!seen[1])?null:(BS[1][k]||[0,0])[1];
  return {s,v:L,L,Lp,tg,big:n(L),dl,gl:tg?n(L/tg*100)+"% מהיעד השבועי ("+n(tg)+")":"",gp:tg?L/tg:0,gn:!tg&&ev?"היעד השבועי ייקבע לפי שבוע הבסיס, "+rng([addD(CB.end,-6),CB.end]):"",
   lines:[l1,app!=null?"באפליקציה <b>"+n(app)+"</b>"+(SV&&SV.car_lookup?" (מ-"+n(SV.car_lookup)+" מכשירים)":"")+", באתר <b>"+n(site)+"</b>":""],win:rng(W&&W.W),foot:"אפליקציה ואתר",chart,
   att:{prio:1,ratio:tg?L/tg:1,text:"בדיקות רכב: "+n(L)+(tg?", היעד "+n(tg):""),short:s==="nodata"?"חסר נתון מגוגל אנליטיקס":"הבדיקות מתחת ליעד"},
   m28:ev?{big:n(a28),lines:[n1(a28/28)+" ביום בממוצע",s28!=null?"באפליקציה "+n(Math.max(0,(wsum("car_lookup",end,28)||0)-s28))+", באתר "+n(s28):""],win:rng(W.M)}:null,
   today:C.ck!=null?{big:n(C.ck),lines:["אתמול, יום שלם: <b>"+n(C.yfull("car_lookup"))+"</b>","30 הדקות האחרונות: <b>"+n(C.rt("car_lookup"))+"</b>","גוגל אנליטיקס מוסר את היום באיחור של כמה שעות; עד אז הספירה בזמן אמת, כל 10 דקות"]}:null,
   drill:[BS?{h:"לפי מקור ("+rng(W.W)+")",html:tbl(["מקור","בדיקות","חלק","שבוע קודם"],by.map(k=>{const a=BS[0][k]||[0,0];return [k==="app"?"באפליקציה":"באתר: "+esc(SL[k]||k),n(a[1]),tc?Math.round(a[1]*100/tc)+"%":"-",n(pv(k))]}).concat([["<b>סך הכול</b>","<b>"+n(tc)+"</b>","",n(pSite?by.reduce((a,k)=>a+(BS[1][k]||[0,0])[1],0):null)]]))+note("באפליקציה אין מקור לכל פתיחה, ולכן היא שורה אחת. האתר מוסר מקור מ-20.10.")}:null,
    C.SR&&C.SR.car_lookup&&end?{h:"יום אחרי יום, 28 ימים",html:spark(C.D28.map(x=>C.SR.car_lookup[x]||0),C.D28.map(dm))}:null]}}};
REG.installs={name:"התקנות חדשות בשבוע",dept:"marketing",def:"כמה מכשירים בישראל פתחו את האפליקציה בפעם הראשונה בשבוע (התקנה חדשה).",how:"גוגל אנליטיקס, משתמשים חדשים בישראל, 7 ימים עד אתמול. היעד: תוכנית השיווק כפול היחס של שבוע הבסיס. עדכון גרסה לא נספר; התקנה מחדש כן.",src:"גוגל אנליטיקס, Google Play",owner:"שיווק",
 calc(C){const W=C.W,A=W&&W.app,a=A?A[0].newUsers:null,ap=A?A[1].newUsers:null,live=C.live,end=C.end,cal=C.cal,GI=C.RI==null?null:goal("installs_week",end,C.RI),tg=live&&!cal&&GI?GI[1]:null,GP=C.GP,PS=C.PS;let s;
  if(a==null)s="nodata";else if(!live)s="early";else if(cal)s="cal";else s=band(a,GI,false,true);
  const AS=W&&W.appSrc,fam=k=>{const i=k.indexOf("|");return /^fbg_[a-z]{1,20}$/.test(k.slice(i+1))?k.slice(0,i)+"|fb_groups":k},camp=AS&&AS[0].camp?Object.entries(AS[0].camp).reduce((m,e)=>{const k=fam(e[0]);m[k]=(m[k]||0)+e[1];return m},{}):null;
  const tl=t=>TOP[t]||(/^fb_group_/.test(t)?"קבוצה: "+'<bdi dir="ltr">'+esc(t.slice(9))+"</bdi>":'<bdi dir="ltr">'+esc(t)+"</bdi>"),nm2=k=>{const i=k.indexOf("|");return esc(SL[k.slice(0,i)]||k.slice(0,i))+" · "+tl(k.slice(i+1))};
  return {s,v:a,big:n(a),dl:delta(a,ap),gl:tg?n(a/tg*100)+"% מהיעד השבועי ("+n(tg)+")":"",gp:tg?a/tg:0,gn:!live?"עד שהאפליקציה בחנות, מתקינים רק בודקים":GP.s!=="ok"||GP.txt.indexOf("·")>=0?"Google Play: "+GP.txt:"",
   lines:[tg?"היעד "+n(tg)+" (טווח "+n(GI[0])+" עד "+n(GI[2])+")":"",C.instToday!=null?"היום עד עכשיו: <b>"+(C.instTodayMin&&C.instToday>0?"לפחות ":"")+n(C.instToday)+"</b> (לא נכלל בשבוע)":"",C.inst!=null?"מותקנת עכשיו: <b>"+(C.instMin?"לפחות ":"בערך ")+n(C.inst)+"</b> מכשירים בישראל":""],win:rng(W&&W.W),foot:"פתיחה ראשונה של האפליקציה בישראל",
   chart:C.ENDS.length?bars(C.ENDS.map(e=>({l:dm(e),v:C.wsum("first_open",e)}))):"",
   att:{prio:5,ratio:tg?a/tg:1,text:"התקנות חדשות: "+n(a)+(tg?", היעד "+n(tg):""),short:s==="nodata"?"חסר נתון על התקנות":"מעט התקנות"},
   m28:A?{big:n(A[2].newUsers),lines:[n1(A[2].newUsers/28)+" ביום בממוצע",'משתמשים בחו"ל, לא נספרים: '+n(A[2].abroadNew)],win:rng(W.M)}:null,
   today:C.instToday!=null?{big:(C.instTodayMin&&C.instToday>0?"לפחות ":"")+n(C.instToday),lines:["אתמול, יום שלם: <b>"+n(C.yfull("first_open"))+"</b>","30 הדקות האחרונות: <b>"+n(C.rt("first_open"))+"</b>"]}:null,
   drill:[AS?{h:"מאיפה הגיעו ההתקנות ("+rng(W.W)+")",html:'<ul class="kv">'+kv("מצאו את האפליקציה בחנות",n(AS[0].store)+' <small class="flat">(שבוע קודם '+n(AS[1].store)+")</small>","Google Play, חיפוש ודפדוף בחנות")+kv("כל ההתקנות בישראל",n(AS[0].all))+"</ul>"+(camp&&Object.keys(camp).length?tbl(["קישור ונושא","התקינו"],Object.entries(camp).filter(e=>e[1]).sort((a,b)=>b[1]-a[1]).slice(0,10).map(e=>[nm2(e[0]),n(e[1])])):"")}:null,
    PS?{h:"לפי Google Play: המספרים המדויקים, עד "+dm(PS.last),html:'<ul class="kv">'+(PS.active!=null?kv("מכשירים בישראל שהאפליקציה מותקנת בהם, ב-"+dm(PS.activeDay),n(PS.active)):"")+kv("התקנות חדשות, "+rng(PS.W),n(PS.cur.users)+' <small class="flat">(שבוע קודם '+n(PS.prev.users)+")</small>")+kv("הסרות, "+rng(PS.W),n(PS.cur.uninstalls)+' <small class="flat">(שבוע קודם '+n(PS.prev.uninstalls)+")</small>")+(PS.store&&(PS.cur.visitors||PS.prev.visitors)?kv("ביקרו בדף האפליקציה בחנות",n(PS.cur.visitors)+' <small class="flat">(שבוע קודם '+n(PS.prev.visitors)+")</small>"):"")+"</ul>"+note("Google Play סופר כל מי שהתקין, גם אם עוד לא פתח, ומוסר את המספרים באיחור של כמה ימים.")}:null]}}};
REG.shares={name:"שיתופים לכל 100 בדיקות",dept:"marketing",def:"כמה שיתופים (דוח רכב או השוואה) היו על כל 100 בדיקות. אם אנשים מעבירים הלאה, לוחית צומחת בלי פרסום.",how:"גוגל אנליטיקס: האירוע share חלקי car_lookup, כפול 100. נספר מהשבוע כשיש בו 100 בדיקות, אחרת מ-28 ימים. היעד מתוכנית השיווק.",src:"גוגל אנליטיקס",owner:"שיווק",
 calc(C){const ev=C.ev,E0=C.E0,E1=C.E1,E2=C.E2,W=C.W,ge=C.ge,cal=C.cal,GS=goal("share_per_100",C.end||C.td),Lw=ge(E0,"car_lookup"),Sw=ge(E0,"share"),Lm=ge(E2,"car_lookup"),Sm=ge(E2,"share"),sh=W&&W.shared;let rate=null,win="",s;
  if(!ev)s="nodata";else{if(Lw>=100){rate=Sw/Lw*100;win=rng(W.W)}else if(Lm>=100){rate=Sm/Lm*100;win=rng(W.M)+" (28 ימים, עד שיש 100 בדיקות בשבוע)"}
   if(rate==null)s="early";else if(cal)s="cal";else s=band(rate,GS,false,false)}
  const arr=sh?sh[0].web+sh[0].app:null,arrp=sh?sh[1].web+sh[1].app:null,Lp1=ge(E1,"car_lookup"),rp=Lp1>=100?ge(E1,"share")/Lp1*100:null;
  const rw=C.ENDS.map(e=>{const l=C.wsum("car_lookup",e),x=C.wsum("share",e);return l>=30&&x!=null?x/l*100:null});
  return {s,v:rate,big:!ev?"-":rate!=null?(rate>=10?n(rate):n1(rate)):n(Sw),unit:!ev||rate!=null?"":"שיתופים",dl:delta1(rate,rp),gl:rate!=null&&!cal?n(rate/GS[1]*100)+"% מהיעד ("+n1(GS[1])+")":"",gp:rate!=null?rate/GS[1]:0,gn:rate==null&&ev?"עוד מעט מדי בדיקות כדי לחשב: "+n(Sw)+" שיתופים מתוך "+n(Lw)+" בדיקות":rate!=null&&cal?"היעד "+n1(GS[1])+" לכל 100 בדיקות":"",
   lines:[!ev?"גוגל אנליטיקס לא ענה":rate!=null?gtxt(GS):"","השבוע: <b>"+n(Sw)+"</b> שיתופים על "+n(Lw)+" בדיקות",sh?"נכנסו מקישור ששותף: <b>"+n(arr)+"</b>"+(arrp!=null?" (שבוע קודם "+n(arrp)+")":""):"",sh&&sh[0].inst?"התקינו את האפליקציה מקישור ששותף: <b>"+n(sh[0].inst)+"</b>":""],win:win||rng(W&&W.W),foot:"אפליקציה ואתר",
   chart:C.ENDS.length?bars(C.ENDS.map((e,i)=>({l:dm(e),v:rw[i]})),{fmt:n1}):"",
   att:{prio:4,ratio:rate!=null?rate/GS[1]:1,text:"שיתופים: "+n1(rate)+" לכל 100 בדיקות, היעד "+n1(GS[1]),short:s==="nodata"?"חסר נתון על שיתופים":"מעט שיתופים"},
   m28:ev?{big:Lm>=100?n1(Sm/Lm*100):n(Sm),unit:Lm>=100?"":"שיתופים",lines:[n(Sm)+" שיתופים על "+n(Lm)+" בדיקות"],win:rng(W.M)}:null,
   today:C.Ed?{big:n(C.sofar("share")),unit:"שיתופים",lines:["על "+n(C.ck)+" בדיקות היום עד עכשיו"]}:null,
   drill:[sh?{h:"קישורים ששותפו והביאו אנשים, לפי סוג",html:'<ul class="kv">'+(Object.entries(sh[0].by||{}).map(e=>kv(VIA[e[0]]||esc(e[0]),n(e[1]))).join("")||kv("עדיין אין כניסות מקישור ששותף",""))+"</ul>"+(sh[0].bar?note("ועוד "+n(sh[0].bar)+' פתיחות מהבר "פתחו באפליקציה" או מהעתקת הקישור בדף שכבר היה פתוח: אותו ביקור, לא נספרות כהגעה מקישור.'):"")}:null]}}};
REG.google={name:"כניסות מגוגל בשבוע",dept:"seo",def:"כמה אנשים הגיעו לאתר מתוצאות חיפוש בגוגל בשבוע.",how:"Search Console, לחיצות, 7 ימים עד לפני 3 ימים (גוגל מוסר באיחור). היעד מתוכנית השיווק, לפי היום האחרון בחלון.",src:"Search Console",owner:"SEO",
 calc(C){const S=C.d.seo,c=S&&S.cur,a=c?Math.round(c.clicks):null,sd=S&&S.range?S.range[1]:null,GC=goal("google_clicks_week",sd),exp=GC?GC[1]:null,cal=C.cal;let s;
  if(!c)s="nodata";else if(cal)s="cal";else if(exp<2)s="early";else s=band(a,GC,false,true);
  const ap2=S&&S.prev?Math.round(S.prev.clicks):null,gd=S&&S.days?S.days:[],gw=[];if(sd)for(let i=3;i>=0;i--){const e=addD(sd,-7*i);let v=0,any=false;gd.forEach(r=>{if(r[0]<=e&&r[0]>addD(e,-7)){v+=r[1];any=true}});if(any)gw.push([e,v])}
  const qs=S&&S.queries||[],c28=gd.slice(-28).reduce((x,r)=>x+r[1],0);
  return {s,v:a,big:n(a),dl:c?delta(a,ap2):"",gl:exp>=1?n(a/exp*100)+"% מהיעד השבועי ("+n(exp)+")":"",gp:exp>=1?a/exp:0,gn:c&&exp<1?gtxtN("google_clicks_week",GC,sd):"",
   lines:[c?gtxtN("google_clicks_week",GC,sd):"Search Console לא ענה",c?"הופענו בתוצאות החיפוש <b>"+n(c.imps)+"</b> פעמים":""],win:S&&S.range?rng(S.range):"",foot:"גוגל מוסר באיחור של 3 ימים",
   chart:gw.length>1?bars(gw.map(x=>({l:dm(x[0]),v:x[1]}))):"",
   att:{prio:2,ratio:exp?a/exp:1,text:"כניסות מגוגל: "+n(a)+(exp>=1?", היעד "+n(exp):""),short:s==="nodata"?"חסר נתון מ-Search Console":"הכניסות מגוגל מתחת ליעד"},
   m28:gd.length?{big:n(c28),lines:[n1(c28/28)+" ביום בממוצע"],win:gd.length?dm(gd[Math.max(0,gd.length-28)][0])+" עד "+dm(gd[gd.length-1][0]):""}:null,today:null,
   drill:[gd.length?{h:"כניסות מגוגל לפי יום, 28 ימים",html:spark(gd.slice(-28).map(x=>x[1]),gd.slice(-28).map(x=>dm(x[0])))}:null,
    {h:"מה חיפשו בגוגל כשהופענו (28 ימים)",html:tbl(["חיפוש","נכנסו","הופענו","מקום ממוצע"],qs.slice().sort((a,b)=>b[1]-a[1]||b[2]-a[2]).slice(0,10).map(r=>[esc(r[0]),n(r[1]),n(r[2]),n(r[4])]))},
    {h:"חיפושים שקרובים לעמוד הראשון",html:tbl(["חיפוש","הופענו","מקום ממוצע"],qs.filter(r=>r[4]>=8&&r[4]<=20&&r[2]>=3).sort((a,b)=>b[2]-a[2]).slice(0,8).map(r=>[esc(r[0]),n(r[2]),n(r[4])]))},
    {h:"הדפים שגוגל הציג (28 ימים)",html:tbl(["דף","נכנסו","הופענו"],(S&&S.pages||[]).slice(0,8).map(r=>[PG(r[0]),n(r[1]),n(r[2])]))+note("נכנסו: לחצו על התוצאה ונכנסו לאתר. הופענו: כמה פעמים הופענו בתוצאות. מקום ממוצע: 1 עד 10 הם העמוד הראשון.")}]}}};
REG.impressions={name:"הופעות בחיפוש גוגל",dept:"seo",def:"כמה פעמים דף של לוחית הופיע בתוצאות החיפוש של גוגל בשבוע, גם בלי לחיצה.",how:"Search Console, הופעות (impressions), אותו חלון כמו הכניסות מגוגל.",src:"Search Console",owner:"SEO",
 calc(C){const S=C.d.seo,c=S&&S.cur,a=c?Math.round(c.imps):null,ap=S&&S.prev?Math.round(S.prev.imps):null,gd=S&&S.days?S.days:[],i28=gd.slice(-28).reduce((x,r)=>x+r[2],0);
  return {s:c?"ref":"nodata",v:a,big:n(a),dl:delta(a,ap),lines:[c?"מקום ממוצע בתוצאות: <b>"+n1(c.pos)+"</b>"+(S.prev?" (שבוע קודם "+n1(S.prev.pos)+")":""):"Search Console לא ענה",c?"שיעור הלחיצה: "+n1(c.ctr*100)+"%":""],win:S&&S.range?rng(S.range):"",foot:"גוגל מוסר באיחור של 3 ימים",
   m28:gd.length?{big:n(i28),lines:[n1(i28/28)+" ביום בממוצע"],win:dm(gd[Math.max(0,gd.length-28)][0])+" עד "+dm(gd[gd.length-1][0])}:null,today:null,
   drill:[gd.length?{h:"הופעות לפי יום, 28 ימים",html:spark(gd.slice(-28).map(x=>x[2]),gd.slice(-28).map(x=>dm(x[0])))}:null]}}};
REG.pages={name:"דפים שמופיעים בגוגל",dept:"seo",def:"כמה מדפי האתר נמצאים באינדקס של גוגל ויכולים להופיע בתוצאות. יותר דפים בגוגל מביאים עם הזמן יותר כניסות בלי פרסום.",how:"בדיקת האינדוקס היומית של Search Console (צילום נתוני SEO), מול יעד תוכנית השיווק להיום. כמה דפים מתחת לקו (3, או 5%) זה צהוב, כי גוגל מכניס דפים בקבוצות.",src:"Search Console",owner:"SEO",
 calc(C){const X=C.d.metrics&&C.d.metrics.index,GP2=goal("pages_indexed",C.td),pexp=GP2[1];let ps;
  if(!X||X.indexed==null||Date.now()-Date.parse(X.at)>48*3600e3)ps="nodata";else{ps=band(X.indexed,GP2,false,false);if(ps==="bad"&&X.indexed>=pexp-Math.max(3,pexp*.05))ps="warn"}
  const S=C.d.seo;
  return {s:ps,v:X?X.indexed:null,big:X?n(X.indexed):"-",unit:X?"מתוך "+n(X.total||X.inspected):"",gl:X&&pexp?n(X.indexed/pexp*100)+"% מהיעד להיום ("+n(pexp)+")":"",gp:X&&pexp?X.indexed/pexp:0,
   lines:[X?"גוגל ראה ועוד לא הכניס לתוצאות: <b>"+n(X.crawledNotIndexed)+"</b>":"אין עדיין צילום של האינדוקס",X?"נבדק "+hm(X.at):"","היעד "+n(pexp)+" (טווח "+n(GP2[0])+" עד "+n(GP2[2])+")"],win:"היום",foot:"רמה, לא זרם: המספר נמדד להיום",
   att:{prio:3,ratio:X&&pexp?X.indexed/pexp:1,text:"דפים שמופיעים בגוגל: "+(X?n(X.indexed):"-")+", היעד "+n(pexp),short:ps==="nodata"?"חסר נתון על הדפים בגוגל":"פחות דפים בגוגל מהיעד"},
   drill:[S&&S.sitemaps&&S.sitemaps.length?{h:"מפת האתר",html:'<ul class="kv">'+S.sitemaps.map(r=>kv('<bdi dir="ltr">'+esc(r.path.replace(/^https?:\/\/[^/]+/,""))+"</bdi>",n(r.submitted)+" דפים"+(r.errors?", "+n(r.errors)+" שגיאות":"")+(r.warnings?", "+n(r.warnings)+" אזהרות":""),r.last?"נקראה "+hm(r.last):"")).join("")+"</ul>"}:null]}}};
REG.googleChecks={name:"בדיקות באתר שהגיעו מחיפוש",dept:"seo",def:"בדיקות רכב באתר שנעשו בכניסה שהגיעה מגוגל או ממנוע חיפוש אחר.",how:"גוגל אנליטיקס: בדיקות באתר לפי מקור הכניסה (google, search), 7 ימים עד אתמול.",src:"גוגל אנליטיקס",owner:"SEO",
 calc(C){const B=C.W&&C.W.bySource,v=B?((B[0].google||[0,0])[1]+(B[0].search||[0,0])[1]):null,p=B?((B[1].google||[0,0])[1]+(B[1].search||[0,0])[1]):null,vis=B?((B[0].google||[0,0])[0]+(B[0].search||[0,0])[0]):null;
  return {s:B?"ref":"nodata",v,big:n(v),unit:"בדיקות",dl:delta(v,p),lines:[B?"מתוך <b>"+n(vis)+"</b> כניסות מחיפוש":"גוגל אנליטיקס לא ענה על המקורות"],win:rng(C.W&&C.W.W),foot:"האתר מוסר מקור מ-20.10"}}};
REG.visits={name:"כניסות לאתר בשבוע",dept:"marketing",def:"כמה פעמים נכנסו לאתר בשבוע. מי שרענן את הדף או חזר באותו ביקור נספר פעם אחת.",how:"גוגל אנליטיקס, האירוע web_visit, 7 ימים עד אתמול. לצידו Cloudflare סופר ביקורים בכל דפי האתר, במדגם.",src:"גוגל אנליטיקס, Cloudflare",owner:"שיווק",
 calc(C){const ev=C.ev,ge=C.ge,E0=C.E0,E1=C.E1,E2=C.E2,W=C.W,v=ev?ge(E0,"web_visit"):null,p=ev?ge(E1,"web_visit"):null,S7=W&&W.sources,tot=S7?S7.reduce((a,r)=>a+r[1],0):null;
  const SRC=h=>!h?"בלי אתר מפנה (הקלדה, וואטסאפ, הודעות)":/google\./.test(h)?"גוגל":/bing\.|duckduckgo|yahoo|ecosia|yandex/.test(h)?"מנועי חיפוש אחרים":/whatsapp|^wa\.me$/.test(h)?"וואטסאפ":/facebook|^fb\.|^l\.fb\./.test(h)?"פייסבוק":/instagram/.test(h)?"אינסטגרם":/tiktok/.test(h)?"טיקטוק":/youtube|^youtu\.be$/.test(h)?"יוטיוב":/^t\.co$|twitter|^x\.com$/.test(h)?"X (טוויטר)":/linkedin|^lnkd\.in$/.test(h)?"לינקדאין":/telegram|^t\.me$/.test(h)?"טלגרם":/luchit\.app/.test(h)?"מתוך האתר":h;
  const agg=(arr,f)=>{const m={};(arr||[]).forEach(r=>{const k=f(r[0]);m[k]=(m[k]||0)+r[1]});return Object.entries(m).sort((a,b)=>b[1]-a[1])};
  const CH=C.d.daily&&C.d.daily.ch,sb=k=>{const s=String(k||"").toLowerCase();return !s||s==="(not set)"||s==="direct"?"nolink":SL[s]&&s!=="unknown"&&s!=="app"?s:"other"},fold=(o,f)=>{const m={};for(const k in o||{}){const b=f(k);m[b]=(m[b]||0)+o[k]}return m},s7=CH&&CH.site?fold(CH.site[0],sb):null;
  return {s:ev?"ref":"nodata",v,big:n(v),dl:delta(v,p),lines:[ev?"":"גוגל אנליטיקס לא ענה",tot!=null?"לפי Cloudflare, כל דפי האתר: <b>"+n(tot)+"</b> ביקורים ("+rng(W.CW)+")":"",C.d.visitsToday!=null?"היום עד עכשיו: <b>"+n(C.d.visitsToday)+"</b> ביקורים (Cloudflare)":""],win:rng(W&&W.W),foot:"גוגל אנליטיקס",
   chart:C.ENDS.length&&C.SR&&C.SR.web_visit?bars(C.ENDS.map(e=>({l:dm(e),v:addD(e,-6)<SITE_FROM?null:C.wsum("web_visit",e)}))):"",
   m28:ev?{big:n(ge(E2,"web_visit")),lines:[n1(ge(E2,"web_visit")/28)+" ביום בממוצע"],win:rng(W.M)}:null,
   today:C.d.visitsToday!=null||C.Ed?{big:n(C.d.visitsToday!=null?C.d.visitsToday:C.sofar("web_visit")),lines:[C.d.visitsToday!=null?"ביקורים לפי Cloudflare. אתמול, יום שלם: <b>"+n(C.d.visitsYesterday)+"</b>":"כניסות לפי גוגל אנליטיקס","30 הדקות האחרונות: <b>"+n(C.rt("web_visit"))+"</b> נכנסו, "+n(C.rt("link_landing"))+" מהם מקישור"]}:null,
   drill:[s7?{h:"מאיפה הגיעו לאתר, 7 הימים האחרונים (כולל היום)",html:tbl(["מקור","נכנסו"],Object.entries(s7).sort((a,b)=>b[1]-a[1]).map(e=>[esc(SL[e[0]]||e[0]),n(e[1])]))+note("לפי המקור שהדף מוסר (מ-20.10). וואטסאפ לרוב לא מוסר מאיפה הגיעו, ולכן קישור רגיל נספר כ«בלי מקור מזוהה»; הקישור luchit.app/go/wa נספר בוודאות.")}:null,
    S7?{h:"ביקורים לפי אתר מפנה, לפי Cloudflare ("+rng(W.CW)+")",html:tbl(["מקור","ביקורים"],agg(S7,SRC).filter(r=>r[1]>0).map(r=>[esc(r[0]),n(r[1])]))}:null,
    W&&W.pages?{h:"הדפים שהכי נצפו",html:tbl(["דף","צפיות"],W.pages.slice(0,8).map(r=>[PG(r[0]),n(r[2])]))+note("Cloudflare סופר במדגם, ולכן המספרים מעוגלים לעשרות.")}:null]}}};
REG.campChecks={name:"בדיקות מקישורים שלנו",dept:"marketing",def:"בדיקות רכב באתר שהגיעו מקישור מסומן שלנו (go/ עם נושא): פוסטים, קבוצות, ביו, מגזין.",how:"גוגל אנליטיקס: בדיקות באתר לפי הרשת והנושא של הקישור, 7 ימים עד אתמול. נושאים נמדדים מ-23.10. קבוצות פייסבוק מקובצות לשורה אחת.",src:"גוגל אנליטיקס",owner:"שיווק",
 calc(C){const W=C.W,BC=W&&W.byCamp,fam=k=>{const i=k.indexOf("|");return /^fbg_[a-z]{1,20}$/.test(k.slice(i+1))?k.slice(0,i)+"|fb_groups":k},mg=o=>{const r={};for(const k in o||{}){const m=fam(k),v=o[k];r[m]=[(r[m]||[0,0])[0]+v[0],(r[m]||[0,0])[1]+v[1]]}return r};
  const cv=BC?mg(BC[0]):null,cp=BC?mg(BC[1]):null,sum=o=>o?Object.values(o).reduce((a,v)=>a+v[1],0):null,v=sum(cv),p=sum(cp),vis=cv?Object.values(cv).reduce((a,x)=>a+x[0],0):null;
  const AS=W&&W.appSrc,AC=AS&&AS[0].camp?(()=>{const r={};for(const k in AS[0].camp){const m=fam(k);r[m]=(r[m]||0)+AS[0].camp[k]}return r})():null;
  const tl=t=>TOP[t]||(/^fb_group_/.test(t)?"קבוצה: "+'<bdi dir="ltr">'+esc(t.slice(9))+"</bdi>":'<bdi dir="ltr">'+esc(t)+"</bdi>"),nm2=k=>{const i=k.indexOf("|");return esc(SL[k.slice(0,i)]||k.slice(0,i))+" · "+tl(k.slice(i+1))};
  const ks=cv?Object.keys(Object.assign({},cv,AC||{})).filter(k=>(cv[k]||[0,0])[1]||(cv[k]||[0,0])[0]||(AC&&AC[k])).sort((a,b)=>(cv[b]||[0,0])[1]-(cv[a]||[0,0])[1]||((AC&&AC[b])||0)-((AC&&AC[a])||0)):[],top=ks[0];
  const SO=W&&W.social;
  return {s:BC?"ref":"nodata",v,big:n(v),unit:"בדיקות",dl:delta(v,p),lines:[BC?"מ-<b>"+n(vis)+"</b> כניסות מקישורים מסומנים":"אין נתון מגוגל אנליטיקס",top?"הכי הרבה: "+nm2(top)+" ("+n(cv[top][1])+")":""],win:rng(W&&W.W),foot:"קישורי go/ עם נושא",
   drill:[{h:"לפי קישור ונושא ("+rng(W&&W.W)+")",html:ks.length?tbl(["קישור","נכנסו לאתר","בדיקות רכב","התקינו"],ks.map(k=>[nm2(k),n((cv[k]||[0,0])[0]),n((cv[k]||[0,0])[1]),n(AC&&AC[k]||0)]))+note("כל קישור luchit.app/go/ נספר לפי הרשת והנושא שלו. התקינו: פתיחה ראשונה של האפליקציה אחרי הורדה דרך הקישור."):note("עוד אין השבוע כניסות מקישור עם נושא.")},
    SO?{h:"מהאתר לעמודים שלנו ברשתות",html:tbl(["עמוד","לחיצות השבוע","שבוע קודם"],[...new Set(["facebook","instagram","tiktok",...Object.keys(SO[0]),...Object.keys(SO[1])])].map(k=>[esc(SL[k]||k),n(SO[0][k]||0),n(SO[1][k]||0)]))}:null]}}};
REG.organic={name:"צמיחה בלי דחיפה",dept:"marketing",def:"החלק של בדיקות האתר שהגיעו ממקורות שאינם קישורי קמפיין שלנו: גוגל, מנועי חיפוש, ישיר, דפים אחרים באתר, דוחות ששותפו ואתרים אחרים. שאלה 1 של החודש.",how:"גוגל אנליטיקס, בדיקות באתר לפי מקור, 7 ימים עד אתמול. הסף 25% מהבדיקות שהמקור שלהן ידוע, ועלייה של 20% בשבוע. נשפט מ-30 בדיקות עם מקור ידוע.",src:"גוגל אנליטיקס",owner:"שיווק, אסטרטגיה",
 calc(C){const W=C.W,ORG=["google","search","direct","site","share","other"],B=W&&W.bySource,seen=W&&W.srcSeen||[false,false],AS=W&&W.appSrc;
  const sc=(o,ks)=>ks.reduce((a,k)=>a+((o&&o[k]||[0,0])[1]),0),known=o=>Object.keys(o||{}).filter(k=>k!=="app"&&k!=="unknown");
  const o0=B?sc(B[0],ORG):null,m0=B?sc(B[0],known(B[0])):null,o1=B&&seen[1]?sc(B[1],ORG):null,sh=m0?o0/m0*100:null,gr=o1?(o0-o1)/o1*100:null;let s,w,r;
  if(!B){s="nodata";r="גוגל אנליטיקס לא ענה על המקורות."}
  else if(!seen[0]||m0<30){s="early";r="מעט נתונים עדיין: "+n(m0)+" בדיקות באתר שהמקור שלהן ידוע. צריך לפחות 30 בשבוע."}
  else if(sh<25){s="warn";w="מתחת ל-25%";r="אם זה יישאר כך עד 22.11, החודש הבא מוקדש להפצה: שותפויות, קהילות, סוחרים. לא לפיצ'רים."}
  else if(gr!=null&&gr>=20){s="ok";w="יש משיכה";r="מעל 25% ועולה ב-20% בשבוע או יותר: אפשר להתחיל להשקיע בלולאות (שיתוף, הפניות)."}
  else{s="warn";w="עוד לא צומח";r="מעל 25%, אבל עוד לא עולה ב-20% בשבוע. אם זה לא יעלה עד 22.11, החודש הבא מוקדש להפצה."}
  return {s,w,v:sh,big:pc(sh),unit:"מבדיקות האתר",read:r,dl:gr!=null?'<bdi dir="ltr">'+(gr>0?"+":"")+n(gr)+"%</bdi> בבדיקות האורגניות מול השבוע הקודם":"",lines:[B?"<b>"+n(o0)+"</b> בדיקות ממקורות שאינם קמפיין"+(o1!=null?" (שבוע קודם "+n(o1)+")":"")+", מתוך "+n(m0)+" עם מקור ידוע":"",r],win:rng(W&&W.W),foot:"הסף 25%, וצמיחה של 20% בשבוע",
   drill:[B?{h:"המספרים",html:'<ul class="kv">'+kv("בדיקות באתר ממקורות שאינם קישורי קמפיין",n(o0)+(o1!=null?' <small class="flat">(שבוע קודם '+n(o1)+")</small>":""),"גוגל, מנועי חיפוש, ישיר, דפים אחרים באתר, דוחות ששותפו ואתרים אחרים")+kv("החלק שלהן מהבדיקות באתר",pc(sh),"מתוך "+n(m0)+" בדיקות שהמקור שלהן ידוע · הסף 25%")+(gr!=null?kv("שינוי מהשבוע הקודם",'<bdi dir="ltr">'+(gr>0?"+":"")+n(gr)+"%</bdi>","הסף לצמיחה: 20% בשבוע"):"")+(AS?kv("התקנות שמצאו את האפליקציה בחנות",n(AS[0].store)+' <small class="flat">(שבוע קודם '+n(AS[1].store)+")</small>","מתוך "+n(AS[0].all)+" התקנות חדשות בישראל השבוע"):"")+"</ul>"+note('בדיקות באפליקציה לא נכללות, כי לפתיחה של האפליקציה אין מקור. "ישיר" כולל גם קישור שנשלח בוואטסאפ בלי סימון, ולכן המספר אופטימי במעט.')}:null]}}};
REG.siteChecks={name:"בדיקות רכב באתר",dept:"data",def:"בדיקות רכב שנעשו באתר (לא באפליקציה) בשבוע, ומאיפה הגיעו.",how:"גוגל אנליטיקס, בדיקות באתר לפי יום (site_lookup) ולפי מקור, 7 ימים עד אתמול. האתר נספר מ-15.10 ומוסר מקור מ-20.10.",src:"גוגל אנליטיקס",owner:"מדידה",
 calc(C){const W=C.W,end=C.end,v=C.wsum("site_lookup",end),p=end?C.wsum("site_lookup",addD(end,-7)):null,wk=C.week(end),B=W&&W.bySource;
  const G=[["social","רשתות וקישורים שלנו",["facebook","instagram","tiktok","youtube","whatsapp","linkedin","newsletter","press","dealer","qr"]],["search","חיפוש בגוגל ובמנועים אחרים",["google","search"]],["direct","ישיר, בלי מקור מזוהה",["direct"]],["share","דוחות רכב ששותפו",["share"]],["site","מדפים אחרים באתר",["site"]],["other","אתרים ואפליקציות אחרים",["other"]]];
  const c=B&&B[0],rows=c?G.map(x=>[x[1],x[2].reduce((a,k)=>a+((c[k]||[0,0])[1]),0)]):[],tot=rows.reduce((a,r)=>a+r[1],0),unk=c?(c.unknown||[0,0])[1]:0,top=rows.slice().sort((a,b)=>b[1]-a[1])[0];
  return {s:v!=null?"ref":"nodata",v,big:n(v),unit:"בדיקות",dl:delta(v,p),lines:[v!=null&&wk?n(v/wk*100)+"% מכל הבדיקות השבוע":"",top&&tot?"הכי הרבה: "+top[0]+", "+n(top[1]/tot*100)+"%":""],win:rng(W&&W.W),foot:"האתר נספר מ-15.10",
   chart:C.ENDS.length&&C.SR&&C.SR.site_lookup?bars(C.ENDS.map(e=>({l:dm(e),v:addD(e,-6)<SITE_FROM?null:C.wsum("site_lookup",e)}))):"",
   m28:C.SR?{big:n(C.wsum("site_lookup",end,28)),lines:[],win:rng(W.M)}:null,today:C.Ed?{big:n(C.sofar("car_lookup")),unit:"בדיקות באפליקציה ובאתר יחד",lines:["הפיצול לאתר ולאפליקציה נספר רק ליום שלם"]}:null,
   drill:[tot?{h:"לפי מקור ("+rng(W.W)+")",html:rows.map(r=>'<div class="brk"><span>'+r[0]+'</span><div class="bb"><i style="width:'+(r[1]/tot*100)+'%;--c:var(--site)"></i></div><b>'+n(r[1])+"</b></div>").join("")+(unk?note("ועוד "+n(unk)+" בדיקות באתר בלי מקור: לפני 20.10, כשהמקור עוד לא נמדד."):"")}:null]}}};
REG.checksApp={name:"בדיקות רכב באפליקציה",dept:"data",def:"בדיקות רכב שנעשו באפליקציה בשבוע, וכמה מכשירים עשו אותן.",how:"גוגל אנליטיקס: כל הבדיקות (car_lookup) פחות הבדיקות באתר, ומכשירים שבדקו (savers). 7 ימים עד אתמול.",src:"גוגל אנליטיקס",owner:"מדידה",
 calc(C){const W=C.W,end=C.end,wk=C.week(end),site=C.wsum("site_lookup",end),v=wk!=null&&site!=null?Math.max(0,wk-site):null,wp=end?C.week(addD(end,-7)):null,sp=end?C.wsum("site_lookup",addD(end,-7)):null,p=wp!=null&&sp!=null?Math.max(0,wp-sp):null,SV=W&&W.savers,SP=W&&W.saversP;
  return {s:v!=null?"ref":"nodata",v,big:n(v),unit:"בדיקות",dl:delta(v,p),lines:[SV?"<b>"+n(SV.car_lookup)+"</b> מכשירים בדקו רכב"+(SP?" (שבוע קודם "+n(SP.car_lookup)+")":""):"",SV&&SV.car_lookup?n1(v/SV.car_lookup)+" בדיקות למכשיר בממוצע":""],win:rng(W&&W.W),foot:"גוגל אנליטיקס",
   chart:C.ENDS.length?bars(C.ENDS.map(e=>({l:dm(e),v:Math.max(0,(C.week(e)||0)-Math.min(C.wsum("site_lookup",e)||0,C.week(e)||0))}))):""}}};

REG.store={name:"Google Play",dept:"release",def:"האם אפשר להתקין את האפליקציה מהחנות, ומה מצב הגרסה האחרונה בבדיקה של גוגל.",how:"דף החנות הציבורי נבדק כל שעה; Play Console, כשהוא מחובר, מוסר את מצב גרסת הייצור.",src:"Google Play, Play Console",owner:"מוצר ושחרורים",
 calc(C){const GP=C.GP,top=C.top,RL=C.RL,d=C.d,pt=hm(d.playAt);
  return {s:GP.s,w:GP.s==="ok"?"באוויר":GP.s==="bad"?"נדחתה":"",big:top?esc(top.name||""):d.play==="live"?"באוויר":"-",unit:top?(RS[top.state]||["מצב לא ידוע"])[0]:"",lines:[GP.txt,top?"לפי Play Console"+(RL.at?", נבדק ב-"+hm(RL.at):""):"",!top&&(d.play==="live"||!RL)?(pt?"דף החנות הציבורי נבדק ב-"+pt+".":"דף החנות הציבורי נבדק כל שעה."):"",d.play!=="live"&&!(top||RL)?"הבקשה הוגשה ב-"+dm(SUBMITTED)+". אישור Google מגיע במייל ובקונסול.":""],win:"עכשיו",foot:"מצב, לא זרם",
   att:{prio:0,ratio:0,text:"Google Play: הגרסה החדשה נדחתה בבדיקה של גוגל. הסיבה במייל ובקונסול",short:"גרסה חדשה נדחתה בבדיקה של גוגל",w:"נדחתה"},
   drill:[RL&&RL.list&&RL.list.length?{h:"גרסאות בקונסול",html:'<ul class="kv">'+RL.list.map(r=>kv(esc(r.name||"")+(r.code?' <small class="flat">('+n(r.code)+")</small>":""),(RS[r.state]||[esc(r.state||"")])[0])).join("")+"</ul>"}:null]}}};
REG.rating={name:"דירוג בחנות",dept:"release",def:"הדירוג הממוצע ב-Google Play ומספר הדירוגים, מאז ההשקה.",how:"דוחות Google Play (באיחור של כמה ימים). תקין: 4.5 ומעלה; נשפט מ-5 דירוגים. אבן הדרך M3: 4.5 ומעלה עם 21 דירוגים.",src:"Google Play",owner:"מוצר ושחרורים",
 calc(C){const RA=C.d.rating&&C.d.rating.ok?C.d.rating:null,s=!RA?"nodata":RA.n<5?"early":RA.avg>=4.5?"ok":"warn",left=RA?Math.max(0,21-RA.n):21;
  return {s,w:s==="ok"?"4.5 ומעלה":s==="warn"?"מתחת ל-4.5":"",v:RA?RA.avg:null,big:RA&&RA.avg!=null?n1(RA.avg):"-",unit:RA?"★ מתוך 5":"",gl:RA?n(Math.min(100,RA.n/21*100))+"% מהדרך ל-21 דירוגים":"",gp:RA?RA.n/21:0,
   lines:[RA?"<b>"+n(RA.n)+"</b> דירוגים, "+n(RA.txt)+" מהם עם ביקורת כתובה":"עוד אין דירוגים בדוחות של Google Play. הם מתעדכנים פעם ביום, באיחור של כמה ימים.",RA?(left?"עד היעד של M3 (דירוג 4.5 ומעלה ו-21 דירוגים) חסרים עוד <b>"+n(left)+"</b>":"יש מספיק דירוגים ליעד של M3 (21)"):"",RA&&RA.own?"הממוצע מחושב מהביקורות":"",RA&&RA.last?"נתון אחרון מ-"+dm(RA.last):""],win:"מאז ההשקה",foot:"Google Play, באיחור של כמה ימים",
   drill:[]}}};
REG.crashes={name:"קריסות של האפליקציה",dept:"release",def:"כמה פעמים האפליקציה קרסה בשבוע, ובאיזה חלק מהמכשירים שפתחו אותה.",how:"גוגל אנליטיקס, האירוע app_exception: מכשירים שקרסו חלקי המכשירים שפתחו את האפליקציה בשבוע. תקין: עד 1% מהמכשירים; צהוב: עד 2%; אדום: מעל 2%. נשפט מ-50 מכשירים. אחרי שחרור גרסה שומר הקריסות משווה ל-7 הימים שלפניו.",src:"גוגל אנליטיקס",owner:"מוצר ושחרורים",
 calc(C){const ev=C.ev,E0=C.E0,E1=C.E1,ge=C.ge,A=C.W&&C.W.app,cr=ev?ge(E0,"app_exception"):null,cu=ev?ge(E0,"app_exception",1):null,crp=ev?ge(E1,"app_exception"):null,tot=A?A[0].totalUsers:null,rate=cu!=null&&tot?cu/tot*100:null;
  const s=!ev?"nodata":!tot||tot<50?"early":rate<=1?"ok":rate<=2?"warn":"bad";
  return {s,w:s==="bad"?"הרבה קריסות":s==="warn"?"מעט יותר מהרגיל":"",v:cr,big:n(cr),unit:cr===1?"קריסה":"קריסות",dl:delta(cr,crp),lines:[rate!=null?"<b>"+pc(rate)+"</b> מהמכשירים שפתחו את האפליקציה ("+n(cu)+" מתוך "+n(tot)+")":ev?"אין עדיין מספיק מכשירים כדי לשפוט":"גוגל אנליטיקס לא ענה","תקין: עד 1% מהמכשירים"],win:rng(C.W&&C.W.W),foot:"גוגל אנליטיקס",
   chart:C.W&&C.W.e28&&C.W.e28.app_exception?spark(C.W.e28.app_exception.a.map((x,i)=>x+C.W.e28.app_exception.w[i]),C.D28.map(dm)):"",
   att:{prio:6,ratio:rate!=null?1/Math.max(rate,.01):1,text:"קריסות: "+n(cr)+" בשבוע, "+pc(rate)+" מהמכשירים",short:s==="bad"?"הרבה קריסות באפליקציה":"קצת יותר קריסות"},
   today:C.Ed?{big:n(C.sofar("app_exception")),unit:"קריסות היום",lines:["30 הדקות האחרונות: <b>"+n(C.rt("app_exception"))+"</b>"]}:null}}};
REG.saves={name:"שמירת רכב אחרי בדיקה",dept:"release",def:"איזה חלק מהמכשירים באפליקציה שבדקו רכב השבוע שמרו אותו ברשימה. שמירה היא הרגע שמחזיר אנשים.",how:"גוגל אנליטיקס: מכשירים ששמרו רכב (car_save) חלקי מכשירים שבדקו (car_lookup), 7 ימים עד אתמול. היעד 15%; צהוב מ-10%; נשפט מ-50 מכשירים.",src:"גוגל אנליטיקס",owner:"מוצר ושחרורים",
 calc(C){const SV=C.W&&C.W.savers,SP=C.W&&C.W.saversP,Lu=SV?SV.car_lookup||0:null,Su=SV?SV.car_save||0:null,r=Lu>=50?Su/Lu*100:null,rp=SP&&SP.car_lookup>=50?(SP.car_save||0)/SP.car_lookup*100:null;
  const s=!SV?"nodata":Lu<50?"early":r>=15?"ok":r>=10?"warn":"bad",D=C.W&&C.W.door,g=(k,i)=>D&&D[k]?D[k][i]:0;
  return {s,w:s==="warn"?"מתחת ל-15%":s==="bad"?"מתחת ל-10%":"",v:r,big:r!=null?pc(r):SV?n(Su):"-",unit:r!=null?"מהבודקים":SV?"שמרו":"",dl:delta1(r,rp),gl:r!=null?n(r/15*100)+"% מהיעד (15%)":"",gp:r!=null?r/15:0,gn:SV&&r==null?"מעט מדי מכשירים בדקו רכב השבוע כדי לחשב אחוז: "+n(Su)+" שמרו מתוך "+n(Lu):"",
   lines:[SV?"<b>"+n(Su)+"</b> מכשירים שמרו, מתוך "+n(Lu)+" שבדקו":"אין נתון מגוגל אנליטיקס על מכשירים ששמרו רכב"],win:rng(C.W&&C.W.W),foot:"מכשירים באפליקציה",
   chart:C.ENDS.length&&C.SR&&C.SR.car_save?bars(C.ENDS.map(e=>({l:dm(e),v:C.wsum("car_save",e)}))):"",
   att:{prio:6,ratio:r!=null?r/15:1,text:"שמירת רכב: "+pc(r)+" מהבודקים, היעד 15%",short:"מעט שומרים רכב אחרי בדיקה"},
   drill:[D&&(D.shown||D.overview||D.menu||D.home)?{h:"תיק הרכב: הדלת בסקירה (מ-1.38)",html:'<ul class="kv">'+kv("הצגת השורה «פתיחת תיק»",n(g("shown",0)),"שבוע קודם "+n(g("shown",1)))+kv("תיקים שנפתחו מהשורה",n(g("overview",0)),"שבוע קודם "+n(g("overview",1)))+kv("תיקים שנפתחו מהתפריט",n(g("menu",0)))+kv("תיקים שנפתחו ממסך הבית",n(g("home",0)))+"</ul>"+note(g("shown",0)>=20?"מתוך מי שראה את השורה, "+n1(g("overview",0)/Math.max(1,g("shown",0))*100)+"% פתחו תיק.":"עדיין מעט הצגות של השורה כדי לחשב אחוז.")}:null]}}};
REG.return7={name:"רכב שמור מחזיר אנשים?",dept:"release",def:"פי כמה חוזרים בשבוע הראשון מי ששמרו רכב ביום ההתקנה, לעומת מי שלא שמרו. שאלה 2 של החודש.",how:"גוגל אנליטיקס, התקנות מ-1.36 (מ-21.10) שעבר עליהן שבוע שלם: חזרה בימים 1 עד 7. הסף: פי 3. ההחלטה נחשבת רק מ-40 ששמרו, ש-5 מהם חזרו, ו-20 לפחות שלא שמרו.",src:"גוגל אנליטיקס",owner:"מוצר ושחרורים",
 calc(C){const W=C.W,end=C.end,Cq=W&&W.coh,mat=end?addD(end,-7):null;let I=0,Sv=0,N1=0,N0=0,R1=0,R0=0,Est=0;
  for(const day in Cq||{}){if(day<QF)continue;const o=Cq[day],sv=o[1];I+=o[0];Sv+=o[1];Est+=o[4]||0;if(day<=mat){N1+=sv;N0+=Math.max(0,o[0]-sv);R1+=o[2];R0+=o[3]}}
  const r1=N1?R1/N1*100:null,r0=N0?R0/N0*100:null,x=r1==null||r0==null?null:r0>0?r1/r0:r1>0?Infinity:null;let s,w,r;
  if(!W||!end||end<QF){s="wait";w="ממתין לנתונים";r="הנתונים מתחילים עם 1.36: כל יום התקנות נכנס לחשבון שבוע אחרי שהותקן."}
  else if(!Cq){s="nodata";r="גוגל אנליטיקס לא ענה."}
  else if(N1<40||R1<5||N0<20){s="early";r="מעט נתונים עדיין: "+n(N1)+" ששמרו ו-"+n(R1)+" שחזרו, מתוך מי שעבר עליו שבוע שלם. ההחלטה נחשבת מ-40 ששמרו, 5 שחזרו ו-20 שלא שמרו; אחרת היא עוברת מ-22.11 ל-6.12."}
  else if(x>=3){s="ok";w="השמירה מחזירה";r="מי ששמר רכב חוזר פי 3 או יותר: השמירה היא המנוף, וכדאי לחזק את רגע השמירה אחרי בדיקה."}
  else{s="warn";w="פחות מפי 3";r="השמירה לא מחזירה מספיק: אם זה יישאר כך, מפסיקים לדחוף התקנות, ולוחית היא כלי אתר לשימוש חד-פעמי."}
  return {s,w,v:x,big:x==null?"-":x===Infinity?"∞":"פי "+n1(x),unit:x!=null?"חוזרים יותר":"",read:r,lines:[r1!=null?"חזרו: <b>"+pc(r1)+"</b> ממי ששמרו, <b>"+pc(r0)+"</b> ממי שלא":"",s==="early"||s==="wait"?"":"הסף: פי 3"],win:"התקנות מ-"+dm(QF)+(mat?" עד "+dm(mat):""),foot:"עד 22.11, אחרת 6.12",
   drill:[s==="wait"||!Cq?null:{h:"המספרים",html:'<ul class="kv">'+kv("התקנות חדשות מ-1.36",n(I),"מ-"+dm(QF)+" עד "+(end?dm(end):"-")+", בישראל")+kv("שמרו רכב ביום ההתקנה",n(Sv)+(I?' <small class="flat">('+pc(Sv/I*100)+")</small>":""),"אחוז השומרים מתוך המתקינים")+kv("חזרו בתוך 7 ימים, מי ששמר",N1?n(R1)+" מתוך "+n(N1)+' <small class="flat">('+pc(r1)+")</small>":"-","התקנות שעבר עליהן שבוע שלם"+(mat&&mat>=QF?" (עד "+dm(mat)+")":""))+kv("חזרו בתוך 7 ימים, מי שלא שמר",N0?n(R0)+" מתוך "+n(N0)+' <small class="flat">('+pc(r0)+")</small>":"-","")+kv("פי כמה חוזרים מי ששמרו",x==null?"-":x===Infinity?"רק הם חזרו":"פי "+n1(x),"הסף: פי 3")+"</ul>"+(Est?note("הערכה: האפליקציה לא שולחת כרגע את יום ההתקנה, ולכן "+n(Est)+" שמירות וחזרות שויכו לפי התאריך שלהן."):"")}]}}};
REG.shareOpen={name:"איפה נשבר השיתוף?",dept:"release",def:"כמה מהדוחות שהוצגו פתחו את חלון השיתוף, כמה מהפתיחות הפכו לשיתוף, וכמה שיתופים הביאו מישהו. שאלה 3 של החודש.",how:"גוגל אנליטיקס: share_open חלקי car_lookup, share חלקי share_open, ונכנסו מקישור ששותף חלקי share. 7 ימים עד אתמול. ספים: 2% פותחים, 30% משלימים, כניסה אחת לכל 10 שיתופים. נשפט מ-200 בדיקות.",src:"גוגל אנליטיקס",owner:"מוצר ושחרורים",
 calc(C){const ev=C.ev,E0=C.E0,ge=C.ge,W=C.W,Lw=ge(E0,"car_lookup"),Ow=ge(E0,"share_open"),Sw=ge(E0,"share"),sh=W&&W.shared,Aw=sh?sh[0].web+sh[0].app:null,part=W&&W.W&&W.W[0]<QF;
  const o=Lw?Ow/Lw*100:null,c=Ow?Sw/Ow*100:null,a=Sw&&Aw!=null?Aw/Sw:null;let s,w,r;
  if(!ev){s="nodata";r="גוגל אנליטיקס לא ענה."}
  else if(part){s="early";r="פתיחת חלון השיתוף נמדדת מ-"+dm(QF)+". השבוע המלא הראשון יוצג מ-"+dm(addD(QF,7))+"."}
  else if(Lw<200){s="early";r="מעט בדיקות השבוע כדי לשפוט ("+n(Lw)+", צריך 200)."}
  else if(o<2){s="warn";w="מעטים פותחים";r="פחות מ-2% פותחים את חלון השיתוף: בעיית מוטיבציה. הכיוון: הצד של המוכר, מוכר ששולח דוח לקונה."}
  else if(Ow<20){s="early";r="מעט פתיחות של החלון כדי לשפוט את ההמשך ("+n(Ow)+", צריך 20)."}
  else if(c<30){s="warn";w="מעטים משלימים";r="רבים פותחים את החלון ומעטים משתפים בפועל: תיקון קטן בחלון השיתוף."}
  else if(Sw<10){s="early";r="מעט שיתופים כדי לשפוט אם הם מביאים אנשים ("+n(Sw)+", צריך 10)."}
  else if(a<.1){s="warn";w="שיתופים בלי כניסות";r="משתפים, אבל כמעט אף אחד לא מגיע מהקישור: הקישור בטקסט יהיה ברירת המחדל במקום תמונה או PDF."}
  else{s="ok";w="השיתוף עובד";r="אין שבר בולט בשלבי השיתוף."}
  return {s,w,v:o,big:pc(o),unit:"פתחו את חלון השיתוף",read:r,lines:[ev?"<b>"+n(Ow)+"</b> פתיחות מתוך "+n(Lw)+" דוחות, <b>"+n(Sw)+"</b> שיתופים, <b>"+n(Aw)+"</b> נכנסו מקישור":"",r],win:rng(W&&W.W),foot:"ספים: 2% פותחים, 30% משלימים",
   drill:[ev?{h:"שלבי השיתוף",html:'<ul class="kv">'+kv("דוחות שהוצגו (בדיקות רכב)",n(Lw),rng(W&&W.W)+" · אפליקציה ואתר")+kv("פתחו את חלון השיתוף",n(Ow)+' <small class="flat">('+pc(o)+")</small>","מתוך הדוחות · הסף 2%")+kv("שיתפו בפועל",n(Sw)+' <small class="flat">('+pc(c)+")</small>","מתוך הפתיחות · הסף 30%")+kv("נכנסו מקישור ששותף",n(Aw)+(a!=null?' <small class="flat">('+n1(a*10)+" לכל 10 שיתופים)</small>":""),"הסף: כניסה אחת לכל 10 שיתופים")+"</ul>"+note("פתיחת החלון נמדדת באתר מ-21.10, ובאפליקציה אצל מי שעדכן ל-1.36.")}:null]}}};
REG.health={name:"תקינות השירות",dept:"data",def:"אחוז הבדיקות שקיבלו תשובה. כשל הוא רק כשמשרד התחבורה לא ענה או שלא התקבלה תשובה; מספר שהוקלד לא נכון אינו כשל.",how:"גוגל אנליטיקס: בדיקות שנכשלו מסיבה טכנית (משרד התחבורה לא ענה, בלי תשובה, חיבור, קוד) חלקי כל ניסיונות הבדיקה, 7 ימים עד אתמול. היעד: עד 2% כשלים (צהוב עד 3%). נשפט מ-50 ניסיונות; פחות מ-5 כשלים אדומים נחשבים צהוב.",src:"גוגל אנליטיקס",owner:"נתונים",
 calc(C){const W=C.W,ev=C.ev,E0=C.E0,ge=C.ge,fk=W&&W.fails?W.fails[0]:null,tech=fk?(fk.source_down||0)+(fk.offline||0)+(fk.net_err||0)+(fk.js_err||0):null,att2=ev?ge(E0,"car_lookup")+ge(E0,"lookup_failed"):null,GF=goal("failures_pct",C.end||C.td);let s,r=null;
  if(!fk||!ev)s="nodata";else if(att2<50)s="early";else{r=tech/att2*100;s=band(r,GF,true);if(s==="bad"&&tech<5)s="warn"}
  const d=C.d,PS=C.PS;
  return {s,w:s==="bad"?"יותר מדי כשלים":s==="warn"?"מעט יותר כשלים":"",v:r,big:r!=null?n1(100-r)+"%":"-",unit:r!=null?"קיבלו תשובה":"",gl:r!=null?"כשלים: "+n1(r)+"%, היעד עד "+n1(GF[1])+"%":"",gp:r!=null?Math.min(1,GF[1]/Math.max(r,.01)):0,
   lines:[r!=null?"נכשלו <b>"+n(tech)+"</b> מתוך "+n(att2)+" ניסיונות":ev&&fk?"אין עדיין מספיק בדיקות כדי לשפוט":"אין נתון מגוגל אנליטיקס","מספר שהוקלד לא נכון לא נחשב כשל"],win:rng(W&&W.W),foot:"היעד: עד 2% כשלים",
   att:{prio:0,ratio:r!=null?GF[1]/Math.max(r,.01):1,text:"בדיקות שנכשלו: "+n1(r)+"%, היעד עד "+n1(GF[1])+"%",short:"",w:s==="bad"?"יותר מדי כשלים":s==="warn"?"מעט יותר כשלים":""},
   today:C.Ed?{big:n(C.sofar("lookup_failed")),unit:"בדיקות שנכשלו היום",lines:["מכל הסיבות, גם מספר שהוקלד לא נכון","30 הדקות האחרונות: <b>"+n(C.rt("lookup_failed"))+"</b> נכשלו, "+n(C.rt("app_exception"))+" קריסות"]}:null,
   drill:[{h:"בדיקות שלא החזירו תוצאה, לפי סיבה ("+rng(W&&W.W)+")",html:fk?'<ul class="kv">'+(Object.entries(fk).sort((a,b)=>b[1]-a[1]).map(e=>kv(KIND[e[0]]||esc(e[0]),n(e[1]))).join("")||kv("אין","0"))+"</ul>":note("אין נתון")},
    {h:"מקורות הנתונים של המסך",html:'<ul class="kv">'+(Object.entries(d.errors||{}).map(e=>kv(esc(e[0]),'<span style="font-weight:400">'+esc(whyT(e[1]))+"</span>")).join("")||kv("כל המקורות ענו","✓"))+kv("אזור הזמן של גוגל אנליטיקס",!d.gaTz?"לא נבדק":d.gaTz.ok?(d.gaTz.tz==="Asia/Jerusalem"?"שעון ישראל ✓":esc(d.gaTz.tz||"לא ידוע")):"לא נבדק")+kv("דוחות Google Play",PS?"מחובר, עד "+dm(PS.last):"לא מחובר")+kv("Play Console",d.release&&d.release.ok?"מחובר":"לא מחובר")+"</ul>"}]}}};
REG.slow={name:"בדיקות איטיות",dept:"data",def:"איזה חלק מהבדיקות לקחו יותר מ-5 שניות. מעל 10% זה דורש תשומת לב; הבעיה בדרך כלל אצל משרד התחבורה.",how:"גוגל אנליטיקס, משך הבדיקה בקבוצות (עד 2, 2 עד 5, 5 עד 10, מעל 10 שניות), 7 ימים עד אתמול. נשפט מ-50 בדיקות עם משך ידוע.",src:"גוגל אנליטיקס",owner:"נתונים",
 calc(C){const DU=C.W&&C.W.dur,sl=o=>{const k=(o.lt2||0)+(o["2to5"]||0)+(o["5to10"]||0)+(o.gt10||0);return k?{k,p:((o["5to10"]||0)+(o.gt10||0))/k*100,p10:(o.gt10||0)/k*100}:null},c=DU?sl(DU[0]):null,p=DU?sl(DU[1]):null,s=!c?"nodata":c.k<50?"early":c.p>10?"warn":"ok";
  return {s,w:s==="warn"?"מעל 10%":"",v:c?c.p:null,big:c?pc(c.p):"-",unit:c?"לקחו יותר מ-5 שניות":"",dl:c&&p?delta1(c.p,p.p):"",lines:[c?"מתוך "+n(c.k)+" בדיקות. יותר מ-10 שניות: <b>"+pc(c.p10)+"</b>":"אין נתון על משך הבדיקות","עד 10% זה תקין"],win:rng(C.W&&C.W.W),foot:"גוגל אנליטיקס",
   att:s==="warn"?{prio:6,ratio:10/c.p,text:"בדיקות איטיות: "+n1(c.p)+"% מהבדיקות לקחו יותר מ-5 שניות",short:"",w:"מעל 10%"}:null,
   drill:[DU?{h:"לפי משך ("+rng(C.W.W)+")",html:'<ul class="kv">'+[["lt2","עד 2 שניות"],["2to5","2 עד 5 שניות"],["5to10","5 עד 10 שניות"],["gt10","יותר מ-10 שניות"]].map(x=>kv(x[1],n(DU[0][x[0]]||0)+(DU[1]?' <small class="flat">(שבוע קודם '+n(DU[1][x[0]]||0)+")</small>":""))).join("")+"</ul>"}:null]}}};
REG.bots={name:"הבוטים",dept:"ops",def:"כל המשימות האוטומטיות: כמה רצו כמו שצריך מתוך כולן. בוט שנכשל מטופל אוטומטית; כאן רואים שזה קרה.",how:"לוח הבוטים שכותב שומר הדשבורד כל חצי שעה: הריצה האחרונה של כל משימה מתוזמנת ב-main. באיחור: לא רצה זמן ארוך מהרגיל שלה (ועוד רבע). רץ עכשיו: ריצה בעיצומה, לא באיחור.",src:"GitHub Actions",owner:"תפעול",
 calc(C){const BL=C.BL,BO=C.BO,okN=BL?BL.filter(o=>o.st[0]==="ok").length:0,probs=BL?BL.filter(o=>o.st[0]!=="ok"):[],bad=BL?BL.filter(o=>o.st[0]==="bad"||o.st[0]==="warn"):[],s=!BL?"nodata":probs.some(o=>o.st[0]==="bad")?"bad":probs.some(o=>o.st[0]==="warn")?"warn":"ok";
  return {s,w:s==="bad"?"בוט נכשל":s==="warn"?(bad.some(o=>o.s==="off")?"בוט כבוי":"בוט באיחור"):"",v:okN,big:BL?n(okN):"-",unit:BL?"מתוך "+n(BL.length)+" תקינים":"",gp:BL?okN/BL.length:0,gl:BL?n(okN/BL.length*100)+"% רצים כרגיל":"",
   lines:[BL?(probs.length?probs.slice(0,3).map(o=>esc(o.he)+": "+o.st[1]).join(", ")+(probs.length>3?" ועוד "+n(probs.length-3):""):"כל המשימות האוטומטיות רצות כרגיל"):"הרשימה תתמלא אחרי הריצה הבאה של שומר הדשבורד (כל חצי שעה)",BO&&BO.at?"הלוח עודכן "+hm(BO.at):""],win:"עכשיו",foot:"GitHub Actions",
   dots:BL?'<span class="dots">'+BL.map(o=>'<span class="s-'+o.st[0]+'" title="'+esc(o.he+": "+o.st[1])+'"></span>').join("")+"</span>":"",
   att:bad.length?{prio:7,ratio:.5,text:"בוטים: "+bad.slice(0,3).map(o=>o.he+" ("+o.st[1]+")").join(", ")+(bad.length>3?" ועוד "+n(bad.length-3):""),short:"",w:bad.some(o=>o.st[0]==="bad")?"בוט נכשל":bad.some(o=>o.s==="off")?"בוט כבוי":"בוט באיחור"}:null,
   drill:[{h:"כל הבוטים",html:botTable(BL)}]}}};
function botTable(BL,dept){if(!BL)return note("הרשימה תתמלא אחרי הריצה הבאה של שומר הדשבורד, שרץ כל חצי שעה.");const RK={bad:0,warn:1,nodata:2,early:3,ok:4},GO=["ניטור","נתונים","גוגל","תוכן ושיווק","פריסה","אחר"];
 const L2=BL.filter(o=>!dept||o.dept===dept).slice().sort((a,b)=>RK[a.st[0]]-RK[b.st[0]]||GO.indexOf(a.gr)-GO.indexOf(b.gr)||a.he.localeCompare(b.he,"he"));
 return L2.length?'<div class="tw"><table class="t"><thead><tr><th>בוט</th><th>מתי רץ</th><th>ריצה אחרונה</th><th>מצב</th></tr></thead><tbody>'+L2.map(o=>'<tr><td class="w">'+esc(o.he)+'<small style="display:block;color:var(--muted)">'+(BD[o.f]?esc(BD[o.f]):esc(o.gr))+'</small></td><td>'+esc(o.w||every(o.p))+"</td><td>"+(o.t?(o.u&&o.u.indexOf("https://github.com/")===0?'<a href="'+esc(o.u)+'" target="_blank" rel="noopener">'+hm(o.t)+"</a>":hm(o.t)):"-")+(o.run?' <small style="color:var(--muted)">(רץ עכשיו)</small>':"")+"</td><td>"+chip(o.st[0],o.st[1])+"</td></tr>").join("")+"</tbody></table></div>":note("אין בוטים במחלקה הזאת.")}
REG.alerts24={name:"התראות ב-24 שעות",dept:"ops",def:"כמה התראות על תקלות הגיעו ב-24 השעות האחרונות, ומה הן אמרו.",how:"המבזקים של הבוטים (branch flashes): רשומות מסוג alert שלא נסגרו, ב-24 השעות האחרונות.",src:"מבזקי הבוטים",owner:"תפעול",
 calc(C){const fl=(C.d.flashes||[]),al=fl.filter(f=>f.l==="alert"&&!f.q&&Date.now()-Date.parse(f.t)<864e5);
  return {s:C.d.flashes?(al.length?"warn":"ok"):"nodata",w:al.length?n(al.length)+" התראות":"שקט",v:al.length,big:n(al.length),unit:al.length===1?"התראה":"התראות",lines:[al.length?esc(String(al[0].x||"").replace(/\s*פירוט:[\s\S]*$/,"")).slice(0,120):"אין התראות על תקלות ב-24 השעות האחרונות"],win:"24 שעות",foot:"מבזקי הבוטים",
   drill:[{h:"המבזקים האחרונים",html:flashList(fl,null,15)}]}}};
function flashList(fl,dept,k){const L=(fl||[]).filter(f=>!dept||(FDEPT[f.k]||"ops")===dept).slice(0,k||12);if(!L.length)return note("אין מבזקים.");
 return '<ul class="kv">'+L.map(f=>"<li><span>"+(f.l==="alert"||f.l==="wait"?'<span class="lv alert">●</span> ':'<span class="lv">○</span> ')+"<b>"+esc(FK[f.k]||f.k)+":</b> "+esc(String(f.x||"").replace(/\s*פירוט:[\s\S]*$/,""))+(f.u&&/^https:\/\//.test(f.u)?' <a href="'+esc(f.u)+'" target="_blank" rel="noopener">קישור</a>':"")+'<small>'+hm(f.t)+"</small></span></li>").join("")+"</ul>"}
REG.auto={name:"מה השתנה לבד",dept:"ops",def:"האזורים שבהם הבוטים רשאים לשנות דברים לבד (אוטופיילוט), ומה הם שינו לאחרונה.",how:"יומן האוטופיילוט: מצב כל אזור (פועל, בתצפית, כבוי) והשינויים האחרונים. כל שינוי נבדק אחרי שבוע ומוחזר לבד אם המדד שלו ירד.",src:"יומן האוטופיילוט",owner:"תפעול",
 calc(C){const A=C.d.auto,ZN={A:"לוח החלטות (בדיקות בזמנים קבועים)",B:"שיווק ותוכן",C:"ניסויי ניסוח",D:"הודעות באפליקציה",E:"סידור המסך",SEO:"SEO"},MD={on:["ok","פועל"],observe:["wait","בתצפית, לא משנה"],off:["cal","כבוי"]},RSx={kept:"נשאר",reverted:"הוחזר",pending:"בבדיקה"},on=A?Object.values(A.modes||{}).filter(x=>x==="on").length:null;
  return {s:A?"ref":"nodata",v:on,big:A?n(on):"-",unit:A?"אזורים פועלים מתוך "+n(Object.keys(ZN).length):"",lines:[A?Object.keys(ZN).filter(z=>(A.modes||{})[z]==="on").map(z=>ZN[z]).join(", ")||"אף אזור לא פועל":"אין עדיין יומן שינויים",A&&A.rows&&A.rows.length?"שינוי אחרון: "+esc(A.rows[0].x||"").slice(0,100):""],win:A&&A.at?"עודכן "+dm(String(A.at).slice(0,10)):"",foot:"אוטופיילוט",
   drill:[A?{h:"מצב כל אזור",html:'<ul class="kv">'+Object.keys(ZN).map(z=>{const m=MD[(A.modes||{})[z]]||MD.off;return kv(ZN[z],chip(m[0],z==="E"&&(A.modes||{})[z]!=="on"?"לא אושר עדיין":m[1]))}).join("")+"</ul>"}:null,
    A?{h:"שינויים אחרונים",html:(A.rows||[]).length?'<ul class="kv">'+A.rows.slice(0,12).map(r=>kv("<b>"+esc(ZN[r.z]||r.z||"")+":</b> "+(r.m==="observe"?"היה משנה: ":r.m==="on"?"שינה: ":"")+esc(r.x||"")+(RSx[r.r]?' <span class="note">('+RSx[r.r]+")</span>":""),r.d?dm(r.d):"")).join("")+"</ul>":note("עוד לא היו שינויים.")}:null]}}};
REG.active28={name:"משתמשים באפליקציה ב-28 ימים",dept:"strategy",def:"כמה מכשירים בישראל השתמשו באפליקציה ב-28 הימים האחרונים. הדרך למנוי PRO: מפעילים מנוי בתשלום רק עם 2,000 עד 3,000 משתמשים בחודש.",how:"גוגל אנליטיקס, משתמשים פעילים בישראל, 28 ימים עד אתמול, מול יעד תוכנית השיווק להיום.",src:"גוגל אנליטיקס",owner:"אסטרטגיה",
 calc(C){const A=C.W&&C.W.app,mau=A?A[2].activeUsers:null,GA=goal("app_active_28d",C.td),s=mau==null?"nodata":C.cal?"cal":band(mau,GA,false,true);
  return {s,v:mau,big:n(mau),unit:mau!=null?"מתוך "+n(PRO_MAU)+" בדרך ל-PRO":"",gl:mau!=null?n(mau/GA[1]*100)+"% מהיעד להיום ("+n(GA[1])+")":"",gp:mau!=null?mau/GA[1]:0,lines:["היעד להיום: "+n(GA[1])+" (טווח "+n(GA[0])+" עד "+n(GA[2])+")",A?"מכשירים בחו\"ל, לא נספרים: "+n(A[2].abroadActive):""],win:rng(C.W&&C.W.M),foot:"גוגל אנליטיקס",
   meter:mau!=null?'<div class="meter s-'+s+'"><i style="width:'+Math.max(1,Math.min(100,mau/PRO_MAU*100))+'%"></i></div>':"",
   drill:[A?{h:"לפי גוגל אנליטיקס",html:'<ul class="kv">'+kv("משתמשים ב-28 ימים",n(A[2].activeUsers))+kv("משתמשים השבוע",n(A[0].activeUsers)+' <small class="flat">(שבוע קודם '+n(A[1].activeUsers)+")</small>")+kv("פתחו את האפליקציה השבוע (מכשירים)",n(A[0].totalUsers))+"</ul>"}:null]}}};
REG.subs={name:"נרשמים למגזין",dept:"strategy",def:"כמה אנשים נרשמו למגזין של לוחית מאז 1.10.",how:"גוגל אנליטיקס, אישורי הרשמה (newsletter_confirm) מ-1.10, מול יעד תוכנית השיווק להיום.",src:"גוגל אנליטיקס",owner:"אסטרטגיה",
 calc(C){const mo=C.W&&C.W.money,v=mo?mo.subscribers:null,GN=goal("subscribers_total",C.td),s=v==null?"nodata":C.cal?"cal":band(v,GN,false,true);
  return {s,v,big:n(v),unit:v!=null?"נרשמים":"",gl:v!=null?n(v/GN[1]*100)+"% מהיעד להיום ("+n(GN[1])+")":"",gp:v!=null?v/GN[1]:0,lines:["היעד להיום: "+n(GN[1])+" (טווח "+n(GN[0])+" עד "+n(GN[2])+")"],win:"מ-1.10",foot:"גוגל אנליטיקס"}}};
REG.leads={name:"פניות עסקיות",dept:"strategy",def:"כמה פניות עסקיות הגיעו מהאתר מאז 1.10. לפניות אין יעד עד שמתחילים למכור.",how:"גוגל אנליטיקס, האירוע b2b_lead_submit מ-1.10.",src:"גוגל אנליטיקס",owner:"אסטרטגיה",
 calc(C){const mo=C.W&&C.W.money,v=mo?mo.leads:null;return {s:v==null?"nodata":"ref",v,big:n(v),unit:v!=null?"פניות":"",lines:["אין יעד עד שמתחילים למכור"],win:"מ-1.10",foot:"גוגל אנליטיקס"}}};
REG.installedNow={name:"מותקנת עכשיו",dept:"strategy",def:"על כמה מכשירים בישראל האפליקציה מותקנת עכשיו (הערכה).",how:"Google Play מוסר את מספר המכשירים ביום האחרון שדוחותיו הגיעו; מאז נוספות ההתקנות החדשות פחות ההסרות לפי גוגל אנליטיקס.",src:"Google Play, גוגל אנליטיקס",owner:"אסטרטגיה",
 calc(C){const v=C.inst;return {s:v==null?"nodata":"ref",v,big:v==null?"-":(C.instMin?"לפחות ":"בערך ")+n(v),unit:v!=null?"מכשירים":"",lines:[C.instHow||"אין נתון","כולל הטלפונים שלך ושל הבודקים"],win:"עכשיו",foot:"הערכה"}}};
// the usage table (every action GA4 counted in the two weeks), for the product department
function usageTable(C){const ev=C.ev,E0=C.E0,E1=C.E1,ge=C.ge,W=C.W;if(!ev)return note("אין נתון מגוגל אנליטיקס.");
 const all=[...new Set([...Object.keys(E0||{}),...Object.keys(E1||{})])].filter(k=>k&&k!=="(not set)"&&(ge(E0,k)||ge(E1,k))).sort((a,b)=>(AUTO[a]?1:0)-(AUTO[b]?1:0)||ge(E0,b)-ge(E0,a)||ge(E1,b)-ge(E1,a)),rows=all.filter(k=>!AUTO[k]).slice(0,14),more=all.filter(k=>!rows.includes(k)),unk=all.filter(k=>!N[k]&&!AUTO[k]);
 const E28=W.e28,wk=(o,p)=>o[p].slice(21).reduce((x,y)=>x+y,0),split=k=>{const o=E28&&E28[k];if(!o)return "";const a=wk(o,"a"),w=wk(o,"w");return a&&w?'<small class="flat" style="display:block">באפליקציה '+n(a)+", באתר "+n(w)+"</small>":!a&&w?'<small class="flat" style="display:block">באתר</small>':""};
 const lab=k=>N[k]||(AUTO[k]?'<span class="flat">'+AUTO[k]+"</span>":esc(k)+' <small class="flat">(חדש, עוד בלי שם)</small>'),trs=a=>a.map(k=>'<tr><td class="w">'+lab(k)+split(k)+'</td><td class="n">'+n(ge(E0,k))+'</td><td class="n">'+n(ge(E1,k))+"</td></tr>").join("");
 return '<div class="tw"><table class="t"><thead><tr><th>פעולה</th><th class="n">השבוע</th><th class="n">שבוע קודם</th></tr></thead><tbody>'+trs(rows)+"</tbody></table></div>"+(more.length?'<details><summary class="note" style="cursor:pointer">עוד '+n(more.length)+' פעולות</summary><div class="tw"><table class="t"><tbody>'+trs(more)+"</tbody></table></div></details>":"")+(unk.length?note(n(unk.length)+" פעולות עוד בלי שם בדשבורד, כנראה מגרסה חדשה. הן נספרות, והשם יתווסף."):"")}

// the bottom line (the same rule as the old page: health, pages and the store always, the four plan goals once the base week is over)
function verdict(C){["checks","health","google","pages","shares","installs","store","slow","bots","crashes","saves"].forEach(k=>M(C,k));
 const t1=C.R.checks,H=C.R.health,att=C.att.slice().sort((x,y)=>RANK[x.s]-RANK[y.s]||x.ratio-y.ratio||x.prio-y.prio);
 const judged=["health","pages","store"].concat(C.cal?[]:["checks","google","shares","installs"]).map(k=>C.M[k]);
 const vs=judged.includes("bad")?"bad":judged.includes("nodata")?"nodata":judged.includes("warn")?"warn":judged.includes("ok")?"ok":C.cal?"cal":"early";
 const head=t1.L==null?"אין עדיין נתון על בדיקות רכב השבוע.":t1.tg?"השבוע: "+n(t1.L)+" בדיקות רכב, "+n(t1.L/t1.tg*100)+"% מהיעד.":"השבוע: "+n(t1.L)+" בדיקות רכב"+(t1.Lp!=null?", "+(t1.L>t1.Lp?n(t1.L-t1.Lp)+" יותר מהשבוע הקודם":t1.L<t1.Lp?n(t1.Lp-t1.L)+" פחות מהשבוע הקודם":"כמו בשבוע הקודם"):"")+".";
 const first=att.find(x=>x.short),mid=first?first.short+".":H.s==="ok"?"אין מה לטפל בו.":"";
 const tail=H.s==="ok"?"השירות תקין.":H.s==="warn"?n1(H.v)+"% מהבדיקות נכשלו, מעט מעל הרגיל.":H.s==="bad"?n1(H.v)+"% מהבדיקות נכשלו.":H.s==="early"?"מעט מדי בדיקות כדי לשפוט את תקינות השירות.":"אין נתון על תקינות השירות.";
 return {vs,att,text:[head,mid,tail].filter(Boolean).join(" ")}}
const inScope=(dept,scope)=>!scope||(DIVS[scope]?DIVS[scope].depts.indexOf(dept)>=0:dept===scope);
// what waits for Dudu: decisions (with buttons that act), his tasks (✓ בוצע), numbers that need attention, alerts of the last day
// the publishing board (Dudu 5.11.2026 18:46): what goes out and when, from calendar.json "pubs" (the calendar bot rebuilds it from the
// autopost queue with each post's outcome, the magazine's crons, and the Cowork rules for what runs on Dudu's PC); the next 7 days and
// yesterday's outcomes in the card, the week after folded
function pubBoard(C){const P=(C.d.cal&&C.d.cal.pubs)||[],td=C.td,DN=["ראשון","שני","שלישי","רביעי","חמישי","שישי","שבת"];
 const hmNow=new Date().toLocaleTimeString("en-GB",{timeZone:"Asia/Jerusalem",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
 const days=x=>Math.round((Date.parse(x+"T12:00:00Z")-Date.parse(td+"T12:00:00Z"))/864e5);
 const CH={facebook:"פייסבוק",instagram:"אינסטגרם",fb_groups:"קבוצות פייסבוק",tiktok:"טיקטוק",magazine:"מגזין",newsletter:"ניוזלטר"};
 const STL={done:["פורסם","ok"],missed:["לא עלה בזמן","bad"],failed:["נכשל","bad"],unsure:["לא ברור אם עלה","warn"],wait:["ממתין שהגרסה תגיע לכולם","warn"]};
 const past=o=>o.d<td||(o.d===td&&o.t<=hmNow);
 const L=P.filter(o=>{const k=days(o.d);return k>=-1&&k<=14&&(o.src==="auto"||!past(o))});
 const dl=d=>{const k=days(d),x=new Date(d+"T12:00:00Z");return k===0?"היום":k===1?"מחר":k===-1?"אתמול":"יום "+DN[x.getUTCDay()]+" "+x.getUTCDate()+"."+(x.getUTCMonth()+1)};
 const right=o=>{if(o.src==="cowork")return '<small>רץ במחשב שלך</small>';if(o.src==="mag")return '<small>אוטומטי</small>';
  const parts=o.ch.map(c=>{const s=(o.st||{})[c]||"planned",lab=s==="planned"?(past(o)?["ממתין לפרסום","warn"]:["מתוזמן",""]):STL[s]||["",""],nm=o.link&&o.link[c]?'<a href="'+esc(o.link[c])+'" target="_blank" rel="noopener">'+CH[c]+"</a>":(CH[c]||c);
   return {s:lab[0],c:lab[1],nm}});
  const same=parts.every(x=>x.s===parts[0].s),col=c=>c?' style="color:var(--'+c+')"':"";
  return same?'<small'+col(parts[0].c)+'>'+parts[0].s+(parts.some(x=>/<a /.test(x.nm))?": "+parts.map(x=>x.nm).join(" · "):"")+"</small>":parts.map(x=>'<small'+col(x.c)+'>'+x.nm+": "+x.s+"</small>").join(" ")};
 const row=o=>'<li><span><b>'+esc(o.t)+"</b> "+(o.src==="auto"?esc(o.ch.map(c=>CH[c]||c).join(" ו"))+" · ":"")+esc(o.what)+"</span><span>"+right(o)+"</span></li>";
 const grp=A=>{let h="",cur="";A.forEach(o=>{if(o.d!==cur){if(cur)h+="</ul>";cur=o.d;h+='<p class="note" style="margin:10px 0 2px"><b>'+dl(o.d)+'</b></p><ul class="kv">'}h+=row(o)});return h+(cur?"</ul>":"")};
 const near=L.filter(o=>days(o.d)<=7),far=L.filter(o=>days(o.d)>7),ahead=L.filter(o=>!past(o)&&days(o.d)<=7).length;
 const html=!L.length?note("אין פרסומים מתוזמנים בשבועיים הקרובים."):grp(near)+(far.length?'<details><summary class="note" style="cursor:pointer">בשבוע שאחרי ('+n(far.length)+')</summary>'+grp(far)+"</details>":"")
  +'<p class="note">פייסבוק ואינסטגרם יוצאים מתור הפרסום האוטומטי, המגזין לפי התזמון שלו, וקבוצות הפייסבוק והטיקטוק ממשימות Cowork במחשב שלך.</p>';
 return {html,sum:ahead?n(ahead)+" ב-7 הימים הקרובים":"שום דבר ב-7 הימים הקרובים"}}
const pubCard=C=>{const B=pubBoard(C);return '<section class="card"><div class="ch"><h2>לוח פרסומים</h2><small>'+esc(B.sum)+"</small></div>"+B.html+"</section>"};
function todo(C,scope){const d=C.d,Cl=d.cal,td=C.td,DN=["ראשון","שני","שלישי","רביעי","חמישי","שישי","שבת"],days=x=>Math.round((Date.parse(x+"T12:00:00Z")-Date.parse(td+"T12:00:00Z"))/864e5);
 const when=o=>{if(!o.d)return "אפשר כבר עכשיו";const x=new Date(o.d+"T12:00:00Z"),k=days(o.d),s=x.getUTCDate()+"."+(x.getUTCMonth()+1);return (k===0?"היום":k===1?"מחר":k<0?"מ-"+s:"יום "+DN[x.getUTCDay()]+" "+s)+(o.t?" ב-"+o.t:"")};
 const gcal=o=>{const st=o.d.replace(/-/g,"")+(o.t?"T"+o.t.replace(":","")+"00":""),en=o.t?(()=>{const m=+o.t.slice(0,2)*60+ +o.t.slice(3)+30;return o.d.replace(/-/g,"")+"T"+String(Math.floor(m/60)%24).padStart(2,"0")+String(m%60).padStart(2,"0")+"00"})():addD(o.d,1).replace(/-/g,"");
  return "https://calendar.google.com/calendar/render?action=TEMPLATE&text="+encodeURIComponent("לוחית: "+o.what)+"&dates="+st+"/"+en+"&ctz=Asia/Jerusalem&details="+encodeURIComponent((o.ask?o.ask+" ":"")+"https://luchit.app/live")};
 const all=Cl?[...(Cl.open||[]),...(Cl.items||[]).filter(o=>o.d>=td)]:[],me1=all.filter(o=>o.me&&o.id&&!C.done[o.id]&&inScope(ownerDept(o.owner),scope)).sort((x,y)=>(x.d||"0")+(x.t||"")<(y.d||"0")+(y.t||"")?-1:1),mine=me1.filter(o=>!o.d||days(o.d)<=7),later=me1.filter(o=>o.d&&days(o.d)>7);
 const dec=mine.filter(o=>o.ask),tasks=mine.filter(o=>!o.ask),soon=mine.filter(o=>!o.d||days(o.d)<=7),fin=all.filter(o=>o.id&&C.done[o.id]&&inScope(ownerDept(o.owner),scope));
 const att=C.att.slice().sort((x,y)=>RANK[x.s]-RANK[y.s]||x.ratio-y.ratio||x.prio-y.prio).filter(x=>inScope(REG[x.key].dept,scope));
 const al=(d.flashes||[]).filter(f=>f.l==="alert"&&!f.q&&Date.now()-Date.parse(f.t)<864e5&&inScope(FDEPT[f.k]||"ops",scope));
 const own=o=>o.owner?' <span>· '+esc(o.owner)+"</span>":"";
 const li=[];
 dec.forEach(o=>{const a=C.acts[o.id],opts=Array.isArray(o.opts)&&o.opts.length?o.opts:["מאשר","לא עכשיו"];
  li.push('<li class="dec"><div class="tag"><b>להחלטה</b><span>'+when(o)+'</span>'+own(o)+'</div><div class="what">'+esc(o.what)+'</div><small>'+esc(o.ask)+'</small><div class="btns">'+(a?'<button type="button" class="btn done" disabled>✓ '+esc(a.c)+'</button><small>נרשם '+hm(a.at)+'</small><button type="button" class="btn sec" data-unact="'+o.id+'">ביטול</button>':opts.map((x,i)=>'<button type="button" class="btn'+(i?" sec":"")+'" data-act="'+o.id+'" data-c="'+esc(x)+'">'+esc(x)+'</button>').join("")+'<button type="button" class="btn sec" data-done="'+o.id+'">✓ בוצע</button>')+(o.d?'<a href="'+gcal(o)+'" target="_blank" rel="noopener">ליומן</a>':"")+'</div></li>')});
 tasks.forEach(o=>li.push('<li><div class="tag"><b>משימה</b><span'+(o.d&&days(o.d)<=1?' style="color:var(--bad);font-weight:700"':"")+'>'+when(o)+'</span>'+own(o)+'</div><div class="what">'+esc(o.what)+'</div><div class="btns"><button type="button" class="btn" data-done="'+o.id+'">✓ בוצע</button>'+(o.d?'<a href="'+gcal(o)+'" target="_blank" rel="noopener">ליומן</a>':"")+'</div></li>'));
 att.forEach(x=>li.push('<li><div class="tag"><b class="fix">מספר</b>'+chip(x.s,x.w||(x.s==="warn"?"מעט מתחת ליעד":""))+'</div><div class="what">'+esc(x.text)+'</div><div class="btns"><a href="'+href({m:x.key})+'" data-m="'+x.key+'">לפירוט</a></div></li>'));
 al.slice(0,4).forEach(f=>li.push('<li><div class="tag"><b class="fix">התראה</b><span>'+hm(f.t)+'</span><span>· '+esc(FK[f.k]||f.k)+'</span></div><div class="what" style="font-weight:400">'+esc(String(f.x||"").replace(/\s*פירוט:[\s\S]*$/,""))+(f.u&&/^https:\/\//.test(f.u)?' <a href="'+esc(f.u)+'" target="_blank" rel="noopener">קישור</a>':"")+'</div></li>'));
 const k=dec.length+tasks.length+att.length+al.length,sum=!Cl?"היומן עוד לא זמין":k?(dec.length?n(dec.length)+" להחלטה, ":"")+(tasks.length?n(tasks.length)+" משימות, ":"")+(att.length?n(att.length)+" מספרים לתשומת לב, ":"")+(al.length?n(al.length)+" התראות":""):(later.length?"שום דבר לא מחכה השבוע":"שום דבר לא מחכה");
 const html=(li.length?'<ul class="todo">'+li.slice(0,6).join("")+"</ul>"+(li.length>6?'<details><summary class="note" style="cursor:pointer">עוד '+n(li.length-6)+' פריטים</summary><ul class="todo" style="margin-top:9px">'+li.slice(6).join("")+"</ul></details>":""):note((later.length?"אין השבוע דבר שמחכה לך":"אין כרגע דבר שמחכה לך")+(scope?" במחלקה הזאת":"")+"."))+(later.length?'<details><summary class="note" style="cursor:pointer">בהמשך, אחרי השבוע הקרוב ('+n(later.length)+')</summary><ul class="kv">'+later.map(o=>"<li><span>"+esc(o.what)+"</span><b>"+when(o)+"</b></li>").join("")+"</ul></details>":"")+(fin.length?'<details><summary class="note" style="cursor:pointer">סימנת שבוצע ('+n(fin.length)+')</summary><ul class="kv">'+fin.map(o=>"<li><span><s>"+esc(o.what)+'</s></span><b><button type="button" class="btn sec" data-undo="'+o.id+'">ביטול</button></b></li>').join("")+"</ul></details>":"");
 return {html,k,sum:sum.replace(/, $/,""),soon:soon.length}}
// a tile: the number for the window shown, its change or goal line, its status (only the week is judged)
function winOf(r,win){if(win==="m28"&&r.m28)return r.m28;if(win==="today"&&r.today)return r.today;return {big:r.big,unit:r.unit,lines:r.lines,win:r.win,noWin:win!=="week"}}
function tile(C,id,win){const r=M(C,id);if(!r)return "";const w=winOf(r,win||"week"),judged=(win||"week")==="week"||w.noWin,nm=judged?r.name:r.name.replace("בשבוע",win==="m28"?"ב-28 ימים":"היום");
 return '<a class="tile s-'+(judged?r.s:"ref")+'" href="'+href({m:id})+'" data-m="'+id+'"><span class="nm">'+esc(nm)+(w.win?' <small class="win">'+esc(w.win)+"</small>":"")+'</span><span class="bg">'+w.big+(w.unit?' <small>'+w.unit+"</small>":"")+"</span>"
 +'<span class="dl">'+(judged?(r.dl||r.gl||r.lines[0]||""):(w.lines[0]||""))+"</span>"+(r.meter||"")+'<span class="tg">'+(judged?chip(r.s,r.w)+(w.noWin?' <small class="win">אין נתון ל'+WIN[win]+"</small>":""):chip("ref",WIN[win]))+"</span>"+(r.foot?'<span class="fr">'+r.foot+"</span>":"")+"</a>"}
const tiles=(C,ids,win)=>'<div class="tiles'+(ids.length<=3?" k3":ids.length===4?" k4":ids.length===5?" k5":"")+'">'+ids.map(i=>tile(C,i,win)).join("")+"</div>";
// the weekly funnel, site and app (as the old page)
function funnel(C){const ev=C.ev;if(!ev)return note("גוגל אנליטיקס לא ענה.");const W=C.W,E0=C.E0,E1=C.E1,ge=C.ge,end=C.end,E28=W.e28,or=(a,b)=>a==null?b:a,pw=(k,i)=>{const o=E28&&E28[k];return o?o.w.slice(i?14:21,i?21:28).reduce((x,y)=>x+y,0):null};
 const site=C.wsum("site_lookup",end),siteP=C.wsum("site_lookup",addD(end,-7)),A=W.app,SV=W.savers||{},SP=W.saversP||{};
 const Sx=[["כניסות לאתר",or(pw("web_visit",0),ge(E0,"web_visit")),or(pw("web_visit",1),ge(E1,"web_visit"))],["בדיקות רכב באתר",or(pw("car_lookup",0),site),or(pw("car_lookup",1),siteP)],["לחיצות «להתקנה»",or(pw("web_install_click",0),ge(E0,"web_install_click")),or(pw("web_install_click",1),ge(E1,"web_install_click"))]];
 const AP=[["פתחו את האפליקציה",A?A[0].totalUsers||null:null,A?A[1].totalUsers||null:null],["בדקו רכב",SV.car_lookup||null,SP.car_lookup||null],["שמרו רכב",SV.car_save||0,SP.car_save||0]];
 const pcf=(a,b)=>a==null||!b?"":a>b?"פי "+n1(a/b):Math.round(a/b*100)+"%";
 const fun=(t,R,col)=>{const mx=Math.max(1,...R.map(r=>Math.max(r[1]||0,r[2]||0)));return '<div class="fun"><h4>'+t+"</h4>"+R.map((r,i)=>'<div class="fr"><span>'+r[0]+'</span><div class="bb"><i style="width:'+(r[1]?Math.max(1,r[1]/mx*100):0)+'%;--c:'+col+'" title="השבוע: '+n(r[1])+'"></i>'+(r[2]?'<i class="p" style="left:auto;right:'+Math.max(1,r[2]/mx*100)+'%" title="שבוע קודם: '+n(r[2])+'"></i>':"")+'</div><b>'+n(r[1])+'</b><span class="pc" title="מהשלב הקודם">'+(i?pcf(r[1],R[i-1][1]):"")+"</span></div>").join("")+"</div>"};
 return '<div class="g2">'+fun("באתר",Sx,"var(--site)")+fun("באפליקציה, מכשירים",AP,"var(--app)")+'</div><p class="note">האחוז הוא מהשלב הקודם; הקו האפור הוא השבוע הקודם. '+rng(W.W)+".</p>"}
// where the week's site checks came from
function srcBars(C){const r=M(C,"siteChecks"),x=r.drill&&r.drill[0];return x?x.html:note("עוד אין השבוע בדיקות באתר עם מקור ידוע.")}
function renderCeo(C){const V=verdict(C),t1=C.R.checks,w=S.w,wv=winOf(t1,w),T=todo(C,null),d=C.d;
 let h='<section class="card verdict s-'+V.vs+'">'+chip(V.vs,V.att[0]&&V.att[0].s===V.vs?V.att[0].w:"")+"<p>"+esc(V.text)+"</p><small>"+(C.ck!=null||C.instToday!=null||d.visitsToday!=null?"היום עד עכשיו: "+[C.ck!=null?"<b>"+n(C.ck)+"</b> בדיקות":"",C.instToday!=null?"<b>"+n(C.instToday)+"</b> התקנות":"",d.visitsToday!=null?"<b>"+n(d.visitsToday)+"</b> ביקורים באתר":""].filter(Boolean).join(" · "):"")+"</small></section>";
 h+='<section class="card"><div class="ch"><h2>'+(w==="week"?"בדיקות רכב בשבוע":w==="m28"?"בדיקות רכב ב-28 ימים":"בדיקות רכב היום, עד עכשיו")+'</h2><small class="win">'+esc(wv.win||"")+'</small></div><div class="hero"><a class="plate" href="'+href({m:"checks"})+'" data-m="checks" title="לפירוט">'+wv.big+'</a><div class="lines">'+(w==="week"?"<span>"+chip(t1.s,t1.w)+"</span>"+(t1.dl?"<span>"+t1.dl+"</span>":"")+(t1.gl||t1.gn?"<span>"+(t1.gl||t1.gn)+"</span>":""):"")+wv.lines.map(l=>"<span>"+l+"</span>").join("")+"</div></div>"+(w==="week"&&t1.chart?t1.chart+'<div class="lg"><span><i class="sw app"></i>אפליקציה</span><span><i class="sw site"></i>אתר</span><span><i class="sw goal"></i>היעד השבועי</span></div>':"")+"</section>";
 h+='<section class="card"><div class="ch"><h2>מה מחכה לך</h2><small>'+esc(T.sum)+"</small></div>"+T.html+"</section>";
 h+=pubCard(C);
 h+='<h2 class="sec">'+(w==="week"?"השבוע מול היעד":w==="m28"?"28 הימים האחרונים":"היום עד עכשיו")+"</h2>"+tiles(C,CEO_TILES,w);
 h+='<div class="g2"><section class="card"><div class="ch"><h2>המשפך השבועי</h2><small class="win">'+rng(C.W&&C.W.W)+"</small></div>"+funnel(C)+'</section><section class="card"><div class="ch"><h2>מאיפה הגיעו הבדיקות באתר</h2><small class="win">'+rng(C.W&&C.W.W)+"</small></div>"+srcBars(C)+'<p class="note">הפירוט לפי רשת וקישור במחלקת שיווק ותוכן.</p></section></div>';
 h+='<h2 class="sec">האגפים</h2><div class="g3">'+Object.keys(DIVS).map(k=>{const D=DIVS[k],ids=D.depts.reduce((a,p)=>a.concat(DEPTS[p].metrics),[]),st=ids.map(i=>M(C,i).s),T2=todo(C,k),worst=st.includes("bad")?"bad":st.includes("warn")?"warn":st.includes("nodata")?"nodata":"ok";
  return '<a class="card" href="'+href({v:k,m:null})+'" data-v="'+k+'"><div class="ch"><h2>'+D.name+"</h2>"+chip(worst,worst==="ok"?"תקין":"")+'</div><span class="dots">'+st.map(dot).join("")+'</span><p class="note">'+D.what+'</p><ul class="kv">'+D.depts.map(p=>{const P=DEPTS[p],r=M(C,P.metrics[0]);return kv(P.name,r.big+(r.unit?" <small>"+r.unit+"</small>":""),r.name)}).join("")+"</ul><small>"+(T2.k?n(T2.k)+" פריטים מחכים":"שום דבר לא מחכה")+"</small></a>"}).join("")+"</div>";
 h+='<section class="card"><div class="ch"><h2>שלוש השאלות של החודש</h2><small>עד 22.11 לא מוסיפים פיצ\'רים; התשובות קובעות מה בונים אחר כך'+(between(C.td,QE)>0?". נשארו "+n(between(C.td,QE))+" ימים":"")+'</small></div><div class="qs">'+[["organic","1. האם לוחית צומחת בלי דחיפה?"],["return7","2. האם רכב שמור מחזיר אנשים?"],["shareOpen","3. איפה נשבר השיתוף?"]].map(x=>{const r=M(C,x[0]);return '<a class="q" href="'+href({m:x[0]})+'" data-m="'+x[0]+'" style="text-decoration:none;color:inherit">'+chip(r.s,r.w)+"<b>"+x[1]+"</b><span>"+r.big+(r.unit?' <small class="note">'+r.unit+"</small>":"")+"</span><small>"+(r.read||"")+"</small></a>"}).join("")+"</div></section>";
 return h}
function crumb(parts){return '<nav class="crumb">'+parts.map((p,i)=>(i?"<span>›</span>":"")+(p[1]?'<a href="'+p[1]+'" data-v="'+p[2]+'">'+p[0]+"</a>":"<b>"+p[0]+"</b>")).join("")+"</nav>"}
function deptTabs(div,cur){return '<div class="tabs"><a href="'+href({v:div,m:null})+'" data-v="'+div+'"'+(cur===div?' class="on"':"")+">כל האגף</a>"+DIVS[div].depts.map(p=>'<a href="'+href({v:p,m:null})+'" data-v="'+p+'"'+(cur===p?' class="on"':"")+">"+DEPTS[p].name+"</a>").join("")+"</div>"}
const CHAIN={growth:["impressions","visits","siteChecks","installs"],product:["checks","saves","return7","shares","rating"],business:["active28","leads","subs"]};
function renderDiv(C,div){const D=DIVS[div],T=todo(C,div),w=S.w;
 let h=crumb([["מנכ״ל",href({v:"ceo",m:null}),"ceo"],[D.name]])+deptTabs(div,div);
 h+='<section class="card"><div class="ch"><h2>'+D.name+'</h2><small class="note">'+D.what+"</small></div>"+tiles(C,CHAIN[div],w)+(div==="business"?note("תשלום: מנוי PRO עוד לא נמכר. מפעילים אותו רק עם 2,000 עד 3,000 משתמשים בחודש."):"")+"</section>";
 h+='<section class="card"><div class="ch"><h2>מה מחכה באגף</h2><small>'+esc(T.sum)+"</small></div>"+T.html+"</section>";if(div==="growth")h+=pubCard(C);
 h+='<h2 class="sec">המחלקות</h2><div class="'+(D.depts.length>=3?"g3":"g2")+'">'+D.depts.map(p=>{const P=DEPTS[p],st=P.metrics.map(i=>M(C,i).s),worst=st.includes("bad")?"bad":st.includes("warn")?"warn":st.includes("nodata")?"nodata":"ok",T2=todo(C,p);
  return '<a class="card" href="'+href({v:p,m:null})+'" data-v="'+p+'"><div class="ch"><h2>'+P.name+"</h2>"+chip(worst,worst==="ok"?"תקין":"")+'</div><span class="dots">'+st.map(dot).join("")+'</span><ul class="kv">'+P.metrics.slice(0,3).map(i=>{const r=M(C,i);return kv(r.name,r.big+(r.unit?" <small>"+r.unit+"</small>":""))}).join("")+"</ul><small>"+(T2.k?n(T2.k)+" פריטים מחכים":"שום דבר לא מחכה")+"</small></a>"}).join("")+"</div>";
 if(C.BL&&C.BL.some(o=>inScope(o.dept,div)))h+='<section class="card"><div class="ch"><h2>הבוטים של האגף</h2></div>'+botTable(C.BL.filter(o=>inScope(o.dept,div)))+"</section>";
 return h}
function renderDept(C,dept){const P=DEPTS[dept],D=DIVS[P.div],T=todo(C,dept),w=S.w;
 let h=crumb([["מנכ״ל",href({v:"ceo",m:null}),"ceo"],[D.name,href({v:P.div,m:null}),P.div],[P.name]])+deptTabs(P.div,dept);
 h+='<section class="card"><div class="ch"><h2>'+P.name+'</h2><small class="win">'+(w==="week"?rng(C.W&&C.W.W):WIN[w])+"</small></div>"+tiles(C,P.metrics,w)+"</section>";
 h+='<section class="card"><div class="ch"><h2>מה מחכה במחלקה</h2><small>'+esc(T.sum)+"</small></div>"+T.html+"</section>";if(dept==="marketing")h+=pubCard(C);
 const X={marketing:["campChecks","visits"],seo:["google","pages"],release:["saves","return7","shareOpen"],data:["health","siteChecks"],ops:["auto"],strategy:["active28","installs"]}[dept]||[];
 const secs=[];X.forEach(id=>{const r=M(C,id);(r.drill||[]).filter(Boolean).forEach(x=>secs.push('<section class="card"><div class="ch"><h2>'+x.h+'</h2><small class="win">'+esc(r.name)+"</small></div>"+x.html+"</section>"))});
 if(dept==="release")secs.unshift('<section class="card"><div class="ch"><h2>פעולות באפליקציה ובאתר</h2><small class="win">'+rng(C.W&&C.W.W)+"</small></div>"+usageTable(C)+"</section>");
 if(secs.length)h+='<h2 class="sec">פירוט</h2><div class="g2">'+secs.join("")+"</div>";
 if(C.BL&&C.BL.some(o=>o.dept===dept))h+='<section class="card"><div class="ch"><h2>הבוטים של המחלקה</h2></div>'+botTable(C.BL,dept)+"</section>";
 if((C.d.flashes||[]).some(f=>(FDEPT[f.k]||"ops")===dept))h+='<section class="card"><div class="ch"><h2>מבזקים</h2></div>'+flashList(C.d.flashes,dept,10)+"</section>";
 return h}
// the drill-down panel: the number, its change and goal, its history, its breakdown, and how it is defined and computed
function openDrill(C,id){const r=M(C,id);if(!r)return;const P=$("panel"),m=r.m;P.hidden=false;$("shade").hidden=false;document.body.style.overflow="hidden";
 P.innerHTML='<div class="ph"><div class="r1"><div><h2>'+esc(r.name)+'</h2><span class="note">'+(m.dept?DEPTS[m.dept].name+" · "+DIVS[DEPTS[m.dept].div].name:"המדד הראשי")+'</span></div><button type="button" class="tbtn" data-close="1" aria-label="סגירה">✕ סגירה</button></div><div class="r2">'+chip(r.s,r.w)+'<span style="font-size:30px;font-weight:700">'+r.big+"</span>"+(r.unit?'<span class="note">'+r.unit+"</span>":"")+(r.win?'<span class="win">'+esc(r.win)+"</span>":"")+"</div></div>"
 +'<div class="pb">'+(r.read?"<section><h3>מה זה אומר</h3><p>"+r.read+"</p></section>":"")
 +'<section><h3>המספר</h3><ul class="kv">'+(r.dl?kv("מול השבוע הקודם",r.dl):"")+(r.gl?kv("מול היעד",r.gl):r.gn?kv("יעד",r.gn):"")+r.lines.map(l=>"<li><span>"+l+"</span></li>").join("")+"</ul></section>"
 +(r.chart?"<section><h3>השבועות האחרונים</h3>"+r.chart+'<div class="lg"><span><i class="sw app"></i>אפליקציה</span><span><i class="sw site"></i>אתר</span><span><i class="sw goal"></i>יעד</span></div></section>':"")
 +(r.m28||r.today?'<section><h3>בחלונות אחרים</h3><ul class="kv">'+(r.m28?kv("28 ימים"+(r.m28.win?" ("+esc(r.m28.win)+")":""),r.m28.big+(r.m28.unit?" <small>"+r.m28.unit+"</small>":"")):"")+(r.today?kv("היום עד עכשיו",r.today.big+(r.today.unit?" <small>"+r.today.unit+"</small>":"")):"")+"</ul></section>":"")
 +(r.drill||[]).filter(Boolean).map(x=>"<section><h3>"+x.h+"</h3>"+x.html+"</section>").join("")
 +'<section><h3>הגדרה</h3><p class="help">'+esc(m.def)+'</p></section><section><h3>איך מחושב</h3><p class="help">'+esc(m.how)+'</p></section><section><ul class="kv">'+kv("מקור",esc(m.src))+kv("אחראי",esc(m.owner))+"</ul></section></div>";
 P.scrollTop=0;S.m=id;sync()}
function closeDrill(){$("panel").hidden=true;$("shade").hidden=true;document.body.style.overflow="";if(S.m){S.m=null;sync()}}

// the state in the address: v = the lens (ceo, a division or a department), w = the window, m = an open metric
const S={v:"ceo",w:"week",m:null};
function readURL(){const q=new URLSearchParams(location.search),v=q.get("v")||"",w=q.get("w")||"",m=q.get("m")||"";S.v=v==="ceo"||DIVS[v]||DEPTS[v]?v:"ceo";S.w=WIN[w]?w:"week";S.m=REG[m]?m:null}
function href(o){const v=o.v||S.v,w=o.w||S.w,m=o.m!==undefined?o.m:S.m;return "?v="+v+"&w="+w+(m?"&m="+m:"")}
function sync(){try{history.replaceState(null,"",location.pathname+href({}))}catch(e){}}
function renderNav(){const dv=DEPTS[S.v]?DEPTS[S.v].div:S.v;
 $("lens").innerHTML=[["ceo","מנכ״ל"]].concat(Object.keys(DIVS).map(k=>[k,DIVS[k].short])).map(x=>'<a href="'+href({v:x[0],m:null})+'" data-v="'+x[0]+'"'+(dv===x[0]?' class="on" aria-current="page"':"")+">"+x[1]+"</a>").join("");
 $("wins").innerHTML=Object.keys(WIN).map(k=>'<button type="button" data-w="'+k+'"'+(S.w===k?' class="on" aria-pressed="true"':' aria-pressed="false"')+">"+WIN[k]+"</button>").join("")}
function render(){const d=window.LVD;if(!d)return;const C=ctx(d);window.LVC=C;renderNav();
 let h;try{h=S.v==="ceo"?renderCeo(C):DIVS[S.v]?renderDiv(C,S.v):renderDept(C,S.v)}catch(e){h='<section class="card"><p>המסך לא הצליח להיבנות: '+esc(e&&e.message||e)+"</p></section>"}
 $("main").innerHTML=h+'<footer class="foot"><span>גרסה '+esc(d.build||"")+'</span><span>'+(d.at?"הנתונים מ-"+hm(d.at):"")+'</span><span>כל השעות בשעון ישראל. השבוע: 7 ימים עד אתמול. יעדים: תוכנית השיווק כפול שבוע הבסיס.</span><a href="/live/v1" rel="nofollow">המסך הקודם</a></footer>';
 if(S.m)openDrill(C,S.m)}
async function go(){const meta=$("meta");try{const r=await fetch("/live/data",{cache:"no-store",signal:AbortSignal.timeout?AbortSignal.timeout(35e3):undefined});if(!r.ok)throw r.status;const d=await r.json();window.LVD=d;render();
 const tm=new Date(d.at).toLocaleTimeString("he-IL",{timeZone:"Asia/Jerusalem",hour:"2-digit",minute:"2-digit"});onl(d.online,d.stale,d.at);
 meta.className="meta"+(d.stale||d.late?" stale":"");meta.innerHTML='<span class="dot"></span>'+(d.late?"נתונים מ-"+tm+": השרת לא ענה בזמן, ננסה שוב בעוד דקה":d.stale?"נתונים ישנים מ-"+tm+", גוגל הגביל זמנית את מספר הבקשות":"עודכן "+tm)}
 catch(e){meta.className="meta stale";meta.innerHTML='<span class="dot"></span>'+(e===504?"השרת לא ענה בזמן, ננסה שוב בעוד דקה":"אין חיבור")+(window.LVD?". מוצגים הנתונים האחרונים":"");if(!window.LVD)$("main").innerHTML='<section class="card"><p>הנתונים לא הגיעו. המסך ינסה שוב בעוד דקה.</p></section>'}}
function onl(o,stale,at){const e=$("onl");if(!o){if(!window.lastOnl)e.hidden=true;return}window.lastOnl=o;e.hidden=false;const tm=at?new Date(at).toLocaleTimeString("he-IL",{timeZone:"Asia/Jerusalem",hour:"2-digit",minute:"2-digit"}):"";e.innerHTML='<span><i class="pd"></i> מחוברים עכשיו:</span><span><b>'+n(o.app)+"</b> באפליקציה</span><span><b>"+n(o.web)+'</b> באתר</span><small>5 הדקות האחרונות'+(stale?", נתון אחרון שנשמר":"")+(tm?" · "+tm:"")+"</small>"}
async function now(){try{const r=await fetch("/live/now",{cache:"no-store",signal:AbortSignal.timeout?AbortSignal.timeout(15e3):undefined});if(!r.ok)return;const j=await r.json();onl(j.online,j.stale,j.at)}catch(e){}}
// a press on "בוצע" or on a decision reaches the project at once (the same KV the bots read), and the screen shows it before the server's copy catches up
async function post(url,body){const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});if(!r.ok)throw r.status;return r.json()}
document.addEventListener("click",async e=>{const t=e.target;
 const m=t.closest("[data-m]");if(m){e.preventDefault();if(window.LVC)openDrill(window.LVC,m.getAttribute("data-m"));return}
 if(t.closest("[data-close]")||t===$("shade")){closeDrill();return}
 const v=t.closest("[data-v]");if(v){e.preventDefault();S.v=v.getAttribute("data-v");S.m=null;sync();render();window.scrollTo(0,0);return}
 const w=t.closest("[data-w]");if(w){S.w=w.getAttribute("data-w");sync();render();return}
 const b=t.closest("[data-done],[data-undo],[data-act],[data-unact]");if(!b)return;b.disabled=true;
 try{if(b.hasAttribute("data-done")||b.hasAttribute("data-undo")){const id=b.getAttribute("data-done")||b.getAttribute("data-undo"),on=b.hasAttribute("data-done");const j=await post("/live/cal",{id,done:on});calLocal[id]=on?(j.done&&j.done[id])||new Date().toISOString():0;if(window.LVD)window.LVD.calDone=j.done||window.LVD.calDone}
  else{const id=b.getAttribute("data-act")||b.getAttribute("data-unact"),on=b.hasAttribute("data-act");const j=await post("/live/act",on?{id,c:b.getAttribute("data-c")}:{id,undo:true});actLocal[id]=on?(j.acts&&j.acts[id])||{c:b.getAttribute("data-c"),at:new Date().toISOString()}:0;if(window.LVD)window.LVD.acts=j.acts||window.LVD.acts}
  render()}
 catch(err){b.disabled=false;b.textContent="לא נשמר, נסו שוב";b.classList.add("sec")}});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!$("panel").hidden)closeDrill()});
let lastGo=Date.now();const tick=()=>{if(document.hidden)return;if(Date.now()-lastGo>=59e3){lastGo=Date.now();go()}else now()};
readURL();go();setInterval(tick,30000);document.addEventListener("visibilitychange",()=>{if(!document.hidden){lastGo=Date.now();go()}});
window.addEventListener("popstate",()=>{readURL();render()});
</script></body></html>
`;
export default {
  // every 10 minutes, whether or not anyone has the screen open: keep the realtime tally going (realtime covers only 30 minutes). Until
  // live-31 the tally saw only the minutes /live was open: on 20.10 it held 188 of the day's 286 first opens. Just after midnight the run
  // also keeps yesterday's last minutes.
  async scheduled(ev, env, ctx) {
    const now = Date.now(), today = ilDay(now), before = ilDay(now - 30 * 6e4);
    await rtToday(env, today).catch(() => {});
    if (before !== today) await rtToday(env, before).catch(() => {});
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!(await verifyAccess(req, env).catch(() => false))) return new Response("forbidden", { status: 403, headers: HEAD });
    if (url.pathname === "/live/cal" && req.method === "POST") return calMark(req, env);
    if (url.pathname === "/live/act" && req.method === "POST") return actMark(req, env);
    if (url.pathname === "/live/data") return liveData(env, ctx);
    if (url.pathname === "/live/now") {
      try { return json({ online: await onlineNow(env), at: new Date(onlAt).toISOString() }); }
      catch (e) { if (/ 429/.test(String(e.message))) backoffUntil = Date.now() + 300e3; return onl ? json({ online: onl, at: new Date(onlAt).toISOString(), stale: true }) : json({ error: "unavailable" }, 502); }
    }
    if (url.pathname === "/live/v1" || url.pathname === "/live/v1/") return new Response(PAGE, { headers: { ...HEAD, "content-type": "text/html; charset=utf-8" } });   // the screen before 3.11.2026, kept for a while
    if (url.pathname === "/live" || url.pathname === "/live/" || url.pathname === "/live/v2" || url.pathname === "/live/v2/") return new Response(PAGE2, { headers: { ...HEAD, "content-type": "text/html; charset=utf-8" } });
    return new Response("not found", { status: 404, headers: HEAD });
  }
};
