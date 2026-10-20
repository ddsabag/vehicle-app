// One-off (probe-go branch, not for main), 20.10: (1) how many app installs there are, from Google Play's own reports and from Analytics,
// (2) arrivals by channel (facebook, whatsapp, tiktok, youtube...) to the app and to the site, (3) the /live data snapshot for a UI review.
// Aggregates only: device models are hashed, digits in search terms masked, no cities, no identifiers.
import { createHash } from "node:crypto";
const env = { GA_SERVICE_ACCOUNT_JSON: process.env.GA_SERVICE_ACCOUNT_JSON, GA_PROPERTY_ID: process.env.GA_PROPERTY_ID || "557990379", CF_API_TOKEN: process.env.CF_API_TOKEN, CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID, PLAY_REPORTS_BUCKET: "pubsite_prod_4688106336294834537" };
const m = await import("./live-ui.mjs");
const out = { at: new Date().toISOString() };
const h8 = s => createHash("sha256").update(String(s)).digest("hex").slice(0, 8);
const rows = (rs, f) => (rs || []).map(r => [...r.dimensionValues.map(x => x.value), ...r.metricValues.map(x => Number(x.value))]).map(f || (x => x));
const step = async (k, fn) => { try { out[k] = await fn(); } catch (e) { out[k] = { error: String(e.message || e).slice(0, 300) }; } };
const AND = (...e) => ({ andGroup: { expressions: e } });
const ev = v => ({ filter: { fieldName: "eventName", stringFilter: { value: v } } });
const evs = vs => ({ filter: { fieldName: "eventName", inListFilter: { values: vs } } });
const ANDROID = { filter: { fieldName: "platform", stringFilter: { value: "Android" } } }, WEB = { filter: { fieldName: "platform", stringFilter: { value: "web" } } };
const IL = { filter: { fieldName: "countryId", stringFilter: { value: "IL" } } };
const ALL = [{ startDate: "2026-08-01", endDate: "today" }];
const today = m.ilDay(Date.now());

// 1. installs ------------------------------------------------------------------------------------------------------------------
// 1a. Google Play bulk reports in Cloud Storage (exact store numbers): can the service account list and read them?
await step("play_list", async () => {
  const tok = await m.googleToken(env);
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${env.PLAY_REPORTS_BUCKET}/o?prefix=stats/installs/&maxResults=60`, { headers: { authorization: "Bearer " + tok } });
  const t = await r.text(); if (!r.ok) return { status: r.status, body: t.replace(/\s+/g, " ").slice(0, 300) };
  return { status: r.status, names: (JSON.parse(t).items || []).map(i => i.name + " " + i.size + "B " + i.updated) };
});
const playCsv = async name => {
  const tok = await m.googleToken(env);
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${env.PLAY_REPORTS_BUCKET}/o/${encodeURIComponent(name)}?alt=media`, { headers: { authorization: "Bearer " + tok } });
  if (!r.ok) return { status: r.status, body: (await r.text()).replace(/\s+/g, " ").slice(0, 200) };
  return m.csvRows(m.csvText(await r.arrayBuffer()));
};
for (const mo of ["202609", "202610"]) {
  await step("play_overview_" + mo, () => playCsv(`stats/installs/installs_${m.PKG}_${mo}_overview.csv`));
  await step("play_country_" + mo, async () => { const x = await playCsv(`stats/installs/installs_${m.PKG}_${mo}_country.csv`); return Array.isArray(x) ? x.filter(r => (r.country ?? r.countryregion) === "IL" || Number(r.dailyuserinstalls || 0) > 0 || Number(r.totaluserinstalls || 0) > 0).map(r => ({ ...r, country: (r.country ?? r.countryregion) === "IL" ? "IL" : "other" })) : x; });
}
// 1b. Analytics, Android: every device that ever opened the app, by country; first opens, removals and data clears
await step("ga_android_by_country_alltime", async () => rows(await m.report(env, { dateRanges: ALL, dimensions: [{ name: "countryId" }], metrics: [{ name: "totalUsers" }, { name: "newUsers" }], dimensionFilter: ANDROID, limit: 100 })));
await step("ga_android_lifecycle_by_country_alltime", async () => rows(await m.report(env, { dateRanges: ALL, dimensions: [{ name: "eventName" }, { name: "countryId" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: AND(ANDROID, evs(["first_open", "app_remove", "app_clear_data", "app_update", "referral_open"])), limit: 300 })));
await step("ga_android_il_first_open_by_day", async () => rows(await m.report(env, { dateRanges: ALL, dimensions: [{ name: "date" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: AND(ANDROID, IL, evs(["first_open", "app_remove", "app_clear_data"])), limit: 1000, orderBys: [{ dimension: { dimensionName: "date" } }] })));
await step("ga_android_il_active", async () => rows(await m.report(env, { dateRanges: [{ startDate: "27daysAgo", endDate: "today" }, { startDate: "6daysAgo", endDate: "today" }, { startDate: "today", endDate: "today" }], metrics: [{ name: "activeUsers" }], dimensionFilter: AND(ANDROID, IL) })));
// devices in Israel by (hashed) model and app version: a model seen on many versions is a tester's phone (the owner's, updated at every release)
await step("ga_android_il_models", async () => {
  const rs = rows(await m.report(env, { dateRanges: ALL, dimensions: [{ name: "deviceModel" }, { name: "appVersion" }], metrics: [{ name: "totalUsers" }, { name: "eventCount" }], dimensionFilter: AND(ANDROID, IL), limit: 2000 }));
  const by = {}; for (const [model, ver, users, events] of rs) { const k = h8(model); (by[k] ||= { versions: [], usersPerVersion: [], events: 0 }); by[k].versions.push(ver); by[k].usersPerVersion.push(users); by[k].events += events; }
  return Object.entries(by).map(([k, v]) => ({ model: k, nVersions: v.versions.length, versions: v.versions.sort().join(","), maxUsersOnAVersion: Math.max(...v.usersPerVersion), events: v.events })).sort((a, b) => b.events - a.events);
});
await step("ga_android_il_models_users", async () => rows(await m.report(env, { dateRanges: ALL, dimensions: [{ name: "deviceModel" }], metrics: [{ name: "totalUsers" }, { name: "eventCount" }], dimensionFilter: AND(ANDROID, IL), limit: 500 }), r => [h8(r[0]), r[1], r[2]]));
await step("ga_android_first_day", async () => rows(await m.report(env, { dateRanges: ALL, dimensions: [{ name: "date" }], metrics: [{ name: "totalUsers" }], dimensionFilter: ANDROID, limit: 5, orderBys: [{ dimension: { dimensionName: "date" } }] })));

// 2. arrivals by channel -------------------------------------------------------------------------------------------------------
// 2a. new app devices in Israel by install source (Google Play's install referrer, e.g. a /go/ link), all time
await step("ga_installs_by_source_alltime", async () => rows(await m.report(env, { dateRanges: ALL, dimensions: [{ name: "firstUserSource" }, { name: "firstUserMedium" }, { name: "firstUserCampaignName" }], metrics: [{ name: "newUsers" }, { name: "totalUsers" }], dimensionFilter: AND(ANDROID, IL), limit: 100 })));
// 2b. app sessions in Israel by session source (does an app opened from a campaign link carry its source?)
await step("ga_app_sessions_by_source_28d", async () => rows(await m.report(env, { dateRanges: [{ startDate: "27daysAgo", endDate: "today" }], dimensions: [{ name: "sessionSource" }, { name: "sessionMedium" }], metrics: [{ name: "sessions" }, { name: "totalUsers" }], dimensionFilter: AND(ANDROID, IL), limit: 100 })));
await step("ga_app_campaign_events_alltime", async () => rows(await m.report(env, { dateRanges: ALL, dimensions: [{ name: "eventName" }, { name: "sessionSource" }], metrics: [{ name: "eventCount" }], dimensionFilter: AND(ANDROID, IL, evs(["firebase_campaign", "dynamic_link_app_open", "link_open", "referral_open"])), limit: 100 })));
await step("ga_app_link_open_alltime", async () => rows(await m.report(env, { dateRanges: ALL, dimensions: [{ name: "customEvent:via" }, { name: "customEvent:kind" }], metrics: [{ name: "eventCount" }], dimensionFilter: AND(ANDROID, IL, ev("link_open")), limit: 100 })));
// 2c. the site: visits, landings from a link, car checks, by the source the page sends (src, from 20.10), per day
await step("ga_web_by_src_daily", async () => rows(await m.report(env, { dateRanges: [{ startDate: "2026-10-19", endDate: "today" }], dimensions: [{ name: "date" }, { name: "eventName" }, { name: "customEvent:src" }], metrics: [{ name: "eventCount" }], dimensionFilter: AND(WEB, evs(["web_visit", "link_landing", "car_lookup", "web_install_click", "web_hint_click"])), limit: 1000 })));
// campaign and shared-link landings on the site since the start (before src existed, the landing carried its channel in via)
await step("ga_web_landings_alltime", async () => rows(await m.report(env, { dateRanges: ALL, dimensions: [{ name: "customEvent:kind" }, { name: "customEvent:via" }], metrics: [{ name: "eventCount" }], dimensionFilter: AND(WEB, ev("link_landing")), limit: 200 })));
await step("ga_web_install_clicks_alltime", async () => rows(await m.report(env, { dateRanges: ALL, dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: AND(WEB, evs(["web_install_click", "web_hint_click", "web_visit", "link_landing"])), limit: 20 })));
// 2d. Cloudflare: site visits by referring host since the site has existed (both site tags, without /live and headless browsers)
await step("cf_referrers_since_0810", async () => (await m.cfQuery(env, "2026-10-08", "refererHost", 100, today)).map(x => [x.dimensions.refererHost || "", Math.round(x.sum.visits), x.count]));
await step("cf_referrers_7d", async () => (await m.cfQuery(env, m.addDays(today, -7), "refererHost", 100, m.addDays(today, -1))).map(x => [x.dimensions.refererHost || "", Math.round(x.sum.visits), x.count]));
await step("cf_referrers_today", async () => (await m.cfQuery(env, today, "refererHost", 50, today)).map(x => [x.dimensions.refererHost || "", Math.round(x.sum.visits), x.count]));

// 3. the /live data snapshot (what /live/data returns), for rendering the page in a test browser ------------------------------
await step("live", async () => {
  const d = await m.collect(env);
  const c = JSON.parse(JSON.stringify(d));
  if (c.seo && c.seo.queries) c.seo.queries = c.seo.queries.map(q => [String(q[0]).replace(/\d/g, "#"), ...q.slice(1)]);
  return { ...c, flashes: (await m.getFlashes()).slice(0, 15), metrics: await m.getMetrics() };
});

console.log(JSON.stringify(out));
