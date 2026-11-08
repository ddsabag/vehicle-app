// One-off (probe-perf branch, not for main), 8.11.2026: the share-word read for 1.38.4. App IL only, 19.10 to 7.11: car_lookup, share_open and
// share by day and app version, users per version in each window (19-25.10 = 1.37, 26.10-3.11 = 1.38.0-3, 4-7.11 = 1.38.4 beside 1.38.3),
// and share_open by src. Reads GA4 only. Business numbers never reach the log or the branch in clear: the JSON is encrypted with .github/seo-data.pub.pem.
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
  const r = await fetch(url, { method: "POST", body: JSON.stringify(body), headers: H, signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw new Error(r.status + " " + (await r.text()).slice(0, 300));
  return r.json();
}
async function part(name, fn) { try { out.parts[name] = await fn(); log(name, true); } catch (e) { out.parts[name] = { error: String(e.message || e).slice(0, 500) }; log(name, false, e.message || e); } }
const flat = j => ({ dims: (j.dimensionHeaders || []).map(h => h.name), mets: (j.metricHeaders || []).map(h => h.name), rows: (j.rows || []).map(r => [...r.dimensionValues.map(v => v.value), ...r.metricValues.map(v => Number(v.value))]), rowCount: j.rowCount || 0 });
const ga = body => call(`https://analyticsdata.googleapis.com/v1beta/properties/${PROP}:runReport`, { limit: 100000, ...body }).then(flat);
const eq = (f, v) => ({ filter: { fieldName: f, stringFilter: { value: v } } }), inList = (f, values) => ({ filter: { fieldName: f, inListFilter: { values } } });
const and = (...x) => ({ andGroup: { expressions: x } });
const APP = and(eq("platform", "Android"), eq("countryId", "IL"));
const D = n => ({ name: n }), M = n => ({ name: n }), C = p => ({ name: "customEvent:" + p });
const ALL = [{ startDate: "2026-10-19", endDate: "2026-11-07" }];
const WIN = [{ startDate: "2026-10-19", endDate: "2026-10-25", name: "w137" }, { startDate: "2026-10-26", endDate: "2026-11-03", name: "w1380" }, { startDate: "2026-11-04", endDate: "2026-11-07", name: "w1384" }];
const EVS = inList("eventName", ["car_lookup", "share_open", "share"]);
await part("dayEv", () => ga({ dateRanges: ALL, dimensions: [D("date"), D("appVersion"), D("eventName")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: and(APP, EVS) }));
await part("winEv", () => ga({ dateRanges: WIN, dimensions: [D("appVersion"), D("eventName")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: and(APP, EVS) }));
await part("winUsers", () => ga({ dateRanges: WIN, dimensions: [D("appVersion")], metrics: [M("activeUsers")], dimensionFilter: APP }));
await part("srcDay", () => ga({ dateRanges: ALL, dimensions: [D("date"), D("appVersion"), C("src")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: and(APP, eq("eventName", "share_open")) }));
await part("shareKindWin", () => ga({ dateRanges: WIN, dimensions: [D("appVersion"), C("kind")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: and(APP, eq("eventName", "share")) }));

const data = Buffer.from(JSON.stringify(out));
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(data), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/share1384.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
console.log("written, encrypted");
