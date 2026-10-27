// One-off (probe-perf branch, not for main), 23.10: how slow are car checks really, for Dudu's question whether "בדיקות איטיות" (lookup_slow,
// a note shown after 3.5 s) should be redefined. GA4 only: lookups, slow notes, cancels, time-outs and failures by day, platform and app
// version, and the duration buckets car_lookup carries (dur: lt2 / 2to5 / 5to10 / gt10). Business numbers never reach the log or the branch
// in clear: the JSON is encrypted with .github/seo-data.pub.pem and the log says only which part answered.
// Re-run 27.10: zone A (release-guard.mjs) found slow checks over 10% on 26.10; ga.durV and ga.hourDurV split car_lookup durations by
// version, partial and hour for 24.10 on, to tell a slow source (all versions at the same hours) from a version that times differently.
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
  const r = await fetch(url, { method: "POST", body: JSON.stringify(body), headers: H, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(r.status + " " + (await r.text()).slice(0, 200));
  return r.json();
}
async function part(name, fn) { try { out.parts[name] = await fn(); log(name, true); } catch (e) { out.parts[name] = { error: String(e.message || e).slice(0, 400) }; log(name, false, e.message || e); } }
const flat = j => ({ dims: (j.dimensionHeaders || []).map(h => h.name), mets: (j.metricHeaders || []).map(h => h.name), rows: (j.rows || []).map(r => [...r.dimensionValues.map(v => v.value), ...r.metricValues.map(v => Number(v.value))]), rowCount: j.rowCount || 0 });
const ga = body => call(`https://analyticsdata.googleapis.com/v1beta/properties/${PROP}:runReport`, { limit: 100000, ...body }).then(flat);
const eq = (f, v) => ({ filter: { fieldName: f, stringFilter: { value: v } } }), inList = (f, values) => ({ filter: { fieldName: f, inListFilter: { values } } });
const REAL = { orGroup: { expressions: [eq("platform", "web"), eq("countryId", "IL")] } };
const and = (...x) => ({ andGroup: { expressions: x } });
const R = [{ startDate: "2026-10-12", endDate: "today" }];
const LOOK = ["car_lookup", "lookup_repeat", "lookup_slow", "lookup_abort", "lookup_timeout", "lookup_failed", "lookup_from_cache"];
const dims = (...n) => n.map(name => ({ name }));

await part("ga.events", () => ga({ dateRanges: R, dimensions: dims("date", "platform", "appVersion", "eventName"), metrics: [{ name: "eventCount" }], dimensionFilter: and(REAL, inList("eventName", LOOK)) }));
await part("ga.dur", () => ga({ dateRanges: R, dimensions: dims("date", "platform", "appVersion", "eventName", "customEvent:dur"), metrics: [{ name: "eventCount" }], dimensionFilter: and(REAL, inList("eventName", ["car_lookup", "lookup_repeat", "lookup_failed"])) }));
await part("ga.durKind", () => ga({ dateRanges: R, dimensions: dims("platform", "eventName", "customEvent:kind", "customEvent:partial", "customEvent:dur"), metrics: [{ name: "eventCount" }], dimensionFilter: and(REAL, inList("eventName", ["car_lookup", "lookup_failed"])) }));
await part("ga.hour", () => ga({ dateRanges: [{ startDate: "2026-10-21", endDate: "today" }], dimensions: dims("dateHour", "platform", "eventName"), metrics: [{ name: "eventCount" }], dimensionFilter: and(REAL, inList("eventName", ["car_lookup", "lookup_slow"])) }));
await part("ga.hourDur", () => ga({ dateRanges: [{ startDate: "2026-10-21", endDate: "today" }], dimensions: dims("dateHour", "platform", "customEvent:dur"), metrics: [{ name: "eventCount" }], dimensionFilter: and(REAL, eq("eventName", "car_lookup")) }));
await part("ga.durV", () => ga({ dateRanges: [{ startDate: "2026-10-19", endDate: "today" }], dimensions: dims("date", "platform", "appVersion", "customEvent:partial", "customEvent:dur"), metrics: [{ name: "eventCount" }], dimensionFilter: and(REAL, eq("eventName", "car_lookup")) }));
await part("ga.hourDurV", () => ga({ dateRanges: [{ startDate: "2026-10-24", endDate: "today" }], dimensions: dims("dateHour", "platform", "appVersion", "customEvent:dur"), metrics: [{ name: "eventCount" }], dimensionFilter: and(REAL, eq("eventName", "car_lookup")) }));
await part("ga.failKind", () => ga({ dateRanges: [{ startDate: "2026-10-19", endDate: "today" }], dimensions: dims("date", "platform", "appVersion", "customEvent:kind", "customEvent:dur"), metrics: [{ name: "eventCount" }], dimensionFilter: and(REAL, eq("eventName", "lookup_failed")) }));
await part("ga.users", () => ga({ dateRanges: [{ startDate: "2026-10-22", endDate: "today" }], dimensions: dims("platform", "eventName"), metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: and(REAL, inList("eventName", ["car_lookup", "lookup_slow", "lookup_abort"])) }));

const data = Buffer.from(JSON.stringify(out));
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(data), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/slow.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
console.log("written, encrypted");
