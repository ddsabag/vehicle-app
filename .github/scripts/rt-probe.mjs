// One-off (probe-go branch, not for main), 20.10: the burst of first opens and site landings right now: Google Play test devices or people?
// GA4 realtime by platform, country and app version; Cloudflare page views of the last 2 hours by country, device, browser and page kind.
// Aggregates only; pages are reduced to their kind (home with ?plate=, home, model page...), never a plate.
const env = { GA_SERVICE_ACCOUNT_JSON: process.env.GA_SERVICE_ACCOUNT_JSON, GA_PROPERTY_ID: process.env.GA_PROPERTY_ID || "557990379", CF_API_TOKEN: process.env.CF_API_TOKEN, CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID };
const m = await import("./live-ui.mjs");
const out = { at: new Date().toISOString() };
const step = async (k, fn) => { try { out[k] = await fn(); } catch (e) { out[k] = { error: String(e.message || e).slice(0, 300) }; } };
const rt = async body => { const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${env.GA_PROPERTY_ID}:runRealtimeReport`, { method: "POST", headers: { authorization: "Bearer " + await m.googleToken(env), "content-type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200)); return (j.rows || []).map(r => [...r.dimensionValues.map(x => x.value), ...r.metricValues.map(x => Number(x.value))]); };
const evs = vs => ({ filter: { fieldName: "eventName", inListFilter: { values: vs } } });
await step("rt_by_platform_country_event", () => rt({ dimensions: [{ name: "platform" }, { name: "countryId" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: evs(["first_open", "link_landing", "web_visit", "car_lookup", "session_start"]), limit: 100 }));
await step("rt_android_by_version_country", () => rt({ dimensions: [{ name: "appVersion" }, { name: "countryId" }], metrics: [{ name: "activeUsers" }], dimensionFilter: { filter: { fieldName: "platform", stringFilter: { value: "Android" } } }, limit: 50 }));
await step("rt_by_minute", () => rt({ dimensions: [{ name: "minutesAgo" }, { name: "platform" }], metrics: [{ name: "eventCount" }], dimensionFilter: evs(["first_open", "link_landing", "web_visit"]), limit: 100 }));
await step("rt_web_device", () => rt({ dimensions: [{ name: "deviceCategory" }, { name: "countryId" }], metrics: [{ name: "activeUsers" }], dimensionFilter: { filter: { fieldName: "platform", stringFilter: { value: "web" } } }, limit: 50 }));
const cf = async (dim, minutes, extra = [], limit = 60) => {
  const token = String(env.CF_API_TOKEN || "").trim(), acc = String(env.CF_ACCOUNT_ID || "").trim();
  const q = `query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){rumPageloadEventsAdaptiveGroups(filter:$f,limit:${limit},orderBy:[count_DESC]){count sum{visits} dimensions{${dim}}}}}}`;
  const f = { AND: [{ datetime_geq: new Date(Date.now() - minutes * 60e3).toISOString() }, { siteTag_in: ["03eb6fb7a75440649781d7a00b29c4ff", "5c0a33a14f5f4201b25fd680a29ae723"] }, { requestPath_notlike: "/live%" }, ...extra] };
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: { acc, f } }) });
  const j = await r.json(); if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data.viewer.accounts[0].rumPageloadEventsAdaptiveGroups.map(x => [...dim.split(" ").map(k => String(x.dimensions[k] ?? "")), Math.round(x.sum.visits), x.count]);
};
await step("cf_2h_country_device_browser", () => cf("countryName deviceType userAgentBrowser userAgentOS", 120));
await step("cf_2h_by_15min", () => cf("datetimeFifteenMinutes countryName", 120, [], 100));
await step("cf_12h_country", () => cf("countryName", 720));
await step("cf_7d_country", () => cf("countryName", 7 * 1440, [{ userAgentBrowser_neq: "ChromeHeadless" }]));
console.log(JSON.stringify(out));
