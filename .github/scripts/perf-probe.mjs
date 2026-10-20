// One-off (probe-perf branch, not for main), 20.10 evening: the day's performance for Dudu's question "is the direction positive for the
// store and for Google" - GA4 (by day, hour, source, landing page, realtime), Search Console (by day, query, page, device, hour), Google
// Play's own reports (installs, store listing visitors by country and traffic source, ratings, crashes) and releases, and Cloudflare's
// site visits by day, referrer and page. Business numbers never reach the log or the branch in clear: the whole JSON is encrypted with
// .github/seo-data.pub.pem (as seo-data.mjs does) and the log says only which part answered.
import crypto from "node:crypto";
import fs from "node:fs";
const E = process.env, PKG = "com.ddsabag.pratirechev", PROP = "557990379", BUCKET = "pubsite_prod_4688106336294834537", SITE = "sc-domain:luchit.app";
const CF_SITES = ["03eb6fb7a75440649781d7a00b29c4ff", "5c0a33a14f5f4201b25fd680a29ae723"];
const out = { generated: new Date().toISOString(), parts: {} }, log = (part, ok, why = "") => console.log(part, ok ? "ok" : "failed " + String(why).replace(/\d/g, "#").slice(0, 120));
const sa = JSON.parse(E.GA_SERVICE_ACCOUNT_JSON || "null");
const b64 = b => Buffer.from(b).toString("base64url");
async function token() {
  const now = Math.floor(Date.now() / 1000), head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const scope = ["analytics.readonly", "webmasters.readonly", "androidpublisher", "devstorage.read_only"].map(x => "https://www.googleapis.com/auth/" + x).join(" ");
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
const inList = (field, values) => ({ filter: { fieldName: field, inListFilter: { values } } });
const EVENTS = ["car_lookup", "first_open", "web_visit", "link_landing", "share", "car_save", "lookup_failed", "app_remove", "session_start", "compare_open", "buy_card_open", "user_screenshot", "page_view", "app_update", "search_no_result", "upgrade_open"];
const D28 = [{ startDate: "27daysAgo", endDate: "today" }], D14 = [{ startDate: "13daysAgo", endDate: "today" }], D2 = [{ startDate: "yesterday", endDate: "today" }];

// GA4
await part("ga.dailyPlatform", () => ga({ dateRanges: D28, dimensions: [{ name: "date" }, { name: "platform" }, { name: "countryId" }], metrics: ["activeUsers", "newUsers", "sessions", "engagedSessions", "userEngagementDuration", "screenPageViews"].map(name => ({ name })) }));
await part("ga.dailyEvents", () => ga({ dateRanges: D28, dimensions: [{ name: "date" }, { name: "platform" }, { name: "eventName" }, { name: "countryId" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: inList("eventName", EVENTS) }));
await part("ga.sources", () => ga({ dateRanges: D14, dimensions: ["date", "platform", "sessionSource", "sessionMedium", "sessionCampaignName"].map(name => ({ name })), metrics: ["sessions", "engagedSessions", "newUsers"].map(name => ({ name })) }));
await part("ga.sourceEvents", () => ga({ dateRanges: D14, dimensions: ["date", "platform", "sessionSource", "sessionMedium", "sessionCampaignName", "eventName"].map(name => ({ name })), metrics: [{ name: "eventCount" }], dimensionFilter: inList("eventName", ["car_lookup", "first_open", "web_visit", "link_landing", "share", "car_save"]) }));
await part("ga.installSource", () => ga({ dateRanges: D28, dimensions: ["date", "firstUserSource", "firstUserMedium", "firstUserCampaignName", "countryId"].map(name => ({ name })), metrics: [{ name: "eventCount" }], dimensionFilter: { andGroup: { expressions: [inList("eventName", ["first_open"]), { filter: { fieldName: "platform", stringFilter: { value: "Android" } } }] } } }));
await part("ga.srcParam", () => ga({ dateRanges: [{ startDate: "6daysAgo", endDate: "today" }], dimensions: ["date", "platform", "customEvent:src", "eventName"].map(name => ({ name })), metrics: [{ name: "eventCount" }], dimensionFilter: inList("eventName", ["car_lookup", "web_visit", "link_landing", "share"]) }));
await part("ga.hourly", () => ga({ dateRanges: D2, dimensions: ["dateHour", "platform", "eventName", "countryId"].map(name => ({ name })), metrics: [{ name: "eventCount" }], dimensionFilter: inList("eventName", ["car_lookup", "first_open", "web_visit", "link_landing", "session_start", "page_view"]) }));
await part("ga.hourlySources", () => ga({ dateRanges: D2, dimensions: ["dateHour", "platform", "sessionSource", "sessionMedium"].map(name => ({ name })), metrics: [{ name: "sessions" }] }));
await part("ga.landing", () => ga({ dateRanges: [{ startDate: "6daysAgo", endDate: "today" }], dimensions: ["date", "landingPage", "sessionSource"].map(name => ({ name })), metrics: [{ name: "sessions" }, { name: "engagedSessions" }], dimensionFilter: { filter: { fieldName: "platform", stringFilter: { value: "web" } } } }));
await part("ga.realtime", async () => ({
  platform: await gaRT({ dimensions: [{ name: "platform" }, { name: "countryId" }], metrics: [{ name: "activeUsers" }] }),
  events: await gaRT({ dimensions: [{ name: "platform" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], minuteRanges: [{ startMinutesAgo: 29, endMinutesAgo: 0 }] }),
}));

// Search Console
const SC = "https://www.googleapis.com/webmasters/v3/sites/" + encodeURIComponent(SITE);
const iso = d => d.toISOString().slice(0, 10), day = k => iso(new Date(Date.now() - k * 864e5));
const scq = (dims, from, to = day(0), extra = {}) => call(SC + "/searchAnalytics/query", { startDate: from, endDate: to, dimensions: dims, rowLimit: 25000, dataState: "all", ...extra }).then(j => j.rows || []);
await part("sc.byDate", () => scq(["date"], day(90)));
await part("sc.byDateDevice", () => scq(["date", "device"], day(27)));
await part("sc.queries", () => scq(["date", "query"], day(13)));
await part("sc.pages", () => scq(["date", "page"], day(13)));
await part("sc.query28", () => scq(["query"], day(27)));
await part("sc.queryPrev28", () => scq(["query"], day(55), day(28)));
await part("sc.country", () => scq(["country"], day(27)));
await part("sc.searchType", async () => ({ discover: await scq(["date"], day(27), day(0), { type: "discover" }).catch(e => ({ error: String(e.message).slice(0, 160) })), image: await scq(["date"], day(27), day(0), { type: "image" }).catch(e => ({ error: String(e.message).slice(0, 160) })) }));
await part("sc.hourly", () => scq(["hour"], day(3), day(0), { dataState: "hourly_all" }));
await part("sc.sitemaps", async () => (await call(SC + "/sitemaps")).sitemap || []);

// Google Play: releases (no edit needed), recent reviews' stars, and the bulk reports in the account's Cloud Storage bucket (UTF-16 CSV)
const AP = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}`;
await part("play.releases", async () => { const o = {}; for (const t of ["production", "alpha"]) o[t] = await call(`${AP}/tracks/${t}/releases`).catch(e => ({ error: String(e.message).slice(0, 160) })); return o; });
await part("play.reviews", async () => { const j = await call(`${AP}/reviews?maxResults=100`); return (j.reviews || []).map(r => { const c = (r.comments || []).find(x => x.userComment)?.userComment || {}; return { stars: c.starRating, at: c.lastModified?.seconds, lang: c.reviewerLanguage, ver: c.appVersionName, len: (c.text || "").length }; }); });
const decode = buf => buf[0] === 0xff && buf[1] === 0xfe ? buf.slice(2).toString("utf16le") : buf.toString("utf8").replace(/^﻿/, "");
await part("play.reports", async () => {
  const list = [], o = {};
  for (const prefix of ["stats/installs/", "stats/store_performance/", "stats/ratings/", "stats/crashes/", "acquisition/"]) {
    let pageToken = "";
    do {
      const j = await call(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o?` + new URLSearchParams({ prefix, maxResults: "1000", ...(pageToken ? { pageToken } : {}) }));
      list.push(...(j.items || []).map(x => ({ name: x.name, size: Number(x.size), updated: x.updated })));
      pageToken = j.nextPageToken || "";
    } while (pageToken);
  }
  o.list = list.map(x => [x.name, x.size, x.updated]);
  o.files = {};
  for (const x of list.filter(x => /_2026(09|10)[_.]/.test(x.name) && x.size < 3e6)) o.files[x.name] = decode(await call(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(x.name)}?alt=media`, null, true));
  return o;
});

// Cloudflare Web Analytics (the site; Israel days, without /live and headless Chrome, as /live counts them)
const cleanTok = raw => { raw = String(raw || ""); const m = raw.match(/Bearer\s+([A-Za-z0-9_\-]{20,})/i); return (m ? m[1] : raw).trim().replace(/^["']|["']$/g, "").replace(/[^\x21-\x7e]/g, ""); };
async function cf(dims, from, to, limit = 1000) {
  const q = `query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){rumPageloadEventsAdaptiveGroups(filter:$f,limit:${limit},orderBy:[sum_visits_DESC]){count sum{visits} dimensions{${dims}}}}}}`;
  const f = { AND: [{ datetime_geq: from, datetime_lt: to }, { siteTag_in: CF_SITES }, { requestPath_notlike: "/live%" }, { userAgentBrowser_neq: "ChromeHeadless" }] };
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + cleanTok(E.CF_API_TOKEN), "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: { acc: String(E.CF_ACCOUNT_ID || "").trim(), f } }) });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors.map(e => e.message).join(" | "));
  return j.data.viewer.accounts[0].rumPageloadEventsAdaptiveGroups.map(x => ({ ...x.dimensions, visits: x.sum.visits, views: x.count }));
}
const now = new Date(), ago = d => new Date(now - d * 864e5).toISOString();
await part("cf.daily", () => cf("date", ago(14), now.toISOString(), 100));
await part("cf.hourly", () => cf("datetimeHour", ago(2), now.toISOString(), 100));
await part("cf.referrers", () => cf("date refererHost", ago(7), now.toISOString(), 2000));
await part("cf.paths", () => cf("date requestPath", ago(2), now.toISOString(), 2000));
await part("cf.countries", () => cf("countryName", ago(2), now.toISOString(), 100));
await part("cf.devices", () => cf("date deviceType", ago(7), now.toISOString(), 200));

// PageSpeed (public API, no key: may be refused for quota)
await part("psi", async () => { const o = {}; for (const u of ["https://luchit.app/", "https://luchit.app/model/"]) { const r = await fetch("https://www.googleapis.com/pagespeedonline/v5/runPagespeed?" + new URLSearchParams({ url: u, strategy: "mobile" }) + "&category=performance&category=seo", { signal: AbortSignal.timeout(90000) }); const j = await r.json(); o[u] = j.error ? { error: j.error.message?.slice(0, 160) } : { perf: j.lighthouseResult?.categories?.performance?.score, seo: j.lighthouseResult?.categories?.seo?.score, lcp: j.lighthouseResult?.audits?.["largest-contentful-paint"]?.numericValue, cls: j.lighthouseResult?.audits?.["cumulative-layout-shift"]?.numericValue, tbt: j.lighthouseResult?.audits?.["total-blocking-time"]?.numericValue, field: j.loadingExperience?.metrics ? Object.fromEntries(Object.entries(j.loadingExperience.metrics).map(([k, v]) => [k, v.percentile])) : null }; } return o; });

const data = Buffer.from(JSON.stringify(out));
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(data), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/perf.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
console.log("written, encrypted");
