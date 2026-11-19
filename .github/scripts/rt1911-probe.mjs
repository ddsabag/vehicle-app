// One-off (probe-perf branch, not for main), 19.11.2026: the red-team read for the 21.11 talk (app 1.38.x since 5.11, per 100 car_lookup).
// Reads GA4 only: events and users by app version in three windows (26.10-4.11 = the 5.11 baseline, 5-11.11, 12-18.11), the params the asks
// need (file door, file use, share, compare, saves, simple view, web js_error), closed funnels (door -> file, file -> use, simple view -> save
// and return), and GA4 cohort D1 of new app users by first-session day.
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
const fun = body => call(`https://analyticsdata.googleapis.com/v1alpha/properties/${PROP}:runFunnelReport`, body);
const eq = (f, v) => ({ filter: { fieldName: f, stringFilter: { value: v } } }), inList = (f, values) => ({ filter: { fieldName: f, inListFilter: { values } } });
const and = (...x) => ({ andGroup: { expressions: x } });
const REAL = { orGroup: { expressions: [eq("platform", "web"), eq("countryId", "IL")] } };
const APP = and(eq("platform", "Android"), eq("countryId", "IL"));
const WEB = eq("platform", "web");
const D = n => ({ name: n }), M = n => ({ name: n }), C = p => ({ name: "customEvent:" + p });
const B = { startDate: "2026-10-26", endDate: "2026-11-04", name: "base" }, W1 = { startDate: "2026-11-05", endDate: "2026-11-11", name: "w1" }, W2 = { startDate: "2026-11-12", endDate: "2026-11-18", name: "w2" };
const WIN = [B, W1, W2], SINCE = { startDate: "2026-11-05", endDate: "2026-11-18" };

// 1. events and users by app version, per window; app users per version; the site per window
await part("appEv", () => ga({ dateRanges: WIN, dimensions: [D("appVersion"), D("eventName")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: APP }));
await part("appUsers", () => ga({ dateRanges: WIN, dimensions: [D("appVersion")], metrics: [M("activeUsers"), M("newUsers")], dimensionFilter: APP }));
await part("webEv", () => ga({ dateRanges: WIN, dimensions: [D("eventName")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: WEB }));
// 2. the params, by platform and app version (web rows carry appVersion "(not set)")
const P = [["file_cta_shown", "from"], ["mine_set", "from"], ["mine_set", "saved"], ["compare_open", "from"], ["car_save", "from"], ["car_unsave", "from"], ["share_open", "src"], ["share", "kind"],
  ["simple_view", "on"], ["doc_add", "cat"], ["doc_exp", "on"], ["svc_add", "kind"], ["buy_card_open", "locked"], ["tab_view", "own"]];
for (const [ev, p] of P) await part(`p.${ev}.${p}`, () => ga({ dateRanges: WIN, dimensions: [D("platform"), D("appVersion"), C(p)], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: and(REAL, eq("eventName", ev)) }));
await part("w.js_error", () => ga({ dateRanges: WIN, dimensions: [C("kind"), C("src")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: and(WEB, eq("eventName", "js_error")) }));
await part("w.js_error.day", () => ga({ dateRanges: [{ startDate: "2026-10-26", endDate: "2026-11-18" }], dimensions: [D("date"), C("kind")], metrics: [M("eventCount")], dimensionFilter: and(WEB, eq("eventName", "js_error")) }));
await part("w.lookup.day", () => ga({ dateRanges: [{ startDate: "2026-10-26", endDate: "2026-11-18" }], dimensions: [D("date")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: and(WEB, eq("eventName", "car_lookup")) }));
// 3. closed funnels per window: the door, file use, simple view (Android 1.38.x, and the site)
const fv = { funnelFieldFilter: { fieldName: "appVersion", stringFilter: { matchType: "BEGINS_WITH", value: "1.38" } } };
const fp = p => ({ funnelFieldFilter: { fieldName: "platform", stringFilter: { value: p } } });
const st = (name, ev, plat, extra = {}) => ({ name, ...extra, filterExpression: { andGroup: { expressions: [{ funnelEventFilter: { eventName: ev } }, ...(plat === "Android" ? [fv, fp(plat)] : plat ? [fp(plat)] : [])] } } });
const stP = (name, ev, p, v, extra = {}) => ({ name, ...extra, filterExpression: { funnelEventFilter: { eventName: ev, funnelParameterFilterExpression: { funnelParameterFilter: { eventParameterName: p, stringFilter: { value: v } } } } } });
const later = s => ({ isDirectlyFollowedBy: false, withinDurationFromPriorStep: s + "s" });
const F = (dr, steps) => fun({ dateRanges: [dr], funnel: { isOpenFunnel: false, steps } });
for (const w of WIN) for (const plat of ["Android", "web"]) {
  await part(`f.door.${plat}.${w.name}`, () => F(w, [st("shown", "file_cta_shown", plat), stP("opened_overview", "mine_set", "from", "overview", later(86400))]));
  await part(`f.doorAny.${plat}.${w.name}`, () => F(w, [st("shown", "file_cta_shown", plat), { name: "opened_any", ...later(86400), filterExpression: { funnelEventFilter: { eventName: "mine_set" } } }]));
}
for (const use of ["doc_add", "doc_exp", "svc_add"]) for (const dr of [W1, W2, { ...SINCE, name: "since" }])
  await part(`f.use.${use}.${dr.name}`, () => F(dr, [st("file", "mine_set", "Android"), { name: use, ...later(1209600), filterExpression: { funnelEventFilter: { eventName: use } } }]));
const SV = { ...SINCE, name: "since" }, BV = { ...B };
for (const dr of [BV, SV]) {
  await part(`f.sv.save.${dr.name}`, () => F(dr, [st("simple", "simple_view", "Android"), { name: "save", ...later(604800), filterExpression: { funnelEventFilter: { eventName: "car_save" } } }]));
  await part(`f.lk.save.${dr.name}`, () => F(dr, [st("lookup", "car_lookup", "Android"), { name: "save", ...later(604800), filterExpression: { funnelEventFilter: { eventName: "car_save" } } }]));
  for (const [n, s] of [["d1", 172800], ["d7", 604800]]) {
    await part(`f.sv.ret.${n}.${dr.name}`, () => F(dr, [st("simple", "simple_view", "Android"), { name: "back", ...later(s), filterExpression: { funnelEventFilter: { eventName: "session_start" } } }]));
    await part(`f.lk.ret.${n}.${dr.name}`, () => F(dr, [st("lookup", "car_lookup", "Android"), { name: "back", ...later(s), filterExpression: { funnelEventFilter: { eventName: "session_start" } } }]));
  }
  await part(`f.svweb.save.${dr.name}`, () => F(dr, [st("simple", "simple_view", "web"), { name: "save", ...later(604800), filterExpression: { funnelEventFilter: { eventName: "car_save" } } }]));
}
// 4. GA4 cohort D1 of new app users by first-session day, 26.10-17.11 (three batches)
const coh = days => days.map(s => ({ name: s, dimension: "firstSessionDate", dateRange: { startDate: s, endDate: s } }));
const dayList = (from, n) => { const r = []; const d = new Date(from + "T00:00:00Z"); for (let i = 0; i < n; i++) { r.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); } return r; };
for (const [name, from, n] of [["cohA", "2026-10-26", 8], ["cohB", "2026-11-03", 8], ["cohC", "2026-11-11", 7]]) await part(name, () => ga({ dimensions: [D("cohort"), D("cohortNthDay")], metrics: [M("cohortActiveUsers"), M("cohortTotalUsers")], dimensionFilter: APP,
  cohortSpec: { cohorts: coh(dayList(from, n)), cohortsRange: { granularity: "DAILY", startOffset: 0, endOffset: 1 } } }));
// install day per version (which version the cohort installed)
await part("firstOpenDay", () => ga({ dateRanges: [{ startDate: "2026-10-26", endDate: "2026-11-18" }], dimensions: [D("date"), D("appVersion")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: and(APP, eq("eventName", "first_open")) }));

const data = Buffer.from(JSON.stringify(out));
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(data), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/rt1911.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
console.log("written, encrypted");
