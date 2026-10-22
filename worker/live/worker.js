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
const BUILD = "live-34";   // shown in /live/data so the running version is visible
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
  const [evs, fails, links, hist, app, money, src, pages, saveU, bySrc, ret, appS] = await Promise.all([
    safe(report(env, { dateRanges: [dr(W), dr(P), dr(M)], dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: REAL, limit: 250 }), "ga4 week"),
    safe(report(env, { dateRanges: [dr(W), dr(P)], dimensions: [{ name: "customEvent:kind" }], metrics: [{ name: "eventCount" }], dimensionFilter: withReal(only("lookup_failed")), limit: 20 }), "ga4 failures"),
    safe(report(env, { dateRanges: [dr(W), dr(P)], dimensions: [{ name: "eventName" }, { name: "customEvent:kind" }, { name: "customEvent:via" }], metrics: [{ name: "eventCount" }], dimensionFilter: withReal(any(["link_landing", "link_open", "referral_open"])), limit: 200 }), "ga4 shared links"),
    safe(report(env, { dateRanges: [{ startDate: histFrom, endDate: end }], dimensions: [{ name: "date" }], metrics: [{ name: "eventCount" }], dimensionFilter: withReal(only("car_lookup")), limit: 1000 }), "ga4 history"),
    safe(report(env, { dateRanges: [dr(W), dr(P), dr(M)], dimensions: [{ name: "countryId" }], metrics: [{ name: "newUsers" }, { name: "activeUsers" }], dimensionFilter: { filter: { fieldName: "platform", stringFilter: { value: "Android" } } }, limit: 250 }), "ga4 app"),
    safe(report(env, { dateRanges: [{ startDate: "2026-10-01", endDate: "today" }], dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: any(["b2b_lead_submit", "newsletter_confirm"]) }), "ga4 money"),
    safe(cfTop(env, CW[0], "refererHost", CW[1], 100), "site week sources"), safe(cfTop(env, CW[0], "requestPath", CW[1], 12, "count_DESC"), "site week pages"),
    safe(report(env, { dateRanges: [dr(W)], dimensions: [{ name: "eventName" }], metrics: [{ name: "totalUsers" }], dimensionFilter: { andGroup: { expressions: [APP, any(["car_lookup", "car_save"])] } } }), "ga4 app savers"),
    // without the src field the site is one row, "unknown", rather than no table at all
    safe(srcRows(), "ga4 sources"),
    // the month's questions: each day's new installs from 1.36 on (first_open by app version), their saves on the install day and their returns
    // on days 1 to 7, both by install day (kind); and new app devices by the link that brought them to the store (google-play = found in the store)
    end >= Q_FROM ? safe(report(env, { dateRanges: [{ startDate: Q_FROM, endDate: end }], dimensions: [{ name: "date" }, { name: "eventName" }, { name: "appVersion" }, { name: "customEvent:n" }, { name: "customEvent:kind" }], metrics: [{ name: "eventCount" }],
      dimensionFilter: { andGroup: { expressions: [APP, any(["first_open", "first_save", "app_return"])] } }, limit: 5000 }), "ga4 return") : null,
    safe(report(env, { dateRanges: [dr(W), dr(P)], dimensions: [{ name: "firstUserSource" }, { name: "firstUserCampaignName" }], metrics: [{ name: "newUsers" }], dimensionFilter: APP, limit: 250 }), "ga4 app sources")]);
  const ri = r => { const v = r.dimensionValues[r.dimensionValues.length - 1].value; return /^date_range_\d$/.test(v) ? Number(v.slice(-1)) : 0; };
  const ev = [{}, {}, {}];
  for (const r of evs || []) ev[ri(r)][r.dimensionValues[0].value] = [Number(r.metricValues[0].value), Number(r.metricValues[1].value)];
  const fk = [{}, {}];
  for (const r of fails || []) fk[ri(r)][r.dimensionValues[0].value] = Number(r.metricValues[0].value);
  // arrivals from a shared report or comparison: web landings and app opens whose link carried s=img|full|pdf|txt|qr, or a comparison link.
  // Not arrivals: campaign links (counted apart), the "open in the app" bar and "copy the link" of a page already open (s=bar, s=copy: the
  // same visit going on, kept as bar) and the first launch after an install from a shared link (referral_open: the landing before it counted)
  const shared = [{ web: 0, app: 0, bar: 0, inst: 0, by: {} }, { web: 0, app: 0, bar: 0, inst: 0, by: {} }];
  for (const r of links || []) {
    const [name, kind, via] = r.dimensionValues.map(x => x.value), c = Number(r.metricValues[0].value), o = shared[ri(r)];
    if (name === "referral_open") { o.inst += c; continue; }
    if (kind === "campaign") continue;
    if (via === "bar" || via === "copy") { o.bar += c; continue; }
    const k = kind === "cmp" ? "cmp" : via && via !== "none" && via !== "(not set)" ? via : null;
    if (!k) continue;
    o[name === "link_landing" ? "web" : "app"] += c; o.by[k] = (o.by[k] || 0) + c;
  }
  // first opens (new devices) and active devices of the app, in Israel and abroad (abroad is mostly Google's pre-launch test devices)
  const appU = [0, 1, 2].map(i => { const o = { newUsers: 0, activeUsers: 0, abroadNew: 0, abroadActive: 0 };
    for (const r of app || []) if (ri(r) === i) { const il = r.dimensionValues[0].value === "IL"; o[il ? "newUsers" : "abroadNew"] += Number(r.metricValues[0].value); o[il ? "activeUsers" : "abroadActive"] += Number(r.metricValues[1].value); }
    return o; });
  const m = {}; for (const r of money || []) m[r.dimensionValues[0].value] = Number(r.metricValues[0].value);
  // site visits (web_visit, once per opening of the page) and car checks (site and app) by where the visit came from, this week [0] and the
  // week before [1]: { bucket: [visits, checks] }; byCamp the same for visits that came by a tagged link with a topic: { "source|topic": [visits, checks] }
  // srcSeen: the week has site rows with a measured source (from 20.10), so its site rows can be compared with another week's
  const bs = [{}, {}], srcSeen = [false, false], bc = [{}, {}], tagged = v => v && v !== "(not set)";
  for (const r of bySrc || []) { const [pf, so, cp, name] = r.dimensionValues.map(x => x.value), i = ri(r), k = srcBucket(pf, so), j = name === "car_lookup" ? 1 : 0, c = Number(r.metricValues[0].value);
    (bs[i][k] ||= [0, 0])[j] += c; if (k !== "app" && k !== "unknown") srcSeen[i] = true;
    if (pf === "web" && tagged(cp) && k !== "share" && k !== "site") (bc[i][k + "|" + cp] ||= [0, 0])[j] += c; }
  // { install day: [new installs from 1.36, saved a car that day, came back on days 1-7 having saved, having not] }
  const coh = {};
  for (const r of ret || []) { const [dt, name, ver, nv, kind] = r.dimensionValues.map(x => x.value), c = Number(r.metricValues[0].value), day = name === "first_open" ? iso8(dt) : /^\d\d-\d\d$/.test(kind || "") ? Q_FROM.slice(0, 5) + kind : kind;
    if (!/^\d{4}-\d\d-\d\d$/.test(day || "")) continue; const o = coh[day] ||= [0, 0, 0, 0];
    if (name === "first_open") { if (v136(ver)) o[0] += c; } else if (name === "first_save") o[1] += c; else o[nv === "1" ? 2 : 3] += c; }
  // new app devices by the link that brought them to the store: all, found in the store (google-play), and by tagged link and topic ("source|topic")
  const aSrc = [{ store: 0, all: 0, camp: {} }, { store: 0, all: 0, camp: {} }];
  for (const r of appS || []) { const o = aSrc[ri(r)], c = Number(r.metricValues[0].value), so = String(r.dimensionValues[0].value).toLowerCase(), cp = String(r.dimensionValues[1].value).toLowerCase();
    o.all += c; if (so === "google-play") o.store += c; else if (tagged(so) && so !== "(direct)" && so !== "luchit.app" && tagged(cp) && cp !== "(direct)" && cp !== "(organic)" && cp !== "car_share") o.camp[so + "|" + cp] = (o.camp[so + "|" + cp] || 0) + c; }
  const fresh = { errors, end, W, P, M, CW, ev: evs ? ev : null, fails: fails ? fk : null, shared: links ? shared : null,
    days: hist ? Object.fromEntries(hist.map(r => { const d = r.dimensionValues[0].value; return [d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6), Number(r.metricValues[0].value)]; })) : null,
    app: app ? appU : null, savers: saveU ? Object.fromEntries(saveU.map(r => [r.dimensionValues[0].value, Number(r.metricValues[0].value)])) : null, money: money ? { leads: m.b2b_lead_submit || 0, subscribers: m.newsletter_confirm || 0 } : null, sources: src, pages, bySource: bySrc ? bs : null, srcSeen: bySrc ? srcSeen : null, byCamp: bySrc ? bc : null, coh: ret ? coh : null, appSrc: appS ? aSrc : null };
  // the last good numbers stand in for a part that failed, but only for the same week (a new week starts clean)
  weekly = keep(fresh, weekly && weekly.end === end ? weekly : null, ["ev", "fails", "shared", "days", "app", "savers", "money", "sources", "pages", "bySource", "srcSeen", "byCamp", "coh", "appSrc"]);
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
// alerts go only through the router, so without it the card stopped at 16.10. A router alert of the same kind within 10 minutes of a
// flash.mjs item is the same news and is left out. l: alert = a failure, wait = asks for the owner's decision, info = news only.
const RKIND = k => { const f = String(k).split(":")[0];
  return /^(review|review3|vitals|reviews)$/.test(f) ? "reviews" : /^(ship|listing|watch|safety|prod)$/.test(f) ? "release"
    : /^(guard|ministry|checker|truth|catalog|stl)$/.test(f) ? "data" : /^(seo|seo-auto|mention|mag)$/.test(f) ? "content" : "infra"; };
// shadow entries (sh 1): the caller sent as td says; routed ones: the router sent it, or handed it back to the caller's own send
const RSENT = e => e.sh === 1 ? e.td !== "none" : ["loud", "night", "remind", "remind-night"].includes(e.a) || (["legacy", "failed"].includes(e.a) && e.td !== "none");
let flashes = null, flashesAt = 0, flRaw = [], stRaw = null;
async function getFlashes() {
  if (flashes && Date.now() - flashesAt < 300e3) return flashes;
  const get = async path => { try { const r = await fetch("https://raw.githubusercontent.com/ddsabag/vehicle-app/" + path, { cf: { cacheTtl: 120 }, signal: AbortSignal.timeout(8e3) }); return r.ok ? await r.json() : null; } catch { return null; } };
  const [fl, st] = await Promise.all([get("flashes/flashes.json"), get("alert-state/state.json")]);   // a failed read keeps the last good one
  if (Array.isArray(fl)) flRaw = fl;
  if (st && Array.isArray(st.log)) stRaw = st;
  const own = flRaw.filter(f => f && f.t && f.x), at = f => Date.parse(f.t);
  const routed = stRaw ? stRaw.log.filter(e => e && e.he && e.t && RSENT(e)).map(e => {
    const u = ((stRaw.items || {})[e.k] || {}).u, link = Array.isArray(u) && typeof u[0] === "string" && u[0].startsWith("https://") ? u[0] : "";
    return { t: e.t, k: RKIND(e.k), l: e.sc === "fail" ? "alert" : e.sc === "wait" ? "wait" : "info", x: e.he, ...(link ? { u: link } : {}) };
  }).filter(r => !own.some(f => f.k === r.k && Math.abs(at(f) - at(r)) < 600e3)) : [];
  flashes = [...own, ...routed].sort((a, b) => at(b) - at(a)).slice(0, 30);
  flashesAt = Date.now(); return flashes;
}

const slimMetrics = m => { const x = m && m.index; return x ? { index: { indexed: x.indexed, crawledNotIndexed: x.crawledNotIndexed, inspected: x.inspected, total: x.total, at: x.at } } : {}; };
// aggregate numbers published by the workflows (branch "flashes", metrics.json), e.g. how many pages Google reports as indexed
let metrics = null, metricsAt = 0;
async function getMetrics() {
  if (metrics && Date.now() - metricsAt < 300e3) return metrics;
  try { const r = await fetch("https://raw.githubusercontent.com/ddsabag/vehicle-app/flashes/metrics.json", { cf: { cacheTtl: 120 } }); metrics = r.ok ? await r.json() : (metrics || {}); } catch { metrics = metrics || {}; }
  metricsAt = Date.now(); return metrics;
}

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
async function collect(env) {
  // GA4 realtime has an hourly token quota: answer from cache for a minute, and after a 429 stop asking for 5 minutes (serve the last good numbers)
  if (cache && (Date.now() - cacheAt < 60e3 || Date.now() < backoffUntil)) return cache;
  const today = ilDay(Date.now()), yday = addDays(today, -1);
  const errors = {};
  const safe = (p, k) => p.catch(e => { errors[k] = String(e.message || e).slice(0, 200); return null; });
  // a Worker request may make only 50 outside calls: get the token once, before the parallel calls, or each of them fetches its own
  await googleToken(env).catch(() => {});
  // realtime: events, and active users by platform (the app's devices in Israel, and the site, where every opening of the page is its own "user")
  const [events, plats, vToday, vYday, dly, sc, wk, ps, rl, pls, tz, rt, rty] = await Promise.all([
    safe(realtime(env, { dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: REAL, limit: 40 }), "events"),
    safe(realtime(env, { dimensions: [{ name: "platform" }], metrics: [{ name: "activeUsers" }], dimensionFilter: REAL }), "platforms"),
    safe(cfVisits(env, today), "visitsToday"), safe(cfVisits(env, yday), "visitsYesterday"), safe(collectDaily(env), "daily"), safe(collectSeo(env, today), "seo"),
    safe(collectWeekly(env, today), "weekly"), playStatus(), playRelease(env), playStats(env, today), gaTimeZone(env), safe(rtToday(env, today), "today"), safe(rtKept(env, yday), "yesterday tally")]);
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
    events: events ? events.map(r => [r.dimensionValues[0].value, Number(r.metricValues[0].value)]).sort((a, b) => b[1] - a[1]) : (quota ? prev.events ?? null : null),
    rtToday: rt ?? (quota ? prev.rtToday ?? null : null), rtYday: rty ?? prev.rtYday ?? null, visitsToday: vToday?.visits ?? null, visitsYesterday: vYday?.visits ?? null,
    // a collector that failed as a whole (no token) falls back to the last numbers it had; each carries its own dates
    seo: strip(sc || seo), daily: strip(dly || daily), weekly: strip(wk || weekly), play: ps, playAt: playSeen, release: rl, stats: pls, gaTz: tz };
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
table.t{width:100%;border-collapse:collapse;font-size:.86rem}.t th{font-weight:500;color:var(--muted);font-size:.74rem;text-align:right;padding:2px 6px 5px}.t td{text-align:right;padding:6px;border-top:1px solid var(--line);vertical-align:top}.t td.n,.t th.n{width:5.5rem;font-variant-numeric:tabular-nums;white-space:nowrap}.t td.w{word-break:break-word}.tg td.n,.tg th.n{width:auto}.tg th.n{white-space:normal}.tg td.w{min-width:8.5rem;word-break:normal}
.kv{list-style:none;margin:0;padding:0}.kv li{display:grid;grid-template-columns:1fr auto;gap:10px;padding:6px 0;border-top:1px solid var(--line);font-size:.86rem}.kv li:first-child{border-top:0}.kv b{font-variant-numeric:tabular-nums;text-align:right}.kv small{display:block;color:var(--muted);font-size:.74rem}.pg small{display:block;color:var(--muted);font-size:.74rem;font-weight:400}.t small{font-size:.74rem}
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
<div class="card trend"><h2>בדיקות רכב, שבוע אחרי שבוע</h2><div id="tr"></div><p class="note" id="trn"></p></div>
</section>

<section class="drs">
<details class="card dr" id="dr-now"><summary><b>עכשיו</b><span>מי פעיל ברגע זה ומה קרה היום</span></summary><ul class="kv" id="now"></ul><p class="note">נתוני היום חלקיים: גוגל אנליטיקס מעדכן אותם בעיכוב של שעה עד כמה שעות.</p></details>
<details class="card dr" id="dr-q"><summary><b>שאלות החודש</b><span>שלוש השאלות שיקבעו מה בונים אחרי 22.11, ואיפה כל אחת עומדת</span></summary><div id="q"></div></details>
<details class="card dr" id="dr-goal"><summary><b>יעדים לשנה</b><span>איפה אנחנו מול היעד, עד אוקטובר 2027</span></summary><div id="goal"></div></details>
<details class="card dr" id="dr-src"><summary><b>מקורות</b><span>מאיפה מגיעים אנשים: פייסבוק, וואטסאפ, טיקטוק, יוטיוב, גוגל ועוד, לאתר ולאפליקציה</span></summary><div id="src"></div></details>
<details class="card dr" id="dr-use"><summary><b>שימוש</b><span>מה אנשים עושים, וכמה מכשירים יש לאפליקציה</span></summary><div id="use"></div></details>
<details class="card dr" id="dr-web"><summary><b>האתר</b><span>מאיפה נכנסו לאתר, והדפים שהכי נצפו</span></summary><div id="web"></div></details>
<details class="card dr" id="dr-seo"><summary><b>חיפוש בגוגל</b><span>חיפושים, דפים והופעות בתוצאות</span></summary><div id="seo"></div></details>
<details class="card dr" id="dr-fl"><summary><b>מבזקים</b><span>ההתראות שנשלחו לטלגרם, בקצרה, מהחדשה לישנה</span></summary><ul class="kv fl" id="fl"></ul><p class="note">● תקלה, או בקשה להחלטה שלך. ○ מידע בלבד. כשיש תקלה אני מטפל בה בשגרה, ופונה אליך רק כשנדרשת החלטה שלך.</p></details>
<details class="card dr" id="dr-tec"><summary><b>טכני</b><span>כשלים לפי סיבה, קריסות ומקורות שלא ענו</span></summary><div id="tec"></div></details>
</section>

<p class="foot">מקורות: גוגל אנליטיקס (אפליקציה ואתר), Cloudflare (ביקורים באתר), Search Console (חיפוש בגוגל) ו-Google Play (דף האפליקציה, Play Console ודוחות ההתקנות). לכל מספר מצוינים התאריכים שלו, כי לכל מקור יש איחור אחר. הדף מתרענן כל דקה. <span id="build"></span></p>
<p class="foot" id="er"></p>
</main>
<script>
/* Business dashboard. Spec: Claude Doc "לוחית: אפיון דשבורד מנהלים", sections 3 (targets) and 4 (traffic light). */
const CAL_END="2026-11-02";        // until the base week 26.10-1.11 is over, only health, Google pages and the store get a colour
const SITE_FROM="2026-10-15";      // car checks on the site are counted from this day (the app's from the start)
// Yearly goals from the CMO plan (reports/marketing-goals-2026-10.json): per month [cons, base, opt], the weekly figure or level expected in the
// month's last week, Nov 2026 to Oct 2027. Colour vs base: at or above base ok, between cons and base warn, below cons bad (failures: lower is better).
// Between month ends the target moves in a straight line; "from" gives a starting point where one is known, otherwise the first month holds before it.
const GOALS={first:"2026-11",k:{weekly_checks:[[160,190,240],[190,240,330],[250,330,490],[270,380,600],[320,470,800],[360,550,990],[430,680,1310],[500,820,1670],[560,970,2080],[640,1150,2600],[690,1290,3050],[740,1430,3540]],installs_week:[[30,40,50],[35,50,70],[50,70,105],[50,75,120],[60,90,155],[65,100,185],[75,125,245],[85,145,300],[95,165,360],[105,190,435],[105,200,480],[105,210,525]],google_clicks_week:[[4,5,6],[7,9,13],[11,15,23],[15,22,36],[22,33,57],[29,45,83],[37,60,117],[47,80,165],[60,105,228],[74,135,308],[84,160,383],[95,190,475]],pages_indexed:[[100,120,150],[110,150,180],[120,165,200],[130,180,220],[140,195,240],[145,210,255],[150,220,265],[155,230,275],[160,240,285],[165,250,295],[170,260,300],[175,270,305]],share_per_100:[[2,3,4],[3,4,5],[3,4,6],[3,5,7],[4,6,8],[4,6,9],[4,7,9],[5,7,10],[5,8,11],[5,9,12],[6,9,13],[6,10,14]],app_active_28d:[[110,150,190],[150,200,280],[210,300,450],[240,350,550],[290,430,730],[330,510,900],[410,650,1200],[480,780,1510],[540,910,1860],[620,1080,2300],[670,1200,2650],[720,1320,3030]],failures_pct:[[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5],[3,2,1.5]],subscribers_total:[[5,15,45],[10,30,90],[20,50,150],[30,70,210],[35,90,270],[50,120,360],[60,150,450],[80,200,600],[100,250,750],[120,300,900],[140,350,1050],[160,400,1200]]},
 from:{weekly_checks:["2026-10-25",170],google_clicks_week:["2026-10-14",0],pages_indexed:["2026-10-17",90],app_active_28d:["2026-10-18",23],subscribers_total:["2026-10-01",0]},
 calib:{key:"weekly_checks",end:"2026-11-01",model:174,lo:.5,hi:2}};   // weekly car checks scale by r = actual week 26.10-1.11 / 174, the plan's line on 1.11 (0.5 to 2). Not the launch week 19-25.10: its posts would set every later target (decided 20.10)
const SUBMITTED="2026-10-17";      // production access requested in Play Console
const PRO_MAU=2000;
const N={car_lookup:"בדיקת רכב",car_save:"שמירת רכב ברשימה",share:"שיתוף (דוח רכב או השוואה)",compare_open:"השוואת רכבים",tab_view:"מעבר בין לשוניות",link_out:"לחיצה על קישור חיצוני",alerts_toggle:"הדלקה או כיבוי של התראות",alert_kind:"בחירת סוג התראה",upgrade_open:"פתיחת חלונית המנוי (PRO)",voice_search:"חיפוש בקול",bulk_check:"בדיקת כמה רכבים יחד",camera_scan:"סריקת לוחית במצלמה",buy_card_open:"פתיחת כרטיס בלשונית קנייה",settlement_shown:"הצגת הסדר פשרה",checklist_pdf:"הורדת רשימת בדיקה",doc_add:"הוספת מסמך לרכב",simple_view:"מעבר לתצוגה פשוטה",search_no_result:"חיפוש דגם בלי תוצאה",user_screenshot:"צילום מסך",first_open:"התקנה חדשה (פתיחה ראשונה)",lookup_repeat:"פתיחה חוזרת של רכב (רענון)",notif_open:"פתיחת התראה מהטלפון",notif_sent:"התראה שנשלחה לטלפון",web_hint_click:"לחיצה על הצעה להתקין מהאתר",web_install_click:"מעבר מהאתר להתקנה",calendar_reminder_click:"הוספת תזכורת ליומן",link_landing:"כניסה לאתר מקישור",link_open:"פתיחת קישור באפליקציה",web_visit:"כניסה לאתר",referral_open:"פתיחה ראשונה אחרי התקנה מקישור ששותף",share_open:"פתיחת חלון השיתוף",nav:"מעבר בתפריט התחתון",cars_mode:"החלפת תצוגה ברכבים שלי",alert_item:"לחיצה על פריט במסך ההתראות",road_docs:"פתיחת מסמכים לנסיעה",history_pdf:"הפקת דוח היסטוריה (PDF)",mine_set:"פתיחת תיק לרכב שלי",mine_unset:"ביטול סימון הרכב שלי",car_unsave:"הסרת רכב מהרכבים שלי",first_save:"שמירת רכב ראשונה (ביום ההתקנה)",app_return:"חזרה לאפליקציה בשבוע הראשון",zombie_shown:"הצגת רכב שירד מהכביש וחזר",lookup_from_cache:"הצגת בדיקה שמורה (בלי חיבור)",buy_step_done:"סימון שלב ברשימת הקנייה",check_open:"פתיחת סעיף ברשימת הבדיקה",simple_more:"הרחבה בתצוגה הפשוטה",calendar_reminder_shown:"הצגת הצעה לתזכורת ביומן",car_nick:"כינוי לרכב",web_install_prompt:"הצגת הצעה להתקין (באתר)",svc_add:"רישום טיפול לרכב",svc_cal:"הטיפול הבא ליומן",trial_start:"התחלת ניסיון PRO",trial_end_shown:"הודעת סוף ניסיון PRO",upgrade_purchase_start:"התחלת רכישת PRO",update_prompt:"הצעה לעדכן גרסה",update_start:"התחלת עדכון גרסה",update_done:"התקנת עדכון גרסה"};
const KIND={source_down:"משרד התחבורה לא ענה",offline:"לא התקבלה תשובה (חיבור או זמן המתנה)",not_found:"מספר שלא קיים (הוקלד לא נכון)",net_err:"החיבור למאגרי משרד התחבורה נכשל",js_err:"תקלה בקוד שלנו בזמן הבדיקה","(not set)":"לא ידוע"};
const FK={data:"נתונים",infra:"תשתית",content:"תוכן",release:"שחרור",experiment:"ניסוי",reviews:"ביקורות"};
const VIA={img:"תמונה",full:"תמונה מלאה",pdf:"PDF",txt:"טקסט",cmp:"השוואה"};
const ST={ok:["תקין","✓"],warn:["דורש תשומת לב","!"],bad:["מתחת ליעד","✕"],early:["מוקדם לשפוט","…"],nodata:["אין נתון","?"],cal:["יעד מ-"+Number(CAL_END.slice(8))+"."+Number(CAL_END.slice(5,7)),"·"],wait:["ממתין","…"]};

const $=i=>document.getElementById(i);
const n=x=>x==null||!isFinite(x)?"-":Math.round(x).toLocaleString("en-US");
const n1=x=>x==null||!isFinite(x)?"-":(Math.round(x*10)/10).toLocaleString("en-US");
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
const CB=GOALS.calib,cw=days&&end>=CB.end?week(CB.end):null,RC=cw?Math.min(CB.hi,Math.max(CB.lo,cw/CB.model)):1;   // calibration of weekly car checks
const nsGoal=e=>!days||e<CAL_END?null:goal("weekly_checks",e,RC),nsTarget=e=>{const g=nsGoal(e);return g?g[1]:null};
const M={},att=[];
const push=(key,s,prio,ratio,text,short,w)=>{M[key]=s;if(RANK[s]!=null)att.push({s,prio,ratio,text,short,w})};

// 1. weekly car checks (north star)
let t1;{const L=ev?ge(E0,"car_lookup"):null,Lp=ev?ge(E1,"car_lookup"):null,G=end?nsGoal(end):null,tg=G?G[1]:null;let s;
// a previous week that began before SITE_FROM has no (or only some) site checks: the change is the app's alone
const BS=W&&W.bySource,mix=W&&W.W&&addD(W.W[0],-7)<SITE_FROM,La=BS&&BS[0].app?BS[0].app[1]:null,Lpa=BS&&BS[1].app?BS[1].app[1]:null,app1=mix&&La!=null&&Lpa!=null;
if(!ev)s="nodata";else if(cal)s="cal";else{s=band(L,G,false,true);if(s==="ok"&&(app1?Lpa>=30&&La<.8*Lpa:Lp>=30&&L<.8*Lp))s="warn"}
push("ns",s,1,tg?L/tg:1,"בדיקות רכב: "+n(L)+(tg?", היעד "+n(tg):""),s==="nodata"?"חסר נתון מגוגל אנליטיקס":"הבדיקות מתחת ליעד");
const l1=!ev?"גוגל אנליטיקס לא ענה":tg?n(L/tg*100)+"% מהיעד ("+n(tg)+", טווח "+n(G[0])+" עד "+n(G[2])+")":"שבוע הבסיס הוא "+rng([addD(CB.end,-6),CB.end])+", ולפיו ייקבע היעד";
const l2=!mix?delta(L,Lp):app1?"באפליקציה: "+delta(La,Lpa)+". את האתר עוד אי אפשר להשוות, הוא נספר מ-"+dm(SITE_FROM):"";
t1={s,title:"בדיקות רכב בשבוע",big:n(L),lines:[l1,l2],foot:rng(W&&W.W)+" · אפליקציה ואתר",L,Lp,tg}}

// 2. Google clicks, with pages Google knows under it
let t2;{const S=d.seo,c=S&&S.cur,a=c?Math.round(c.clicks):null,sd=S&&S.range?S.range[1]:null,GC=goal("google_clicks_week",sd),exp=GC?GC[1]:null;let s;
if(!c)s="nodata";else if(cal)s="cal";else if(exp<2)s="early";else s=band(a,GC,false,true);
push("clicks",s,2,exp?a/exp:1,"כניסות מגוגל: "+n(a)+(exp>=1?", היעד "+n(exp):""),s==="nodata"?"חסר נתון מ-Search Console":"הכניסות מגוגל מתחת ליעד");
// pages
const X=d.metrics&&d.metrics.index,today=new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Jerusalem"}),GP2=goal("pages_indexed",today),pexp=GP2[1];let ps;
// pages come into Google in batches, so a few pages short of the line (3, or 5% of it) is yellow, not red
if(!X||X.indexed==null||Date.now()-Date.parse(X.at)>48*3600e3)ps="nodata";else{ps=band(X.indexed,GP2,false,false);if(ps==="bad"&&X.indexed>=pexp-Math.max(3,pexp*.05))ps="warn"}
push("pages",ps,3,X&&pexp?X.indexed/pexp:1,"דפים שמופיעים בגוגל: "+(X?n(X.indexed):"-")+", היעד "+n(pexp),ps==="nodata"?"חסר נתון על הדפים בגוגל":"פחות דפים בגוגל מהיעד");
const imps=c?Math.round(c.imps):null,ip=S&&S.prev?Math.round(S.prev.imps):null;
t2={s,title:"כניסות מגוגל בשבוע",big:n(a),lines:[c?gtxtN("google_clicks_week",GC,sd):"Search Console לא ענה","הופענו בתוצאות החיפוש "+n(imps)+" פעמים"+(ip!=null?" (שבוע קודם "+n(ip)+")":""),
 'דפים שמופיעים בגוגל: <b>'+(X?n(X.indexed):"-")+"</b>"+(X?" מתוך "+n(X.total||X.inspected)+" באתר":"")+" "+mini(ps)],foot:(S&&S.range?rng(S.range):"")+" · גוגל מוסר באיחור של 3 ימים"}}

// 3. arrived from a share
let t3;{const GS=goal("share_per_100",end||new Date().toISOString().slice(0,10)),Lw=ge(E0,"car_lookup"),Sw=ge(E0,"share"),Lm=ge(E2,"car_lookup"),Sm=ge(E2,"share"),sh=W&&W.shared;let rate=null,win="",s;
if(!ev)s="nodata";else{if(Lw>=100){rate=Sw/Lw*100;win=rng(W.W)}else if(Lm>=100){rate=Sm/Lm*100;win=rng(W.M)+" (28 ימים, עד שיש 100 בדיקות בשבוע)"}
 if(rate==null)s="early";else if(cal)s="cal";else s=band(rate,GS,false,false)}
push("share",s,4,rate!=null?rate/GS[1]:1,"שיתופים: "+n1(rate)+" לכל 100 בדיקות, היעד "+n1(GS[1]),s==="nodata"?"חסר נתון על שיתופים":"מעט שיתופים");
const arr=sh?sh[0].web+sh[0].app:null,arrp=sh?sh[1].web+sh[1].app:null;
t3={s,rate,title:"שיתופים לכל 100 בדיקות",big:!ev?"-":rate!=null?(rate>=10?n(rate):n1(rate)):n(Sw),unit:!ev||rate!=null?"":"שיתופים",lines:[!ev?"גוגל אנליטיקס לא ענה":rate!=null?gtxt(GS):"עוד מעט מדי בדיקות כדי לחשב: "+n(Sw)+" שיתופים מתוך "+n(Lw)+" בדיקות","נכנסו מקישור ששותף: <b>"+n(arr)+"</b>"+(arrp!=null?" (שבוע קודם "+n(arrp)+")":""),sh&&sh[0].inst?"התקינו את האפליקציה מקישור ששותף: <b>"+n(sh[0].inst)+"</b>":""],foot:(win||rng(W&&W.W))+" · אפליקציה ואתר"}}

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
let t4;{const A=W&&W.app,a=A?A[0].newUsers:null,ap=A?A[1].newUsers:null,live=d.play==="live",GI=goal("installs_week",end),tg=live&&!cal&&GI?GI[1]:null;let s;
if(a==null)s="nodata";else if(!live)s="early";else if(cal)s="cal";else s=band(a,GI,false,true);
push("installs",s,5,tg?a/tg:1,"התקנות חדשות: "+n(a)+(tg?", היעד "+n(tg):""),s==="nodata"?"חסר נתון על התקנות":"מעט התקנות");
push("store",GP.s,0,0,"Google Play: הגרסה החדשה נדחתה בבדיקה של גוגל. הסיבה במייל ובקונסול","גרסה חדשה נדחתה בבדיקה של גוגל","נדחתה");
t4={s,title:"התקנות חדשות בשבוע",big:n(a),lines:[delta(a,ap),instToday!=null?"היום עד עכשיו: <b>"+(instTodayMin&&instToday>0?"לפחות ":"")+n(instToday)+"</b> התקנות חדשות (לא נכללות בשבוע)":"",inst!=null?"מותקנת עכשיו בסך הכול: <b>"+(instMin?"לפחות ":"בערך ")+n(inst)+'</b> מכשירים בישראל (הערכה, <a href="#dr-use" data-open="dr-use">איך מחושב</a>)':"",GP.s!=="ok"||GP.txt.indexOf("·")>=0?"Google Play: "+GP.txt+(!live&&!top&&d.play==="review"?" (הבקשה הוגשה "+dm(SUBMITTED)+")":""):"",tg?n(a/tg*100)+"% מהיעד ("+n(tg)+", טווח "+n(GI[0])+" עד "+n(GI[2])+")":live?"":"עד שהאפליקציה בחנות, מתקינים רק בודקים"],foot:rng(W&&W.W)+", שבוע שלם עד אתמול · התקנה = פתיחה ראשונה של האפליקציה, בישראל"}}

// health: failures caused by us or the ministry, out of all attempts (a mistyped plate is not a failure)
let H;{const fk=W&&W.fails?W.fails[0]:null,tech=fk?(fk.source_down||0)+(fk.offline||0)+(fk.net_err||0)+(fk.js_err||0):null,att2=ev?ge(E0,"car_lookup")+ge(E0,"lookup_failed"):null;let s,r=null;
const GF=goal("failures_pct",end||new Date().toISOString().slice(0,10));
if(!fk||!ev)s="nodata";else if(att2<50)s="early";else{r=tech/att2*100;s=band(r,GF,true);if(s==="bad"&&tech<5)s="warn"}
push("health",s,0,r!=null?GF[1]/Math.max(r,.01):1,"בדיקות שנכשלו: "+n1(r)+"%, היעד עד "+n1(GF[1])+"%","",s==="bad"?"יותר מדי כשלים":s==="warn"?"מעט יותר כשלים":"");
H={s,r,tech,att:att2}}

// verdict
att.sort((x,y)=>RANK[x.s]-RANK[y.s]||x.ratio-y.ratio||x.prio-y.prio);
const judged=["health","pages","store"].concat(cal?[]:["ns","clicks","share","installs"]).map(k=>M[k]);
const vs=judged.includes("bad")?"bad":judged.includes("nodata")?"nodata":judged.includes("warn")?"warn":judged.includes("ok")?"ok":cal?"cal":"early";
const head=t1.L==null?"אין עדיין נתון על בדיקות רכב השבוע.":t1.tg?"השבוע: "+n(t1.L)+" בדיקות רכב, "+n(t1.L/t1.tg*100)+"% מהיעד.":"השבוע: "+n(t1.L)+" בדיקות רכב"+(t1.Lp!=null?", "+(t1.L>t1.Lp?n(t1.L-t1.Lp)+" יותר מהשבוע הקודם":t1.L<t1.Lp?n(t1.Lp-t1.L)+" פחות מהשבוע הקודם":"כמו בשבוע הקודם"):"")+".";
const first=att.find(x=>x.short);const mid=first?first.short+".":H.s==="ok"?"אין מה לטפל בו.":"";
const tail=H.s==="ok"?"השירות תקין.":H.s==="warn"?n1(H.r)+"% מהבדיקות נכשלו, מעט מעל הרגיל.":H.s==="bad"?n1(H.r)+"% מהבדיקות נכשלו.":H.s==="early"?"מעט מדי בדיקות כדי לשפוט את תקינות השירות.":"אין נתון על תקינות השירות.";
$("vd").className="card verdict s-"+vs;$("vh").innerHTML=chip(vs,att[0]&&att[0].s===vs?att[0].w:"")+'<span class="lbl">השורה התחתונה</span>';$("vs").textContent=[head,mid,tail].filter(Boolean).join(" ");
$("vn").textContent=cal?"שבוע הבסיס הוא "+rng([addD(CB.end,-6),CB.end])+": לפיו ייקבע היעד לבדיקות רכב, ומ-"+dm(CAL_END)+" כל מספר יקבל צבע מול היעד שלו. עד אז יש צבע רק לתקינות השירות, לדפים בגוגל ולחנות. בדיקות מהאתר נספרות מ-15.10.":"";

// attention list
const alerts=(d.flashes||[]).filter(f=>f.l==="alert"&&Date.now()-Date.parse(f.t)<864e5).length;
$("att").innerHTML=(att.length?att.slice(0,4).map(x=>"<li>"+chip(x.s,x.w||(x.s==="warn"?"מעט מתחת ליעד":""))+"<span>"+esc(x.text)+"</span></li>").join(""):'<li class="none">אין כרגע דבר שדורש תשומת לב.</li>')+(alerts?'<li><span class="chip s-warn"><i aria-hidden="true">!</i>מבזקים</span><span>'+(alerts===1?"התראה אחת על תקלה":n(alerts)+" התראות על תקלות")+' ב-24 השעות האחרונות. <a href="#dr-fl" data-open="dr-fl">לפירוט</a></span></li>':"");

// tiles
const tile=t=>'<article class="card tile s-'+t.s+'"><div class="th"><h3>'+t.title+"</h3>"+chip(t.s)+'</div><div class="big">'+t.big+(t.unit?"<small>"+t.unit+"</small>":"")+"</div>"+t.lines.filter(Boolean).map((l,i)=>'<p class="'+(i?"m":"")+'">'+l+"</p>").join("")+'<p class="foot">'+t.foot+"</p></article>";
$("tiles").innerHTML=[t1,t2,t3,t4].map(tile).join("");

// milestones
{const A=W&&W.app,mau=A?A[2].activeUsers:null,mo=W&&W.money,pt=hm(d.playAt),td=new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Jerusalem"}),GA=goal("app_active_28d",td),GN=goal("subscribers_total",td);
$("ms").innerHTML='<li><span class="k">Google Play</span><span class="v">'+GP.txt+(GP.s==="ok"&&GP.txt.indexOf("·")<0?" ✓":"")+'</span><span class="k">'+[top?"הגרסה האחרונה: "+esc(top.name||"")+" ("+(RS[top.state]||["מצב לא ידוע"])[0]+", לפי Play Console"+(RL.at?", נבדק ב-"+hm(RL.at):"")+").":RL&&d.play!=="live"?"אחרי אישור הבקשה צריך ליצור גרסה לחנות, ואז יופיע כאן אם היא בבדיקה, אושרה או נדחתה.":"",d.play!=="live"&&!(top||RL)?"הבקשה הוגשה ב-"+dm(SUBMITTED)+". אישור Google מגיע במייל ובקונסול; כאן הסטטוס מתחלף כשהאפליקציה מופיעה בחנות לכולם.":"",!top&&(d.play==="live"||!RL)?(pt?"דף החנות הציבורי נבדק ב-"+pt+".":"דף החנות הציבורי נבדק כל שעה."):""].filter(Boolean).join(" ")+"</span></li>"
+'<li><span class="k">הדרך למנוי PRO: משתמשים באפליקציה בישראל ב-28 הימים האחרונים</span><span class="v">'+n(mau)+" מתוך "+n(PRO_MAU)+'</span><div class="bar" role="img" aria-label="'+n(mau)+" מתוך "+n(PRO_MAU)+'"><i style="width:'+Math.max(1,Math.min(100,(mau||0)/PRO_MAU*100))+'%"></i></div><span class="k">'+(mau!=null&&!cal?mini(band(mau,GA,false,true))+" ":"")+"מנוי בתשלום מפעילים רק כשיש 2,000 עד 3,000 משתמשים בחודש. היעד להיום: "+n(GA[1])+" (טווח "+n(GA[0])+" עד "+n(GA[2])+").</span></li>"
+'<li><span class="k">פניות עסקיות ונרשמים למגזין (מ-1.10)</span><span class="v">'+(mo?n(mo.leads)+" פניות עסקיות · "+n(mo.subscribers)+" נרשמים למגזין":"אין נתון")+'</span><span class="k">'+(mo&&!cal?mini(band(mo.subscribers,GN,false,true))+" ":"")+"היעד להיום: "+n(GN[1])+" נרשמים (טווח "+n(GN[0])+" עד "+n(GN[2])+"). לפניות עסקיות אין יעד עד שמתחילים למכור."+'</span></li>'}

// trend: weekly totals, up to 8 weeks, oldest on the left so the latest week sits next to the right edge; weeks before the first counted
// check are left out (they would read as a drop to zero)
{const box=$("tr");if(!days||!end){box.innerHTML='<p class="note">אין עדיין נתון היסטורי מגוגל אנליטיקס.</p>';$("trn").textContent=""}else{
const ends=[];for(let i=7;i>=0;i--)ends.push(addD(end,-7*i));while(ends.length>2&&!week(ends[0]))ends.shift();
const k=ends.length,vals=ends.map(week),tgs=ends.map(nsTarget),mx=Math.max(1,...vals,...tgs.filter(Boolean))*1.18;
const X0=12,SW=616/k,BW=Math.min(64,SW*.62),H=150,Y=v=>H-v/mx*(H-28);let g='<line class="t-base" x1="12" x2="628" y1="'+H+'" y2="'+H+'"/>';
ends.forEach((e,i)=>{const x=X0+i*SW,cx=x+SW/2,v=vals[i],y=Y(v);g+='<rect class="t-bar" x="'+(cx-BW/2)+'" y="'+y+'" width="'+BW+'" height="'+(H-y)+'" rx="4"/><text class="t-val" x="'+cx+'" y="'+(y-6)+'" text-anchor="middle">'+n(v)+'</text><text class="t-lbl" x="'+cx+'" y="'+(H+18)+'" text-anchor="middle">עד '+dm(e)+"</text>";
 if(tgs[i])g+='<line class="t-goal" x1="'+(cx-BW/2-6)+'" x2="'+(cx+BW/2+6)+'" y1="'+Y(tgs[i])+'" y2="'+Y(tgs[i])+'"/>';
 // the label stands on the later side of the line (the weeks it speaks of), unless it would run off the chart
 if(addD(e,-6)<="2026-10-15"&&e>="2026-10-15")g+='<line class="t-mark" x1="'+(x+4)+'" x2="'+(x+4)+'" y1="16" y2="'+H+'"/><text class="t-lbl" x="'+(x+112<636?x+8:x-4)+'" y="12" text-anchor="'+(x+112<636?"start":"end")+'">מכאן נספר גם האתר</text>'});
box.innerHTML='<svg viewBox="0 0 640 176" direction="ltr" style="direction:ltr" role="img" aria-label="בדיקות רכב בשבוע: '+vals.map(n).join(", ")+'">'+g+"</svg>";
$("trn").textContent="כל עמודה היא שבוע, ומתחתיה היום שבו הסתיים. הקו המקווקו הוא היעד השבועי"+(cal?", והוא יופיע מהשבוע שאחרי שבוע הבסיס ("+rng([addD(CB.end,-6),CB.end])+").":".")}}

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
const R=[["weekly_checks","בדיקות רכב בשבוע",t1.L,end,RC],["installs_week","התקנות חדשות בשבוע",Ad?Ad[0].newUsers:null,end],["google_clicks_week","כניסות מגוגל בשבוע",S2?Math.round(S2.clicks):null,d.seo&&d.seo.range?d.seo.range[1]:td],
 ["pages_indexed","דפים שמופיעים בגוגל",X2?X2.indexed:null,td],["share_per_100","שיתופים לכל 100 בדיקות",t3.rate,end],["app_active_28d","משתמשים באפליקציה ב-28 ימים",Ad?Ad[2].activeUsers:null,td],
 ["failures_pct","אחוז הבדיקות שנכשלו",H.r,end,1,true],["subscribers_total","נרשמים למגזין",mo?mo.subscribers:null,td]];
// counts in whole numbers, rates with one decimal
const nx=[0,2,5,11].map(i=>MONTHS[i]),RATE={share_per_100:1,failures_pct:1};
// a goal that has a tile above gets the tile's status, so the two never disagree
const TK={weekly_checks:"ns",installs_week:"installs",google_clicks_week:"clicks",pages_indexed:"pages",share_per_100:"share",failures_pct:"health"};
$("goal").innerHTML='<div style="overflow-x:auto"><table class="t tg"><thead><tr><th>מדד</th><th class="n">עכשיו</th><th class="n">היעד להיום</th>'+nx.map((m,i)=>'<th class="n">סוף '+mname(m,i===nx.length-1)+"</th>").join("")+"</tr></thead><tbody>"
+R.map(([k,l,v,day,r,lower])=>{const g=goal(k,day||td,k==="weekly_checks"?r:1),tk=TK[k],st=tk&&M[tk]?M[tk]:cal?"cal":band(v,g,lower,!lower),gf=RATE[k]?n1:x=>x>0&&x<1?"פחות מ-1":n(x);return '<tr><td class="w">'+l+'</td><td class="n">'+gf(v)+(st==="cal"?"":" "+mark(st))+'</td><td class="n">'+gf(g&&g[1])+'</td>'+nx.map(m=>'<td class="n">'+gf(goal(k,mEnd(m),k==="weekly_checks"?r:1)[1])+"</td>").join("")+"</tr>"}).join("")+"</tbody></table></div>"
+'<p class="note">היעדים מתוכנית השיווק, בתרחיש הבסיס (בלי פרסום בתשלום). ✓ ירוק: ביעד או מעליו. ! צהוב: קצת מתחת ליעד, אבל מעל התרחיש הזהיר. ✕ אדום: מתחת לתרחיש הזהיר. בין סוף חודש לסוף החודש הבא היעד עולה בהדרגה. בבדיקות שנכשלו, נמוך יותר טוב. '+(cw?"יעד בדיקות הרכב הותאם לשבוע הבסיס ("+rng([addD(CB.end,-6),CB.end])+"): היו בו "+n(cw)+" בדיקות מול "+n(CB.model)+" שהתוכנית הניחה, וכל יעדי הבדיקות הותאמו באותו יחס.":"עד שייגמר שבוע הבסיס ("+rng([addD(CB.end,-6),CB.end])+") רוב השורות בלי צבע, ויעד בדיקות הרכב ייקבע סופית לפיו.")+'</p>'}

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
{const BC=W&&W.byCamp,AC=W&&W.appSrc&&W.appSrc[0]&&W.appSrc[0].camp,cv=BC?BC[0]:{},ks=[...new Set([...Object.keys(cv),...Object.keys(AC||{})])],ins=k=>AC&&AC[k]||0,ck=k=>(cv[k]||[0,0])[1];
const TOP={bio:"קישור בביו",post:"פוסט",message:"הודעה",magazine:"גיליון המגזין",article:"כתבה",qr:"קוד QR",dealer:"סוחר",market:"פוסט על השוק",offroad:"פוסט על רכבים שירדו מהכביש",one_line:"פוסט בשורה אחת",fb_group:"קבוצת פייסבוק",friend_post:"פוסט של חבר",personal_post:"פוסט אישי"};
const tl=t=>TOP[t]||(/^fb_group_/.test(t)?"קבוצה: "+'<bdi dir="ltr">'+esc(t.slice(9))+"</bdi>":'<bdi dir="ltr">'+esc(t)+"</bdi>"),nm2=k=>{const i=k.indexOf("|");return esc(SL[k.slice(0,i)]||k.slice(0,i))+" · "+tl(k.slice(i+1))};
ks.sort((a,b)=>ck(b)-ck(a)||ins(b)-ins(a)||(cv[b]||[0,0])[0]-(cv[a]||[0,0])[0]);
h+="<h4>לפי קישור ונושא ("+rng(W&&W.W)+")</h4>"+(!BC&&!AC?'<p class="note" style="margin:0">אין כרגע נתון מגוגל אנליטיקס.</p>':ks.length?'<div style="overflow-x:auto"><table class="t tg"><thead><tr><th>קישור</th><th class="n">נכנסו לאתר</th><th class="n">בדיקות רכב</th><th class="n">התקינו</th></tr></thead><tbody>'
+ks.map(k=>'<tr><td class="w">'+nm2(k)+'</td><td class="n">'+n((cv[k]||[0,0])[0])+'</td><td class="n">'+n(ck(k))+'</td><td class="n">'+n(ins(k))+"</td></tr>").join("")+"</tbody></table></div>"
:'<p class="note" style="margin:0">עוד אין השבוע כניסות מקישור עם נושא.</p>')
+'<p class="note">כל קישור <bdi dir="ltr">luchit.app/go/</bdi> נספר כאן לפי הרשת והנושא שלו, למשל <bdi dir="ltr">go/fb?c=market</bdi> מופיע כ"פייסבוק · פוסט על השוק". קישור בלי נושא נספר לפי ברירת המחדל של הרשת (בביו, פוסט, הודעה). הנושא נמדד מ-23.10. התקינו: פתיחה ראשונה של האפליקציה אחרי הורדה דרך הקישור.</p>'}
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
{const C=W&&W.coh,mat=end?addD(end,-7):null;let I=0,Sv=0,N1=0,N0=0,R1=0,R0=0;
for(const [day,o] of Object.entries(C||{})){if(day<QF)continue;const sv=o[1];I+=o[0];Sv+=o[1];if(day<=mat){N1+=sv;N0+=Math.max(0,o[0]-sv);R1+=o[2];R0+=o[3]}}
const r1=N1?R1/N1*100:null,r0=N0?R0/N0*100:null,x=r1==null||r0==null?null:r0>0?r1/r0:r1>0?Infinity:null;
let s,w,r;
if(!W||!end||end<QF){s="wait";w="ממתין לנתונים";r="הנתונים מתחילים עם 1.36: כל יום התקנות נכנס לחשבון שבוע אחרי שהותקן."}
else if(!C){s="nodata";r="גוגל אנליטיקס לא ענה."}
else if(N1<20||N0<20){s="early";r="מעט נתונים עדיין: נספרים רק מי שהתקין מ-1.36 ועבר עליו שבוע שלם. צריך לפחות 20 בכל קבוצה ("+n(N1)+" ששמרו, "+n(N0)+" שלא)."}
else if(x>=3){s="ok";w="השמירה מחזירה";r="מי ששמר רכב חוזר פי 3 או יותר: השמירה היא המנוף, וכדאי לחזק את רגע השמירה אחרי בדיקה."}
else{s="warn";w="פחות מפי 3";r="השמירה לא מחזירה מספיק: אם זה יישאר כך, מפסיקים לדחוף התקנות, ולוחית היא כלי אתר לשימוש חד-פעמי, עם הכנסה מחבילת קנייה ומעסקים."}
h+=head(2,"האם רכב שמור מחזיר אנשים?",s,w,r)+(s==="wait"||!C?"":'<ul class="kv">'
+row("התקנות חדשות מ-1.36",n(I),"מ-"+dm(QF)+" עד "+(end?dm(end):"-")+", בישראל")
+row("שמרו רכב ביום ההתקנה",n(Sv)+(I?' <small class="flat">('+pc(Sv/I*100)+")</small>":""),"אחוז השומרים מתוך המתקינים")
+row("חזרו בתוך 7 ימים, מי ששמר",N1?n(R1)+" מתוך "+n(N1)+' <small class="flat">('+pc(r1)+")</small>":"-","התקנות שעבר עליהן שבוע שלם"+(mat&&mat>=QF?" (עד "+dm(mat)+")":""))
+row("חזרו בתוך 7 ימים, מי שלא שמר",N0?n(R0)+" מתוך "+n(N0)+' <small class="flat">('+pc(r0)+")</small>":"-","")
+row("פי כמה חוזרים מי ששמרו",x==null?"-":x===Infinity?"רק הם חזרו":"פי "+n1(x),"הסף: פי 3")+"</ul>")}
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
const rows=Object.keys(N).filter(k=>ge(E0,k)||ge(E1,k)).sort((a,b)=>ge(E0,b)-ge(E0,a)).slice(0,14);
// saving is an app feature, so the share is of app devices; without that answer there is no fair stand-in (site "users" are page loads)
const SV=W.savers,Lu=SV?SV.car_lookup||0:null,Su=SV?SV.car_save||0:null;
const kvr=r=>"<li><span>"+r[0]+(r[2]!=null?" (שבוע קודם "+n(r[2])+")":"")+"</span><b>"+n(r[1])+"</b></li>";
box.innerHTML='<h4>שמירת רכב</h4><p class="note" style="margin:0 0 6px">'+(!SV?"אין נתון מגוגל אנליטיקס על מכשירים ששמרו רכב.":Lu>=50?n1(Su/Lu*100)+"% מהמכשירים באפליקציה שבדקו רכב שמרו אותו ברשימה (היעד 15%).":"מעט מדי מכשירים באפליקציה בדקו רכב השבוע כדי לחשב אחוז: "+n(Su)+" שמרו מתוך "+n(Lu)+".")+"</p>"
+'<h4>פעולות ('+rng(W.W)+")</h4>"+'<table class="t"><thead><tr><th>פעולה</th><th class="n">השבוע</th><th class="n">שבוע קודם</th></tr></thead><tbody>'+rows.map(k=>'<tr><td class="w">'+N[k]+'</td><td class="n">'+n(ge(E0,k))+'</td><td class="n">'+n(ge(E1,k))+"</td></tr>").join("")+"</tbody></table>"
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

// drawer: technical
{const fk=W&&W.fails?W.fails[0]:null;
const li=(l,v)=>"<li><span>"+l+"</span><b>"+v+"</b></li>";
$("tec").innerHTML="<h4>בדיקות שלא החזירו תוצאה, לפי סיבה ("+rng(W&&W.W)+")</h4>"+(fk?'<ul class="kv">'+(Object.entries(fk).sort((a,b)=>b[1]-a[1]).map(e=>li(KIND[e[0]]||esc(e[0]),n(e[1]))).join("")||li("אין","0"))+"</ul>":'<p class="note" style="margin:0">אין נתון</p>')
+'<p class="note">'+(H.att!=null?"מתוך "+n(H.att)+" ניסיונות בדיקה. בתקינות השירות נספרות רק שתי סיבות: משרד התחבורה לא ענה, ולא התקבלה תשובה. מספר שהוקלד לא נכון אינו תקלה.":"")+"</p>"
+"<h4>עוד סימנים טכניים השבוע</h4>"+'<ul class="kv">'+[["בדיקות איטיות","lookup_slow"],["בדיקות שבוטלו באמצע","lookup_abort"],["קריסות של האפליקציה","app_exception"],["חיפושי דגם בלי תוצאה","search_no_result"]].map(x=>li(x[0],ev?n(ge(E0,x[1])):"-")).join("")+"</ul>"
+"<h4>אזור הזמן של גוגל אנליטיקס</h4>"+'<p class="note" style="margin:0">'+(!d.gaTz?"לא נבדק":d.gaTz.ok?(d.gaTz.tz==="Asia/Jerusalem"?"שעון ישראל, כמו שהמסך מניח ✓":"<b>"+esc(d.gaTz.tz||"לא ידוע")+"</b>: לא שעון ישראל, ולכן ימים ושבועות במסך נחתכים בשעה אחרת. אפשר לשנות ב-Analytics, בהגדרות הנכס."):"לא נבדק: "+(/not been used|disabled/i.test(d.gaTz.why||"")?"צריך להפעיל את Google Analytics Admin API בפרויקט של חשבון השירות. ":"")+'<bdi dir="ltr">('+esc(d.gaTz.why||"")+")</bdi>")+"</p>"
+"<h4>דוחות Google Play (התקנות)</h4>"+'<p class="note" style="margin:0">'+(PS?"מחובר. היום האחרון שגוגל מסרה: "+dm(PS.last)+".":!d.stats?"לא נבדק":d.stats.why==="no bucket"?"לא מחובר עדיין: חסר שם הדלי של הדוחות. עד אז מספר המכשירים מחושב מגוגל אנליטיקס בלבד.":"לא מחובר עדיין"+(/^40[13]/.test(d.stats.why||"")?": לחשבון השירות אין עדיין הרשאה להוריד דוחות. צריך הרשאה ברמת החשבון ב-Play Console, והיא יכולה להיכנס לתוקף רק אחרי עד 48 שעות.":/^404/.test(d.stats.why||"")?": לא נמצאו דוחות התקנות. כדאי לבדוק את שם הדלי.":".")+' <bdi dir="ltr">('+esc(d.stats.why||"")+")</bdi>")+"</p>"
+"<h4>Play Console</h4>"+'<p class="note" style="margin:0">'+(d.release?d.release.ok?"מחובר. מצב הגרסאות בחנות נקרא משם.":"לא מחובר עדיין"+(/not been used|disabled/i.test(d.release.why||"")?": צריך להפעיל את Google Play Android Developer API בפרויקט של חשבון השירות ב-Google Cloud.":/permission|^40[13]/i.test(d.release.why||"")?": לחשבון השירות אין עדיין הרשאת צפייה באפליקציה ב-Play Console.":".")+' <bdi dir="ltr">('+esc(d.release.why||"")+")</bdi>":"לא נבדק")+"</p>"
+"<h4>מקורות נתונים</h4>"+'<ul class="kv">'+(Object.entries(d.errors||{}).map(e=>li(esc(e[0]),'<span style="font-weight:400">'+esc(e[1])+"</span>")).join("")||li("כל המקורות ענו","✓"))+"</ul>"}

$("build").textContent="גרסה "+(d.build||"");
}

async function go(){const meta=$("meta");try{const r=await fetch("/live/data",{cache:"no-store",signal:AbortSignal.timeout?AbortSignal.timeout(35e3):undefined});if(!r.ok)throw r.status;const d=await r.json();window.lastD=d;render(d);
const tm=new Date(d.at).toLocaleTimeString("he-IL",{timeZone:"Asia/Jerusalem",hour:"2-digit",minute:"2-digit"});
meta.className="meta"+(d.stale||d.late?" stale":"");meta.innerHTML='<span class="dot"></span>'+(d.late?"נתונים מ-"+tm+": השרת לא ענה בזמן, ננסה שוב בעוד דקה":d.stale?"נתונים ישנים מ-"+tm+", גוגל הגביל זמנית את מספר הבקשות":"עודכן "+tm)}
catch(e){meta.className="meta stale";meta.innerHTML='<span class="dot"></span>'+(e===504?"השרת לא ענה בזמן, ננסה שוב בעוד דקה":"אין חיבור")+(window.lastD?". מוצגים הנתונים האחרונים":"")}}
document.addEventListener("click",e=>{const a=e.target.closest("[data-open]");if(a){const el=$(a.dataset.open);if(el)el.open=true}});
go();setInterval(()=>{if(!document.hidden)go()},60000);
</script></body></html>`;

// /live/data answers within 25 s whatever an outside call does: on time = fresh data, kept as the last good answer (this isolate, and this
// data centre's cache for a new isolate); late or failed = that last good answer marked late, which the page shows with its time, or a
// 504 when there is none. On 20.10 one hung call kept every load of the screen on "loading" for two hours.
const DEADLINE = 25e3, LAST = "https://luchit.app/live/_last";
let lastGood = null;
async function liveData(env, ctx) {
  let timer, failed = false;
  const work = (async () => ({ ...(await collect(env)), flashes: (await getFlashes()).slice(0, 15), metrics: slimMetrics(await getMetrics()) }))();
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
    if (url.pathname === "/live/data") return liveData(env, ctx);
    if (url.pathname === "/live" || url.pathname === "/live/") return new Response(PAGE, { headers: { ...HEAD, "content-type": "text/html; charset=utf-8" } });
    return new Response("not found", { status: 404, headers: HEAD });
  }
};
