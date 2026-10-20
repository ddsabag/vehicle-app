// One-off (probe-go branch, not for main), 20.10 06:2x UTC: where does the morning wave come from? Cloudflare page views of the last
// 3 hours by referring site and device; GA4 standard report for today (if Google has processed it yet) by the source the site sends.
const env = { GA_SERVICE_ACCOUNT_JSON: process.env.GA_SERVICE_ACCOUNT_JSON, GA_PROPERTY_ID: process.env.GA_PROPERTY_ID || "557990379", CF_API_TOKEN: process.env.CF_API_TOKEN, CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID };
const m = await import("./live-ui.mjs");
const out = { at: new Date().toISOString() };
const step = async (k, fn) => { try { out[k] = await fn(); } catch (e) { out[k] = { error: String(e.message || e).slice(0, 300) }; } };
const rows = rs => (rs || []).map(r => [...r.dimensionValues.map(x => x.value), ...r.metricValues.map(x => Number(x.value))]);
const cf = async (dim, minutes, extra = [], limit = 60) => {
  const token = String(env.CF_API_TOKEN || "").trim(), acc = String(env.CF_ACCOUNT_ID || "").trim();
  const q = `query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){rumPageloadEventsAdaptiveGroups(filter:$f,limit:${limit},orderBy:[count_DESC]){count sum{visits} dimensions{${dim}}}}}}`;
  const f = { AND: [{ datetime_geq: new Date(Date.now() - minutes * 60e3).toISOString() }, { siteTag_in: ["03eb6fb7a75440649781d7a00b29c4ff", "5c0a33a14f5f4201b25fd680a29ae723"] }, { requestPath_notlike: "/live%" }, { userAgentBrowser_neq: "ChromeHeadless" }, ...extra] };
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: { acc, f } }) });
  const j = await r.json(); if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.data.viewer.accounts[0].rumPageloadEventsAdaptiveGroups.map(x => [...dim.split(" ").map(k => String(x.dimensions[k] ?? "")), Math.round(x.sum.visits), x.count]);
};
await step("cf_3h_referrer", () => cf("refererHost", 180));
await step("cf_3h_referrer_os", () => cf("refererHost userAgentOS", 180));
await step("cf_3h_path", () => cf("requestPath", 180, [], 20));
const AND = (...e) => ({ andGroup: { expressions: e } });
await step("ga_today_web_by_src", async () => rows(await m.report(env, { dateRanges: [{ startDate: "today", endDate: "today" }], dimensions: [{ name: "eventName" }, { name: "customEvent:src" }, { name: "customEvent:kind" }, { name: "customEvent:via" }], metrics: [{ name: "eventCount" }], dimensionFilter: AND({ filter: { fieldName: "platform", stringFilter: { value: "web" } } }, { filter: { fieldName: "eventName", inListFilter: { values: ["web_visit", "link_landing", "web_install_click", "web_hint_click"] } } }), limit: 200 })));
await step("ga_today_app_first_open_by_source", async () => rows(await m.report(env, { dateRanges: [{ startDate: "today", endDate: "today" }], dimensions: [{ name: "firstUserSource" }, { name: "firstUserMedium" }, { name: "countryId" }], metrics: [{ name: "newUsers" }], dimensionFilter: { filter: { fieldName: "platform", stringFilter: { value: "Android" } } }, limit: 50 })));
console.log(JSON.stringify(out));
