// One-off (probe-perf branch, not for main), 5.11.2026: js_error by day, kind and page for product (after the 1.38 read), plus lookup_failed kinds.
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

// js_error (web and app WebView) by day, platform, app version, kind (where) and page, 19.10-4.11; 'line' is not a GA4 dimension

// lookup events by app version in the guard's two windows (base 13.10-26.10 = 14 days before 1.38.3's D0 27.10; new 27.10-3.11), Android only
const BASE = { startDate: "2026-10-13", endDate: "2026-10-26", name: "base" }, NEWW = { startDate: "2026-10-27", endDate: "2026-11-03", name: "new" };
const AND = eq("platform", "Android");
await part("lookVer", () => ga({ dateRanges: [BASE, NEWW], dimensions: [D("appVersion"), D("eventName")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: and(AND, inList("eventName", ["car_lookup", "lookup_slow", "lookup_timeout", "lookup_abort", "lookup_failed", "lookup_repeat"])) }));
await part("durVer", () => ga({ dateRanges: [BASE, NEWW], dimensions: [D("appVersion"), C("dur")], metrics: [M("eventCount")], dimensionFilter: and(AND, eq("eventName", "car_lookup")) }));
await part("failVer", () => ga({ dateRanges: [BASE, NEWW], dimensions: [D("appVersion"), C("kind")], metrics: [M("eventCount")], dimensionFilter: and(AND, eq("eventName", "lookup_failed")) }));
await part("toDay", () => ga({ dateRanges: [{ startDate: "2026-10-13", endDate: "2026-11-04" }], dimensions: [D("date"), D("appVersion"), D("platform")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: eq("eventName", "lookup_timeout") }));


const data = Buffer.from(JSON.stringify(out));
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(data), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/ui138g.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
console.log("written, encrypted");
