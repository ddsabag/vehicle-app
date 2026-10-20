// One-off (probe-go branch, not for main), 20.10: are the channel arrivals real people? Landings by day, device and browser; Cloudflare
// visits from Facebook by page and device; the newest app first opens by source. Aggregates only, no cities, no identifiers.
const env = { GA_SERVICE_ACCOUNT_JSON: process.env.GA_SERVICE_ACCOUNT_JSON, GA_PROPERTY_ID: process.env.GA_PROPERTY_ID || "557990379", CF_API_TOKEN: process.env.CF_API_TOKEN, CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID };
const m = await import("./live-ui.mjs");
const out = { at: new Date().toISOString() };
const rows = rs => (rs || []).map(r => [...r.dimensionValues.map(x => x.value), ...r.metricValues.map(x => Number(x.value))]);
const step = async (k, fn) => { try { out[k] = await fn(); } catch (e) { out[k] = { error: String(e.message || e).slice(0, 300) }; } };
const AND = (...e) => ({ andGroup: { expressions: e } }), ev = v => ({ filter: { fieldName: "eventName", stringFilter: { value: v } } }), evs = vs => ({ filter: { fieldName: "eventName", inListFilter: { values: vs } } });
const WEB = { filter: { fieldName: "platform", stringFilter: { value: "web" } } }, ANDROID = { filter: { fieldName: "platform", stringFilter: { value: "Android" } } }, IL = { filter: { fieldName: "countryId", stringFilter: { value: "IL" } } };
const ALL = [{ startDate: "2026-08-01", endDate: "today" }], today = m.ilDay(Date.now());
await step("landings_by_day_device", async () => rows(await m.report(env, { dateRanges: ALL, dimensions: [{ name: "date" }, { name: "customEvent:kind" }, { name: "customEvent:via" }, { name: "deviceCategory" }, { name: "operatingSystem" }, { name: "browser" }], metrics: [{ name: "eventCount" }], dimensionFilter: AND(WEB, ev("link_landing")), limit: 500, orderBys: [{ dimension: { dimensionName: "date" } }] })));
await step("landings_by_hour_1019", async () => rows(await m.report(env, { dateRanges: [{ startDate: "2026-10-18", endDate: "today" }], dimensions: [{ name: "dateHour" }, { name: "customEvent:via" }], metrics: [{ name: "eventCount" }], dimensionFilter: AND(WEB, ev("link_landing")), limit: 500, orderBys: [{ dimension: { dimensionName: "dateHour" } }] })));
await step("web_today_by_src", async () => rows(await m.report(env, { dateRanges: [{ startDate: "yesterday", endDate: "today" }], dimensions: [{ name: "date" }, { name: "eventName" }, { name: "customEvent:src" }], metrics: [{ name: "eventCount" }], dimensionFilter: AND(WEB, evs(["web_visit", "link_landing", "car_lookup"])), limit: 200 })));
await step("first_open_by_day_source", async () => rows(await m.report(env, { dateRanges: [{ startDate: "2026-10-15", endDate: "today" }], dimensions: [{ name: "date" }, { name: "firstUserSource" }, { name: "firstUserMedium" }, { name: "countryId" }], metrics: [{ name: "eventCount" }], dimensionFilter: AND(ANDROID, ev("first_open")), limit: 100 })));
await step("realtime_web_events", async () => (await (async () => { const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${env.GA_PROPERTY_ID}:runRealtimeReport`, { method: "POST", headers: { authorization: "Bearer " + await m.googleToken(env), "content-type": "application/json" }, body: JSON.stringify({ dimensions: [{ name: "platform" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], limit: 50 }) }); return (await r.json()).rows || []; })()).map(r => [...r.dimensionValues.map(x => x.value), ...r.metricValues.map(x => Number(x.value))]));
const cf = async (from, to, dim, extra = [], limit = 60) => {
  const token = String(env.CF_API_TOKEN || "").trim(), acc = String(env.CF_ACCOUNT_ID || "").trim();
  const q = `query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){rumPageloadEventsAdaptiveGroups(filter:$f,limit:${limit},orderBy:[count_DESC]){count sum{visits} dimensions{${dim}}}}}}`;
  const f = { AND: [{ datetime_geq: m.ilStart(from), datetime_lt: m.ilStart(m.addDays(to, 1)) }, { siteTag_in: ["03eb6fb7a75440649781d7a00b29c4ff", "5c0a33a14f5f4201b25fd680a29ae723"] }, { requestPath_notlike: "/live%" }, { userAgentBrowser_neq: "ChromeHeadless" }, ...extra] };
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: { acc, f } }) });
  const j = await r.json(); if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  return j.data.viewer.accounts[0].rumPageloadEventsAdaptiveGroups.map(x => [...dim.split(" ").map(k => String(x.dimensions[k] ?? "")), Math.round(x.sum.visits), x.count]);
};
await step("cf_facebook_by_day_page_device", () => cf("2026-10-08", today, "date refererHost requestPath deviceType userAgentBrowser", [{ refererHost_like: "%facebook%" }]));
await step("cf_social_hosts_by_day", () => cf("2026-10-08", today, "date refererHost", [{ refererHost_neq: "" }, { refererHost_neq: "luchit.app" }], 100));
await step("cf_visits_by_day", () => cf("2026-10-08", today, "date", [], 30));
console.log(JSON.stringify(out));
