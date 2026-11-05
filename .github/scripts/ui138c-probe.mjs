// One-off (probe-perf branch, not for main), 5.11.2026: the 1.38 vs 1.37 read for the red-team thread (Dudu's guardrails of 25.10).
// Reads GA4 only: the app by version (1.37 vs 1.38.x on the same days, and the old-UI week 19-25.10), the site by day with the 1.38 marker
// (role on car_lookup/tab_view), the params the guardrails need, install cohorts and GA4 cohort retention, and the check-duration buckets.
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
const D = n => ({ name: n }), M = n => ({ name: n }), C = p => ({ name: "customEvent:" + p });
const OLD = { startDate: "2026-10-19", endDate: "2026-10-25", name: "old" }, NEW = { startDate: "2026-10-26", endDate: "2026-11-04", name: "new" };
const WIN = [OLD, NEW], ALL = [{ startDate: "2026-10-19", endDate: "2026-11-04" }];

// 1. the app by version: window totals (with users) and by day
await part("appEv", () => ga({ dateRanges: WIN, dimensions: [D("appVersion"), D("eventName")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: APP }));
await part("appEvDay", () => ga({ dateRanges: ALL, dimensions: [D("date"), D("appVersion"), D("eventName")], metrics: [M("eventCount")], dimensionFilter: APP }));
await part("appUsers", () => ga({ dateRanges: WIN, dimensions: [D("appVersion")], metrics: [M("activeUsers"), M("newUsers")], dimensionFilter: APP }));
await part("appUsersDay", () => ga({ dateRanges: ALL, dimensions: [D("date"), D("appVersion")], metrics: [M("activeUsers"), M("newUsers")], dimensionFilter: APP }));
// 2. the params the guardrails need, by platform and app version, both windows (web rows carry appVersion "(not set)")
const P = [["compare_open", "from"], ["simple_view", "on"], ["car_save", "from"], ["car_save", "n"], ["car_unsave", "from"], ["share_open", "src"], ["share", "kind"], ["mine_set", "from"],
  ["file_cta_shown", "from"], ["file_cta_shown", "act"], ["calendar_reminder_click", "where"], ["calendar_reminder_shown", "where"], ["svc_add", "kind"], ["tab_view", "tab"], ["tab_view", "role"],
  ["car_lookup", "role"], ["car_lookup", "src"], ["web_hint_click", "where"], ["nav", "via"], ["nav", "to"], ["check_open", "kind"], ["doc_exp", "cat"], ["doc_scan", "kind"]];
for (const [ev, p] of P) await part(`p.${ev}.${p}`, () => ga({ dateRanges: WIN, dimensions: [D("platform"), D("appVersion"), C(p)], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: and(REAL, eq("eventName", ev)) }));
// 3. the site by day: the 1.38 marker (role on car_lookup / tab_view), every event, the key params, users
await part("webRoleDay", () => ga({ dateRanges: ALL, dimensions: [D("date"), D("eventName"), C("role")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: and(WEB, inList("eventName", ["car_lookup", "tab_view"])) }));
await part("webEvDay", () => ga({ dateRanges: ALL, dimensions: [D("date"), D("eventName")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: WEB }));
await part("webUsersDay", () => ga({ dateRanges: ALL, dimensions: [D("date")], metrics: [M("activeUsers"), M("newUsers"), M("sessions")], dimensionFilter: WEB }));
const PW = [["compare_open", "from"], ["simple_view", "on"], ["car_save", "from"], ["car_unsave", "from"], ["share_open", "src"], ["mine_set", "from"], ["web_hint_click", "where"]];
for (const [ev, p] of PW) await part(`w.${ev}.${p}`, () => ga({ dateRanges: ALL, dimensions: [D("date"), C(p)], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: and(WEB, eq("eventName", ev)) }));
// 4. how long checks took, by day, platform and version (dur buckets lt2, 2to5, 5to10, gt10)
await part("durDay", () => ga({ dateRanges: ALL, dimensions: [D("date"), D("platform"), D("appVersion"), C("dur")], metrics: [M("eventCount")], dimensionFilter: and(REAL, eq("eventName", "car_lookup")) }));
// 5. install cohorts: first_open / first_save / app_return by day, version, install day (kind) and n
await part("cohEv", () => ga({ dateRanges: ALL, dimensions: [D("date"), D("eventName"), D("appVersion"), C("kind"), C("n")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: and(APP, inList("eventName", ["first_open", "first_save", "app_return"])) }));
// GA4 cohort retention of new app users by first-session day, days 0..7, two batches of 8 cohorts
const coh = days => days.map(s => ({ name: s, dimension: "firstSessionDate", dateRange: { startDate: s, endDate: s } }));
const dayList = (from, n) => { const r = []; const d = new Date(from + "T00:00:00Z"); for (let i = 0; i < n; i++) { r.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); } return r; };
for (const [name, from] of [["cohortA", "2026-10-19"], ["cohortB", "2026-10-27"]]) await part(name, () => ga({ dimensions: [D("cohort"), D("cohortNthDay")], metrics: [M("cohortActiveUsers"), M("cohortTotalUsers")], dimensionFilter: APP,
  cohortSpec: { cohorts: coh(dayList(from, 8)), cohortsRange: { granularity: "DAILY", startOffset: 0, endOffset: 7 } } }));
// 6. the new-install day: first_open users by day and version (the cohort sizes the kind param should match)
await part("firstOpenDay", () => ga({ dateRanges: ALL, dimensions: [D("date"), D("appVersion")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: and(APP, eq("eventName", "first_open")) }));

const data = Buffer.from(JSON.stringify(out));
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(data), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/ui138c.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
console.log("written, encrypted");
