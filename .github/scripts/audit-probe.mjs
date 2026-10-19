// One-off (probe-go branch, not for main): analytics audit, round 2. Aggregates only. This report lands on a public branch, so device
// models and cities are printed as short hashes, never by name, and ids are cut to a prefix.
import crypto from "node:crypto";
const env = process.env, P = env.GA_PROPERTY_ID || "557990379", CF_TAG = "9bb0e756882c478a808d95596e0deade";
const h = s => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 6);
const cut = s => String(s || "").slice(0, 6) + "…";
console.log("at", new Date().toISOString());
const sa = JSON.parse(env.GA_SERVICE_ACCOUNT_JSON);
const b64 = o => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url"), now = Math.floor(Date.now() / 1000);
const un = b64({alg: "RS256", typ: "JWT"}) + "." + b64({iss: sa.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600});
const jwt = un + "." + crypto.createSign("RSA-SHA256").update(un).sign(sa.private_key).toString("base64url");
const tok = (await (await fetch("https://oauth2.googleapis.com/token", {method: "POST", headers: {"content-type": "application/x-www-form-urlencoded"}, body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + jwt})).json()).access_token;
const call = async (kind, body) => { const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${P}:${kind}`, {method: "POST", headers: {authorization: "Bearer " + tok, "content-type": "application/json"}, body: JSON.stringify(body)}); const j = await r.json(); if (!r.ok) { console.log("ERR", kind, JSON.stringify(j).slice(0, 300)); return []; } return j.rows || []; };
const admin = async path => { const r = await fetch("https://analyticsadmin.googleapis.com/v1beta/" + path, {headers: {authorization: "Bearer " + tok}}); const j = await r.json().catch(() => null); if (!r.ok) { console.log("ADMIN ERR", path.replace(/\d{6,}/g, "N"), r.status, JSON.stringify(j).slice(0, 200)); return null; } return j; };
const show = (title, rows, hashCols = []) => { console.log("\n## " + title); for (const r of rows || []) console.log((r.dimensionValues || []).map((x, i) => hashCols.includes(i) ? "#" + h(x.value) : x.value).join(" | ") + "  =>  " + r.metricValues.map(x => x.value).join(" / ")); };
const ev = v => ({filter: {fieldName: "eventName", stringFilter: {value: v}}}), and = (...e) => ({andGroup: {expressions: e}});
const eq = (f, v) => ({filter: {fieldName: f, stringFilter: {value: v}}});
const ANDROID_IL = and(eq("platform", "Android"), eq("countryId", "IL")), WEB = eq("platform", "web");
const W = {startDate: "7daysAgo", endDate: "yesterday"}, D28 = {startDate: "28daysAgo", endDate: "yesterday"};

// ---- A. GA4 property settings ----
console.log("\n===== A. GA4 Admin");
const prop = await admin(`properties/${P}`);
if (prop) console.log("property: timeZone", prop.timeZone, "| currency", prop.currencyCode, "| created", prop.createTime, "| level", prop.serviceLevel, "| industry", prop.industryCategory);
const streams = await admin(`properties/${P}/dataStreams?pageSize=50`);
for (const s of streams?.dataStreams || []) console.log("stream:", s.type, "|", s.displayName, "| created", s.createTime, "|", s.webStreamData ? "web " + s.webStreamData.defaultUri + " mid " + cut(s.webStreamData.measurementId) : "", s.androidAppStreamData ? "android " + s.androidAppStreamData.packageName : "");
const dims = await admin(`properties/${P}/customDimensions?pageSize=200`);
console.log("custom dimensions:", (dims?.customDimensions || []).map(d => `${d.parameterName}(${d.scope})`).join(", "));
const keys = await admin(`properties/${P}/keyEvents?pageSize=50`);
console.log("key events:", (keys?.keyEvents || []).map(k => `${k.eventName}(${k.countingMethod})`).join(", "));
const ret = await admin(`properties/${P}/dataRetentionSettings`);
if (ret) console.log("retention:", ret.eventDataRetention, "| reset on activity", ret.resetUserDataOnNewActivity);

// ---- B. Cloudflare Web Analytics: which site tag carries the data ----
console.log("\n===== B. Cloudflare");
const cfTok = String(env.CF_API_TOKEN || "").replace(/^[\s"']*(bearer\s+)?/i, "").replace(/[\s"']+$/, ""), acc = String(env.CF_ACCOUNT_ID || "").trim();
const cf = async (path) => { const r = await fetch("https://api.cloudflare.com/client/v4/" + path, {headers: {authorization: "Bearer " + cfTok}}); const j = await r.json().catch(() => null); if (!r.ok || !j?.success) { console.log("CF REST ERR", path.split("?")[0].replace(acc, "ACC"), r.status, JSON.stringify(j?.errors || j).slice(0, 240)); return null; } return j; };
const gql = async (query, variables) => { const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {method: "POST", headers: {authorization: "Bearer " + cfTok, "content-type": "application/json"}, body: JSON.stringify({query, variables})}); const j = await r.json().catch(() => null); if (!r.ok || j?.errors) { console.log("CF GQL ERR", r.status, JSON.stringify(j?.errors || j).slice(0, 300)); return null; } return j.data; };
const sites = await cf(`accounts/${acc}/rum/site_info/list?per_page=50`);
for (const s of sites?.result || []) console.log("rum site: host", s.host, "| site_tag", s.site_tag, "| token starts", cut(s.site_token), "| token == page token:", s.site_token === CF_TAG, "| tag == page token:", s.site_tag === CF_TAG, "| auto_install", s.auto_install, "| created", s.created, "| rules", (s.rules || []).length);
const t7 = new Date(Date.now() - 7 * 864e5).toISOString(), tNow = new Date().toISOString();
for (const dim of ["siteTag", "requestHost", "date"]) {
  const d = await gql(`query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){rumPageloadEventsAdaptiveGroups(filter:$f,limit:30,orderBy:[sum_visits_DESC]){count sum{visits} dimensions{${dim}}}}}}`, {acc, f: {AND: [{datetime_geq: t7, datetime_lt: tNow}]}});
  console.log(`rum 7d, no site filter, by ${dim}:`, JSON.stringify((d?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || []).map(g => [g.dimensions[dim], g.count, g.sum.visits])));
}
const d30 = await gql(`query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){rumPageloadEventsAdaptiveGroups(filter:$f,limit:40,orderBy:[date_ASC]){count sum{visits} dimensions{date}}}}}`, {acc, f: {AND: [{datetime_geq: new Date(Date.now() - 30 * 864e5).toISOString(), datetime_lt: tNow}, {siteTag: CF_TAG}]}});
console.log("rum 30d with the page token as siteTag, by date:", JSON.stringify((d30?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || []).map(g => [g.dimensions.date, g.count, g.sum.visits])));
for (const s of sites?.result || []) if (s.site_tag && s.site_tag !== CF_TAG) {
  const d = await gql(`query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){rumPageloadEventsAdaptiveGroups(filter:$f,limit:40,orderBy:[date_ASC]){count sum{visits} dimensions{date}}}}}`, {acc, f: {AND: [{datetime_geq: new Date(Date.now() - 30 * 864e5).toISOString(), datetime_lt: tNow}, {siteTag: s.site_tag}]}});
  console.log(`rum 30d with site_tag of ${s.host}, by date:`, JSON.stringify((d?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || []).map(g => [g.dimensions.date, g.count, g.sum.visits])));
}
const zones = await cf("zones?name=luchit.app");
const zone = zones?.result?.[0];
if (zone) {
  console.log("zone:", zone.name, "| status", zone.status, "| plan", zone.plan?.name, "| id starts", cut(zone.id));
  const z = await gql(`query($z:String!,$a:Date!,$b:Date!){viewer{zones(filter:{zoneTag:$z}){httpRequests1dGroups(limit:10,filter:{date_geq:$a,date_leq:$b},orderBy:[date_ASC]){dimensions{date} sum{requests pageViews} uniq{uniques}}}}}`, {z: zone.id, a: new Date(Date.now() - 8 * 864e5).toISOString().slice(0, 10), b: new Date().toISOString().slice(0, 10)});
  console.log("zone requests by day [date, requests, pageViews, uniques]:", JSON.stringify((z?.viewer?.zones?.[0]?.httpRequests1dGroups || []).map(g => [g.dimensions.date, g.sum.requests, g.sum.pageViews, g.uniq.uniques])));
}

// ---- C. Android in Israel: how concentrated (own testing) ----
console.log("\n===== C. Android IL concentration (models/cities hashed)");
show("C1 W: car_lookup by deviceModel (events / users)", await call("runReport", {dateRanges: [W], dimensions: [{name: "deviceModel"}], metrics: [{name: "eventCount"}, {name: "totalUsers"}], dimensionFilter: and(ev("car_lookup"), ANDROID_IL), orderBys: [{metric: {metricName: "eventCount"}, desc: true}], limit: 30}), [0]);
show("C2 W: all events by deviceModel (events / users)", await call("runReport", {dateRanges: [W], dimensions: [{name: "deviceModel"}], metrics: [{name: "eventCount"}, {name: "totalUsers"}], dimensionFilter: ANDROID_IL, orderBys: [{metric: {metricName: "eventCount"}, desc: true}], limit: 30}), [0]);
show("C3 W: car_lookup by city (events / users)", await call("runReport", {dateRanges: [W], dimensions: [{name: "city"}], metrics: [{name: "eventCount"}, {name: "totalUsers"}], dimensionFilter: and(ev("car_lookup"), ANDROID_IL), orderBys: [{metric: {metricName: "eventCount"}, desc: true}], limit: 30}), [0]);
show("C4 W: car_lookup by deviceModel x appVersion (events / users)", await call("runReport", {dateRanges: [W], dimensions: [{name: "deviceModel"}, {name: "appVersion"}], metrics: [{name: "eventCount"}, {name: "totalUsers"}], dimensionFilter: and(ev("car_lookup"), ANDROID_IL), orderBys: [{metric: {metricName: "eventCount"}, desc: true}], limit: 30}), [0]);
show("C5 28d: car_lookup by date x deviceModel (events)", await call("runReport", {dateRanges: [D28], dimensions: [{name: "date"}, {name: "deviceModel"}], metrics: [{name: "eventCount"}, {name: "totalUsers"}], dimensionFilter: and(ev("car_lookup"), ANDROID_IL), orderBys: [{dimension: {dimensionName: "date"}}], limit: 200}), [1]);
show("C6 W: share / simple_view / car_save / alerts_toggle by deviceModel", await call("runReport", {dateRanges: [W], dimensions: [{name: "eventName"}, {name: "deviceModel"}], metrics: [{name: "eventCount"}, {name: "totalUsers"}], dimensionFilter: and({filter: {fieldName: "eventName", inListFilter: {values: ["share", "simple_view", "car_save", "alerts_toggle", "first_open", "app_update"]}}}, ANDROID_IL), orderBys: [{metric: {metricName: "eventCount"}, desc: true}], limit: 60}), [1]);
show("C7 W: users by firstUserSource (Android IL, new users)", await call("runReport", {dateRanges: [W], dimensions: [{name: "firstUserSource"}, {name: "firstUserMedium"}], metrics: [{name: "newUsers"}, {name: "activeUsers"}], dimensionFilter: ANDROID_IL, limit: 30}));

// ---- C'. Android outside Israel and without a country ----
show("C8 28d: Android by country (events / users / first_open users via newUsers)", await call("runReport", {dateRanges: [D28], dimensions: [{name: "countryId"}], metrics: [{name: "eventCount"}, {name: "totalUsers"}, {name: "newUsers"}], dimensionFilter: eq("platform", "Android"), limit: 60, orderBys: [{metric: {metricName: "totalUsers"}, desc: true}]}));
show("C9 28d: Android no-country by date x deviceModel (events / users)", await call("runReport", {dateRanges: [D28], dimensions: [{name: "date"}, {name: "deviceModel"}, {name: "countryId"}], metrics: [{name: "eventCount"}, {name: "totalUsers"}], dimensionFilter: and(eq("platform", "Android"), {filter: {fieldName: "countryId", inListFilter: {values: ["(not set)", ""]}}}), orderBys: [{dimension: {dimensionName: "date"}}], limit: 150}), [1]);
show("C10 28d: Android no-country by deviceModel x city (users)", await call("runReport", {dateRanges: [D28], dimensions: [{name: "deviceModel"}, {name: "city"}], metrics: [{name: "totalUsers"}, {name: "eventCount"}], dimensionFilter: and(eq("platform", "Android"), {filter: {fieldName: "countryId", inListFilter: {values: ["(not set)", ""]}}}), limit: 40}), [0, 1]);

// ---- D. links and the site, today ----
console.log("\n===== D. links and the site");
show("D1 yesterday+today: link_landing by dateHour | kind | via", await call("runReport", {dateRanges: [{startDate: "yesterday", endDate: "today"}], dimensions: [{name: "dateHour"}, {name: "customEvent:kind"}, {name: "customEvent:via"}], metrics: [{name: "eventCount"}, {name: "totalUsers"}], dimensionFilter: ev("link_landing"), orderBys: [{dimension: {dimensionName: "dateHour"}}], limit: 200}));
show("D2 today: web events (events / users)", await call("runReport", {dateRanges: [{startDate: "today", endDate: "today"}], dimensions: [{name: "eventName"}], metrics: [{name: "eventCount"}, {name: "totalUsers"}], dimensionFilter: WEB, limit: 60, orderBys: [{metric: {metricName: "eventCount"}, desc: true}]}));
show("D3 realtime: users by platform", await call("runRealtimeReport", {dimensions: [{name: "platform"}], metrics: [{name: "activeUsers"}]}));
show("D4 realtime web: events", await call("runRealtimeReport", {dimensions: [{name: "eventName"}], metrics: [{name: "eventCount"}, {name: "activeUsers"}], dimensionFilter: WEB, limit: 40}));
show("D5 realtime Android: events by country", await call("runRealtimeReport", {dimensions: [{name: "countryId"}, {name: "eventName"}], metrics: [{name: "eventCount"}], dimensionFilter: eq("platform", "Android"), limit: 60}));

// ---- E. duplicates: events per GA4 "user" (on the site one user = one page load) ----
console.log("\n===== E. events per user (a web event above 1 per user that should fire once per page = a double count)");
show("E1 28d web: per event (events / users / per user)", await call("runReport", {dateRanges: [{startDate: "28daysAgo", endDate: "today"}], dimensions: [{name: "eventName"}], metrics: [{name: "eventCount"}, {name: "totalUsers"}, {name: "eventCountPerUser"}], dimensionFilter: WEB, limit: 80, orderBys: [{metric: {metricName: "eventCount"}, desc: true}]}));
show("E2 28d web: link_landing by kind (events / users / per user)", await call("runReport", {dateRanges: [{startDate: "28daysAgo", endDate: "today"}], dimensions: [{name: "customEvent:kind"}, {name: "customEvent:via"}], metrics: [{name: "eventCount"}, {name: "totalUsers"}, {name: "eventCountPerUser"}], dimensionFilter: and(ev("link_landing"), WEB), limit: 80}));
show("E3 28d Android IL: per event (events / users / per user)", await call("runReport", {dateRanges: [D28], dimensions: [{name: "eventName"}], metrics: [{name: "eventCount"}, {name: "totalUsers"}, {name: "eventCountPerUser"}], dimensionFilter: ANDROID_IL, limit: 80, orderBys: [{metric: {metricName: "eventCount"}, desc: true}]}));
show("E4 28d: car_lookup by platform | kind (events / users)", await call("runReport", {dateRanges: [D28], dimensions: [{name: "platform"}, {name: "customEvent:kind"}], metrics: [{name: "eventCount"}, {name: "totalUsers"}], dimensionFilter: ev("car_lookup"), limit: 40}));
show("E5 28d: streams (events by streamName | platform)", await call("runReport", {dateRanges: [D28], dimensions: [{name: "streamName"}, {name: "platform"}], metrics: [{name: "eventCount"}, {name: "totalUsers"}], limit: 20}));
