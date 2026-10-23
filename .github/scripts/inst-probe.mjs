// 23.10: web visitors by device for the website design question (wd.* parts)
// One-off (probe-perf branch, not for main), 20.10 evening: why /live's "installed now" fell from 227 to 120 within an hour. Reads what the
// Worker reads (GA4 first opens and removals in Israel by day and by hour, GA4 realtime by minute, Google Play's installs report) and
// Cloudflare's record of the luchit-live Worker's requests (by 5 minutes, status, data centre when the dataset has it). Business numbers
// never reach the log or the branch in clear: the JSON is encrypted with .github/seo-data.pub.pem and the log says only which part answered.
import crypto from "node:crypto";
import fs from "node:fs";
const E = process.env, PKG = "com.ddsabag.pratirechev", PROP = "557990379", BUCKET = "pubsite_prod_4688106336294834537";
const out = { generated: new Date().toISOString(), parts: {} }, log = (part, ok, why = "") => console.log(part, ok ? "ok" : "failed " + String(why).replace(/\d/g, "#").slice(0, 160));
const sa = JSON.parse(E.GA_SERVICE_ACCOUNT_JSON || "null");
const b64 = b => Buffer.from(b).toString("base64url");
async function token() {
  const now = Math.floor(Date.now() / 1000), head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const scope = ["analytics.readonly", "devstorage.read_only", "webmasters.readonly"].map(x => "https://www.googleapis.com/auth/" + x).join(" ");
  const claim = b64(JSON.stringify({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 }));
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) });
  if (!r.ok) throw new Error("auth " + r.status);
  return (await r.json()).access_token;
}
const T = await token(), H = { authorization: "Bearer " + T, "content-type": "application/json" };
async function call(url, body, raw = false) {
  const r = await fetch(url, { ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), headers: H, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(r.status + " " + (await r.text()).slice(0, 200));
  return raw ? Buffer.from(await r.arrayBuffer()) : r.json();
}
async function part(name, fn) { try { out.parts[name] = await fn(); log(name, true); } catch (e) { out.parts[name] = { error: String(e.message || e).slice(0, 400) }; log(name, false, e.message || e); } }
const flat = j => ({ dims: (j.dimensionHeaders || []).map(h => h.name), mets: (j.metricHeaders || []).map(h => h.name), rows: (j.rows || []).map(r => [...r.dimensionValues.map(v => v.value), ...r.metricValues.map(v => Number(v.value))]), rowCount: j.rowCount || 0 });
const ga = body => call(`https://analyticsdata.googleapis.com/v1beta/properties/${PROP}:runReport`, { limit: 100000, ...body }).then(flat);
const gaRT = body => call(`https://analyticsdata.googleapis.com/v1beta/properties/${PROP}:runRealtimeReport`, body).then(flat);
const eq = (f, v) => ({ filter: { fieldName: f, stringFilter: { value: v } } }), inList = (f, values) => ({ filter: { fieldName: f, inListFilter: { values } } });
const REAL = { orGroup: { expressions: [eq("platform", "web"), eq("countryId", "IL")] } };
const APP = { andGroup: { expressions: [eq("platform", "Android"), eq("countryId", "IL")] } };
const FO = inList("eventName", ["first_open", "app_remove"]);

// GA4: as the Worker asks (daily.life), today by hour (how far GA4 has processed today), and realtime by minute (rtToday)
await part("ga.life", () => ga({ dateRanges: [{ startDate: "2026-10-01", endDate: "today" }], dimensions: [{ name: "date" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: { andGroup: { expressions: [APP, FO] } } }));
await part("ga.hourly", () => ga({ dateRanges: [{ startDate: "yesterday", endDate: "today" }], dimensions: [{ name: "dateHour" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: { andGroup: { expressions: [APP, FO] } } }));
await part("ga.hourlyChecks", () => ga({ dateRanges: [{ startDate: "today", endDate: "today" }], dimensions: [{ name: "dateHour" }, { name: "platform" }], metrics: [{ name: "eventCount" }], dimensionFilter: { andGroup: { expressions: [REAL, eq("eventName", "car_lookup")] } } }));
// today's processed events by minute (dateHourMinute, property time = Israel), to compare minute by minute with the realtime tally
await part("ga.minutes", () => ga({ dateRanges: [{ startDate: E.DAY || "today", endDate: E.DAY || "today" }], dimensions: [{ name: "dateHourMinute" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: { andGroup: { expressions: [REAL, inList("eventName", ["first_open", "car_lookup"])] } } }));
await part("ga.minutesApp", () => ga({ dateRanges: [{ startDate: E.DAY || "today", endDate: E.DAY || "today" }], dimensions: [{ name: "dateHourMinute" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: { andGroup: { expressions: [APP, inList("eventName", ["first_open"])] } } }));
await part("ga.rtMinutes", () => gaRT({ dimensions: [{ name: "minutesAgo" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: { andGroup: { expressions: [REAL, inList("eventName", ["first_open", "car_lookup"])] } }, limit: 200 }));
await part("ga.rtPlatform", () => gaRT({ dimensions: [{ name: "platform" }, { name: "countryId" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: inList("eventName", ["first_open", "app_remove"]), limit: 200 }));

// Google Play: the installs report the Worker reads (Israel rows only), and when each file was last written
const decode = buf => buf[0] === 0xff && buf[1] === 0xfe ? buf.slice(2).toString("utf16le") : buf.toString("utf8").replace(/^﻿/, "");
if (!E.LIGHT) await part("play.installs", async () => {
  const j = await call(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o?` + new URLSearchParams({ prefix: "stats/installs/installs_" + PKG + "_2026", maxResults: "200" }));
  const items = (j.items || []).map(x => ({ name: x.name, updated: x.updated, size: Number(x.size) }));
  const o = { items, rows: {} };
  for (const x of items.filter(x => /_202610_country\.csv$/.test(x.name))) {
    const t = decode(await call(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(x.name)}?alt=media`, null, true)).split(/\r?\n/);
    o.rows[x.name] = [t[0], ...t.slice(1).filter(l => /,IL,/.test(l))];
  }
  return o;
});

// Cloudflare: the luchit-live Worker's requests since 16:00 UTC. Data centre (coloCode) first; without it, the same without the data centre.
const cleanTok = raw => { raw = String(raw || ""); const m = raw.match(/Bearer\s+([A-Za-z0-9_\-]{20,})/i); return (m ? m[1] : raw).trim().replace(/^["']|["']$/g, "").replace(/[^\x21-\x7e]/g, ""); };
async function gql(query, variables) {
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + cleanTok(E.CF_API_TOKEN), "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors.map(e => e.message).join(" | "));
  return j.data;
}
const since = new Date(Date.now() - 5 * 36e5).toISOString(), until = new Date().toISOString(), acc = String(E.CF_ACCOUNT_ID || "").trim();
const inv = dims => gql(`query($acc:String!,$since:Time!,$until:Time!){viewer{accounts(filter:{accountTag:$acc}){workersInvocationsAdaptive(limit:2000,filter:{scriptName:"luchit-live",datetime_geq:$since,datetime_leq:$until},orderBy:[datetimeFiveMinutes_ASC]){dimensions{${dims}} sum{requests subrequests errors} quantiles{wallTimeP50 wallTimeP99}}}}}`, { acc, since, until })
  .then(d => d.viewer.accounts[0].workersInvocationsAdaptive.map(x => ({ ...x.dimensions, ...x.sum, p50: x.quantiles.wallTimeP50, p99: x.quantiles.wallTimeP99 })));
if (!E.LIGHT) await part("cf.byColo", () => inv("datetimeFiveMinutes status coloCode"));
await part("cf.byVersion", () => inv("datetimeFiveMinutes status scriptVersion"));
if (!E.LIGHT) await part("cf.plain", () => inv("datetimeFiveMinutes status"));
if (!E.LIGHT) await part("cf.zone", async () => {
  const r = await fetch("https://api.cloudflare.com/client/v4/zones?name=luchit.app", { headers: { authorization: "Bearer " + cleanTok(E.CF_API_TOKEN) } });
  const j = await r.json(); if (!j.success) throw new Error("zones " + r.status + " " + JSON.stringify(j.errors).slice(0, 160));
  const zone = j.result[0]?.id; if (!zone) throw new Error("no zone");
  const d = await gql(`query($z:String!,$since:Time!,$until:Time!){viewer{zones(filter:{zoneTag:$z}){httpRequestsAdaptiveGroups(limit:2000,filter:{datetime_geq:$since,datetime_leq:$until,clientRequestPath_like:"/live%"},orderBy:[datetimeFiveMinutes_ASC]){count dimensions{datetimeFiveMinutes coloCode clientRequestPath edgeResponseStatus clientCountryName cacheStatus}}}}}`, { z: zone, since, until });
  return d.viewer.zones[0].httpRequestsAdaptiveGroups.map(x => ({ ...x.dimensions, n: x.count }));
});

// live-30 check: today's tally in Workers KV (luchit-alerts, key lv:rt:<Israel day>), read with the deploy token (read-only GETs)
await part("kv.tally", async () => {
  const tok = cleanTok(E.CLOUDFLARE_API_TOKEN), A = "https://api.cloudflare.com/client/v4/accounts/" + acc + "/storage/kv/namespaces";
  const ns = await (await fetch(A + "?per_page=100", { headers: { authorization: "Bearer " + tok } })).json();
  if (!ns.success) throw new Error("namespaces " + JSON.stringify(ns.errors).slice(0, 160));
  const id = (ns.result || []).find(n => n.title === "luchit-alerts")?.id; if (!id) throw new Error("no luchit-alerts");
  const day = E.DAY || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" }), r = await fetch(A + "/" + id + "/values/" + encodeURIComponent("lv:rt:" + day), { headers: { authorization: "Bearer " + tok } });
  if (r.status === 404) return { day, present: false };
  if (!r.ok) throw new Error("value " + r.status);
  const v = JSON.parse(await r.text()), mins = Object.keys(v.m || {}).map(Number).sort((a, b) => a - b);
  return { day, present: true, ageSec: Math.round((Date.now() - v.at) / 1000), minutes: mins.length, first: mins.length ? new Date(mins[0] * 6e4).toISOString() : null, last: mins.length ? new Date(mins[mins.length - 1] * 6e4).toISOString() : null,
    first_open: Object.values(v.m || {}).reduce((t, x) => t + x[0], 0), car_lookup: Object.values(v.m || {}).reduce((t, x) => t + x[1], 0),
    perMinute: v.m,
    // per Israel hour: [minutes kept, first opens, car checks], to compare with GA4's processed hours
    byHour: Object.entries(v.m || {}).reduce((o, [m, x]) => { const h = new Date(Number(m) * 6e4).toLocaleString("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", hourCycle: "h23" }); const a = (o[h] ||= [0, 0, 0]); a[0]++; a[1] += x[0]; a[2] += x[1]; return o; }, {}) };
});

// Search Console exactly as /live asks it (collectSeo: week ending 3 days ago, the week before, 28 days by date, default dataState), and the
// same days with dataState "all" as the daily SEO snapshot asks, to compare the two screens
{
  const SC = "https://www.googleapis.com/webmasters/v3/sites/" + encodeURIComponent("sc-domain:luchit.app") + "/searchAnalytics/query";
  const il = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" }), add = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
  const end = add(il, -3), w1 = [add(end, -6), end], w0 = [add(end, -13), add(end, -7)], d28 = [add(end, -27), end];
  const q = b => call(SC, b).then(j => j.rows || []);
  await part("sc.live", async () => ({ today: il, w1, w0, cur: await q({ startDate: w1[0], endDate: w1[1] }), prev: await q({ startDate: w0[0], endDate: w0[1] }),
    days: await q({ startDate: d28[0], endDate: d28[1], dimensions: ["date"], rowLimit: 40 }) }));
  await part("sc.all", async () => ({ days: await q({ startDate: add(il, -12), endDate: il, dimensions: ["date"], rowLimit: 40, dataState: "all" }) }));
}

// 21.10: the share feature: shares by day, platform and kind; car checks and report views (exp_expose) as the base; arrivals from shared
// links (link_landing by kind and via, web visits and checks whose source is "share", app referral_open), and how many devices shared
{
  const R = [{ startDate: "2026-10-12", endDate: "today" }], ev = n => eq("eventName", n), and = (...x) => ({ andGroup: { expressions: x } });
  const by = (name, dims, mets = ["eventCount"]) => ga({ dateRanges: R, dimensions: dims.map(d => ({ name: d })), metrics: mets.map(m => ({ name: m })), dimensionFilter: and(REAL, ev(name)) });
  await part("sh.share", () => by("share", ["date", "platform", "customEvent:kind"], ["eventCount", "totalUsers"]));
  await part("sh.lookup", () => by("car_lookup", ["date", "platform"], ["eventCount", "totalUsers"]));
  await part("sh.expose", () => by("exp_expose", ["date", "platform"], ["eventCount", "totalUsers"]));
  await part("sh.landing", () => by("link_landing", ["date", "platform", "customEvent:kind", "customEvent:via"]));
  await part("sh.referral", () => by("referral_open", ["date", "customEvent:via"]));
  await part("sh.webSrc", () => ga({ dateRanges: [{ startDate: "2026-10-20", endDate: "today" }], dimensions: [{ name: "eventName" }, { name: "customEvent:src" }], metrics: [{ name: "eventCount" }],
    dimensionFilter: and(eq("platform", "web"), inList("eventName", ["web_visit", "car_lookup", "share", "web_hint_click", "link_landing"])) }));
  await part("sh.sharers", () => ga({ dateRanges: [{ startDate: "2026-10-19", endDate: "today" }], dimensions: [{ name: "platform" }], metrics: [{ name: "totalUsers" }, { name: "eventCount" }], dimensionFilter: and(REAL, ev("share")) }));
}

// 21.10 09:35: the whole funnel since the public launch (19.10): web events by source, app events, new vs returning, first-open sources,
// an app retention cohort, tabs, web-to-app clicks, Play installs and store listing reports
{
  const R = [{ startDate: "2026-10-19", endDate: "today" }], and = (...x) => ({ andGroup: { expressions: x } });
  const run = (dims, mets, filter, dr = R, extra = {}) => ga({ dateRanges: dr, dimensions: dims.map(d => ({ name: d })), metrics: mets.map(m => ({ name: m })), dimensionFilter: filter, ...extra });
  await part("fx.webEvents", () => run(["date", "eventName"], ["eventCount"], eq("platform", "web")));
  await part("fx.webSrc", () => run(["eventName", "customEvent:src"], ["eventCount"], eq("platform", "web"), [{ startDate: "2026-10-20", endDate: "today" }]));
  await part("fx.appEvents", () => run(["date", "eventName"], ["eventCount", "totalUsers"], APP));
  await part("fx.appNewRet", () => run(["date", "newVsReturning"], ["activeUsers", "eventCount"], APP));
  await part("fx.firstSrc", () => run(["firstUserSource", "firstUserMedium", "firstUserCampaignName"], ["newUsers"], APP));
  await part("fx.tabs", () => run(["platform", "customEvent:tab"], ["eventCount"], and(REAL, eq("eventName", "tab_view"))));
  await part("fx.webInstall", () => run(["eventName", "customEvent:via", "customEvent:src"], ["eventCount"], and(eq("platform", "web"), inList("eventName", ["web_install_click", "web_install_prompt", "web_hint_click"]))));
  await part("fx.saves", () => run(["platform", "eventName"], ["eventCount", "totalUsers"], and(REAL, inList("eventName", ["car_save", "car_unsave", "alerts_toggle", "alert_kind", "compare_open", "buy_card_open", "upgrade_open", "checklist_pdf", "simple_view", "link_out", "settlement_shown", "camera_scan", "voice_search", "user_screenshot", "lookup_failed", "lookup_slow", "search_no_result"]))));
  await part("fx.cohort", () => call(`https://analyticsdata.googleapis.com/v1beta/properties/${PROP}:runReport`, {
    dimensions: [{ name: "cohort" }, { name: "cohortNthDay" }], metrics: [{ name: "cohortActiveUsers" }],
    cohortSpec: { cohorts: [{ name: "d19", dimension: "firstSessionDate", dateRange: { startDate: "2026-10-19", endDate: "2026-10-19" } }, { name: "d20", dimension: "firstSessionDate", dateRange: { startDate: "2026-10-20", endDate: "2026-10-20" } }],
      cohortsRange: { granularity: "DAILY", startOffset: 0, endOffset: 2 } }, dimensionFilter: APP }).then(flat));
  await part("play.recent", async () => {
    const out = {};
    for (const kind of ["installs", "store_performance"]) {
      const j = await call(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o?` + new URLSearchParams({ prefix: `stats/${kind}/${kind}_${PKG}_202610`, maxResults: "50" }));
      for (const x of (j.items || []).filter(x => /_(country|overview|traffic_source)\.csv$/.test(x.name))) {
        const t = decode(await call(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(x.name)}?alt=media`, null, true)).split(/\r?\n/).filter(Boolean);
        out[x.name.split("/").pop()] = { head: t[0], rows: t.slice(1).filter(l => !/_country/.test(x.name) || /,IL,/.test(l)).slice(-40) };
      }
    }
    return out;
  });
}

// 21.10 live-32: the questions drawer's query for new installs (date, event, app version, n, kind), to check GA4 takes its shape
{
  const and = (...x) => ({ andGroup: { expressions: x } });
  await part("q.ret", () => ga({ dateRanges: [{ startDate: "2026-10-14", endDate: "yesterday" }], dimensions: ["date", "eventName", "appVersion", "customEvent:n", "customEvent:kind"].map(name => ({ name })), metrics: [{ name: "eventCount" }],
    dimensionFilter: and(APP, inList("eventName", ["first_open", "first_save", "app_return"])), limit: 5000 }));
}

// 21.10 saver value research: saves and removals by where they were made (from) and the saved-list size (n), and alert settings
{
  const and = (...x) => ({ andGroup: { expressions: x } });
  await part("sv.saves", () => ga({ dateRanges: [{ startDate: "2026-10-12", endDate: "today" }], dimensions: ["platform", "eventName", "customEvent:from", "customEvent:n"].map(name => ({ name })), metrics: [{ name: "eventCount" }, { name: "totalUsers" }],
    dimensionFilter: and(REAL, inList("eventName", ["car_save", "car_unsave"])) }));
  await part("sv.alerts", () => ga({ dateRanges: [{ startDate: "2026-10-12", endDate: "today" }], dimensions: ["platform", "eventName", "customEvent:kind"].map(name => ({ name })), metrics: [{ name: "eventCount" }, { name: "totalUsers" }],
    dimensionFilter: and(REAL, inList("eventName", ["alerts_toggle", "alert_kind", "doc_add", "calendar_reminder_click", "calendar_reminder_shown", "trial_start"])) }));
  await part("sv.users", () => ga({ dateRanges: [{ startDate: "2026-10-19", endDate: "today" }], dimensions: [{ name: "platform" }], metrics: [{ name: "totalUsers" }, { name: "activeUsers" }], dimensionFilter: REAL }));
}

// 23.10 website design question: who uses the website (not the app) and on what device. Web events reach GA4 through /api/e (Measurement
// Protocol), which carries no device or country, so the device split comes from Cloudflare Web Analytics (the beacon, as /live reads it: both
// site tags, no /live, no headless browsers) for the last 7 days and the 7 before; GA4 gives web event totals, and Search Console by device
{
  const and = (...x) => ({ andGroup: { expressions: x } }), WEB = eq("platform", "web");
  const run = (dims, mets, filter, dr) => ga({ dateRanges: dr || [{ startDate: "30daysAgo", endDate: "today" }], dimensions: dims.map(d => ({ name: d })), metrics: mets.map(m => ({ name: m })), dimensionFilter: filter });
  await part("wd.events", () => run(["eventName"], ["eventCount"], WEB));
  await part("wd.eventsWeek", () => run(["eventName"], ["eventCount"], WEB, [{ startDate: "7daysAgo", endDate: "yesterday" }]));
  await part("wd.srcEvents", () => run(["eventName", "customEvent:src"], ["eventCount"], and(WEB, inList("eventName", ["web_visit", "car_lookup", "web_install_click", "web_hint_click", "car_save", "share"])), [{ startDate: "2026-10-20", endDate: "today" }]));
  await part("wd.hour", () => run(["dayOfWeek", "hour"], ["eventCount"], and(WEB, eq("eventName", "car_lookup"))));
  const SITES = ["03eb6fb7a75440649781d7a00b29c4ff", "5c0a33a14f5f4201b25fd680a29ae723"], day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10) + "T00:00:00Z";
  const rum = (dims, from, to, limit = 500) => gql(`query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){rumPageloadEventsAdaptiveGroups(filter:$f,limit:${limit},orderBy:[count_DESC]){count sum{visits} dimensions{${dims}}}}}}`,
    { acc, f: { AND: [{ datetime_geq: day(from), datetime_lt: day(to) }, { siteTag_in: SITES }, { requestPath_notlike: "/live%" }, { userAgentBrowser_neq: "ChromeHeadless" }] } })
    .then(d => d.viewer.accounts[0].rumPageloadEventsAdaptiveGroups.map(x => ({ ...x.dimensions, n: x.count, visits: x.sum.visits })));
  for (const [w, from, to] of [["w1", 7, 0], ["w0", 14, 7]]) {
    await part("wd.rumDevice." + w, () => rum("deviceType", from, to));
    await part("wd.rumPath." + w, () => rum("deviceType requestPath", from, to, 400));
    await part("wd.rumRef." + w, () => rum("deviceType refererHost", from, to, 200));
    await part("wd.rumOS." + w, () => rum("deviceType userAgentOS userAgentBrowser", from, to, 100));
    await part("wd.rumCountry." + w, () => rum("deviceType countryName", from, to, 60));
  }
  await part("wd.rumDay", () => rum("date deviceType", 14, 0, 100));
  const SC = "https://www.googleapis.com/webmasters/v3/sites/" + encodeURIComponent("sc-domain:luchit.app") + "/searchAnalytics/query";
  const il = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" }), add = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
  const q = b => call(SC, { startDate: add(il, -30), endDate: add(il, -2), dataState: "all", ...b }).then(j => j.rows || []);
  await part("wd.scDevice", () => q({ dimensions: ["device"] }));
  await part("wd.scDeviceDay", () => q({ dimensions: ["device", "date"], rowLimit: 200 }));
  await part("wd.scDevicePage", () => q({ dimensions: ["device", "page"], rowLimit: 600 }));
  await part("wd.scDeviceQuery", () => q({ dimensions: ["device", "query"], rowLimit: 400 }));
}

const data = Buffer.from(JSON.stringify(out));
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(data), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/inst.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
console.log("written, encrypted");
