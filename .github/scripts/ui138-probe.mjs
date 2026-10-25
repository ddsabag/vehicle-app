// One-off (probe-perf branch, not for main), 25.10: the old-UI baseline before 1.38 (bottom nav, הרכבים שלי, alerts, car header, car file).
// Reads GA4 only: events by app version and day, the params of the events the new screens move (tab, share kind, save "from", hints),
// launch cohorts (first_save, app_return by install day), GA4 cohort retention, a funnel, and the registered dimensions and key events.
// Business numbers never reach the log or the branch in clear: the JSON is encrypted with .github/seo-data.pub.pem.
import crypto from "node:crypto";
import fs from "node:fs";
const E = process.env, PROP = "557990379";
const out = { generated: new Date().toISOString(), parts: {} }, log = (part, ok, why = "") => console.log(part, ok ? "ok" : "failed " + String(why).replace(/\d/g, "#").slice(0, 160));
const sa = JSON.parse(E.GA_SERVICE_ACCOUNT_JSON || "null");
const b64 = b => Buffer.from(b).toString("base64url");
async function token() {
  const now = Math.floor(Date.now() / 1000), head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 }));
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) });
  if (!r.ok) throw new Error("auth " + r.status);
  return (await r.json()).access_token;
}
const T = await token(), H = { authorization: "Bearer " + T, "content-type": "application/json" };
async function call(url, body) {
  const r = await fetch(url, { ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), headers: H, signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw new Error(r.status + " " + (await r.text()).slice(0, 300));
  return r.json();
}
async function part(name, fn) { try { out.parts[name] = await fn(); log(name, true); } catch (e) { out.parts[name] = { error: String(e.message || e).slice(0, 500) }; log(name, false, e.message || e); } }
const flat = j => ({ dims: (j.dimensionHeaders || []).map(h => h.name), mets: (j.metricHeaders || []).map(h => h.name), rows: (j.rows || []).map(r => [...r.dimensionValues.map(v => v.value), ...r.metricValues.map(v => Number(v.value))]), rowCount: j.rowCount || 0 });
const ga = body => call(`https://analyticsdata.googleapis.com/v1beta/properties/${PROP}:runReport`, { limit: 100000, ...body }).then(flat);
const eq = (f, v) => ({ filter: { fieldName: f, stringFilter: { value: v } } }), inList = (f, values) => ({ filter: { fieldName: f, inListFilter: { values } } });
const and = (...x) => ({ andGroup: { expressions: x } });
const REAL = { orGroup: { expressions: [eq("platform", "web"), eq("countryId", "IL")] } };
const APP = and(eq("platform", "Android"), eq("countryId", "IL"));
const WEB = eq("platform", "web");
const R = [{ startDate: "2026-10-05", endDate: "today" }];

// 1. every event by day: the app by version, the site by day
await part("evApp", () => ga({ dateRanges: R, dimensions: [{ name: "date" }, { name: "eventName" }, { name: "appVersion" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: APP }));
await part("evWeb", () => ga({ dateRanges: R, dimensions: [{ name: "date" }, { name: "eventName" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: WEB }));
// 2. users per week (unique, not summed days)
const W = [{ startDate: "2026-10-12", endDate: "2026-10-18", name: "w1218" }, { startDate: "2026-10-19", endDate: "2026-10-25", name: "w1925" }];
await part("usersWeek", () => ga({ dateRanges: W, dimensions: [{ name: "platform" }], metrics: [{ name: "activeUsers" }, { name: "newUsers" }, { name: "sessions" }, { name: "engagedSessions" }, { name: "userEngagementDuration" }], dimensionFilter: REAL }));
await part("evUsersWeek", () => ga({ dateRanges: W, dimensions: [{ name: "platform" }, { name: "eventName" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: REAL }));
await part("verUsersWeek", () => ga({ dateRanges: W, dimensions: [{ name: "appVersion" }], metrics: [{ name: "activeUsers" }, { name: "newUsers" }], dimensionFilter: APP }));
// 3. params of the events the new UI moves or relabels, by platform and app version, both weeks
const P = [["tab_view", "tab"], ["tab_view", "own"], ["share", "kind"], ["car_save", "from"], ["car_save", "n"], ["car_unsave", "from"], ["upgrade_open", "from"],
  ["web_install_click", "via"], ["check_open", "kind"], ["first_save", "kind"], ["app_return", "kind"], ["app_return", "n"], ["link_open", "kind"], ["link_open", "via"],
  ["link_landing", "kind"], ["notif_open", "kind"], ["notif_sent", "kind"], ["svc_add", "kind"], ["alert_kind", "kind"], ["user_screenshot", "tab"], ["compare_open", "from"],
  ["car_lookup", "dur"], ["lookup_failed", "kind"], ["link_out", "kind"], ["web_visit", "src"], ["car_lookup", "src"], ["share_open", "src"]];
for (const [ev, p] of P) await part(`p.${ev}.${p}`, () => ga({ dateRanges: W, dimensions: [{ name: "platform" }, { name: "appVersion" }, { name: "customEvent:" + p }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: and(REAL, eq("eventName", ev)) }));
// app_return by install day and saver flag together (the Q2 read), and first_save by install day
await part("p.app_return.kind_n", () => ga({ dateRanges: [{ startDate: "2026-10-12", endDate: "today" }], dimensions: [{ name: "customEvent:kind" }, { name: "customEvent:n" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: and(APP, eq("eventName", "app_return")) }));
await part("firstOpenDay", () => ga({ dateRanges: [{ startDate: "2026-10-05", endDate: "today" }], dimensions: [{ name: "date" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: and(APP, eq("eventName", "first_open")) }));
// 4. GA4 cohort retention of new app users by first-session day
const cohorts = []; for (let d = 12; d <= 24; d++) { const s = `2026-10-${String(d).padStart(2, "0")}`; cohorts.push({ name: s, dimension: "firstSessionDate", dateRange: { startDate: s, endDate: s } }); }
await part("cohortApp", () => ga({ dimensions: [{ name: "cohort" }, { name: "cohortNthDay" }], metrics: [{ name: "cohortActiveUsers" }, { name: "cohortTotalUsers" }], dimensionFilter: APP,
  cohortSpec: { cohorts, cohortsRange: { granularity: "DAILY", startOffset: 0, endOffset: 13 } } }));
await part("cohortAll", () => ga({ dimensions: [{ name: "cohort" }, { name: "cohortNthDay" }, { name: "platform" }], metrics: [{ name: "cohortActiveUsers" }, { name: "cohortTotalUsers" }],
  cohortSpec: { cohorts, cohortsRange: { granularity: "DAILY", startOffset: 0, endOffset: 13 } } }));
// 5. funnels (v1alpha): new app users, and site visits
const step = (name, ev) => ({ name, filterExpression: { funnelEventFilter: { eventName: ev } } });
const funnel = (steps, seg, open) => call(`https://analyticsdata.googleapis.com/v1alpha/properties/${PROP}:runFunnelReport`, { dateRanges: [{ startDate: "2026-10-12", endDate: "2026-10-18" }, { startDate: "2026-10-19", endDate: "2026-10-25" }],
  funnel: { isOpenFunnel: !!open, steps }, funnelBreakdown: { breakdownDimension: { name: "platform" } } });
await part("funnelApp", () => funnel([step("open", "first_open"), step("lookup", "car_lookup"), step("save", "car_save"), step("return", "app_return")]));
await part("funnelLookupSave", () => funnel([step("lookup", "car_lookup"), step("tab", "tab_view"), step("save", "car_save")], null, true));
await part("funnelShare", () => funnel([step("lookup", "car_lookup"), step("share_open", "share_open"), step("share", "share")]));
await part("funnelWebInstall", () => funnel([step("visit", "web_visit"), step("lookup", "car_lookup"), step("install", "web_install_click")]));
// 6. what GA4 has registered (the new params role/to/mode must exist before 1.38 data arrives)
await part("adminDims", () => call(`https://analyticsadmin.googleapis.com/v1beta/properties/${PROP}/customDimensions?pageSize=200`).then(j => (j.customDimensions || []).map(d => [d.parameterName, d.scope, d.displayName])));
await part("adminKeyEvents", () => call(`https://analyticsadmin.googleapis.com/v1beta/properties/${PROP}/keyEvents?pageSize=200`).then(j => (j.keyEvents || []).map(d => [d.eventName, d.countingMethod, d.createTime])));
await part("adminRetention", () => call(`https://analyticsadmin.googleapis.com/v1beta/properties/${PROP}/dataRetentionSettings`));

const data = Buffer.from(JSON.stringify(out));
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(data), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/ui138.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
console.log("written, encrypted");
