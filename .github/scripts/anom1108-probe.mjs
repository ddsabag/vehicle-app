// One-off (probe-perf branch, not for main), 8.11.2026: the Sunday anomaly review's "check" items for the week 1-7.11 vs 25-31.10.
// Hourly checks, failed checks, aborted checks and results with a missing source (partial=1) by platform; failed checks by kind per day;
// compare opens and checks by day, platform and app version since 18.10; new app users by day and first source since 12.10. Reads GA4 only.
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
  const r = await fetch(url, { method: "POST", body: JSON.stringify(body), headers: H, signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw new Error(r.status + " " + (await r.text()).slice(0, 300));
  return r.json();
}
const ga = body => call(`https://analyticsdata.googleapis.com/v1beta/properties/${PROP}:runReport`, { limit: 100000, ...body }).then(flat);
const eq = (f, v) => ({ filter: { fieldName: f, stringFilter: { value: v } } }), inList = (f, values) => ({ filter: { fieldName: f, inListFilter: { values } } });
const and = (...x) => ({ andGroup: { expressions: x } });
const REAL = { orGroup: { expressions: [eq("platform", "web"), eq("countryId", "IL")] } };
const APP = and(eq("platform", "Android"), eq("countryId", "IL"));
const D = n => ({ name: n }), M = n => ({ name: n }), C = p => ({ name: "customEvent:" + p });
const TWO = [{ startDate: "2026-10-25", endDate: "2026-11-07" }], LONG = [{ startDate: "2026-10-12", endDate: "2026-11-07" }];
await part("hourEv", () => ga({ dateRanges: TWO, dimensions: [D("dateHour"), D("platform"), D("eventName")], metrics: [M("eventCount")], dimensionFilter: and(REAL, inList("eventName", ["car_lookup", "lookup_failed", "lookup_abort", "lookup_timeout"])) }));
await part("hourPartial", () => ga({ dateRanges: TWO, dimensions: [D("dateHour"), D("platform"), C("partial")], metrics: [M("eventCount")], dimensionFilter: and(REAL, eq("eventName", "car_lookup")) }));
await part("failKindDay", () => ga({ dateRanges: TWO, dimensions: [D("date"), D("platform"), C("kind")], metrics: [M("eventCount")], dimensionFilter: and(REAL, eq("eventName", "lookup_failed")) }));
await part("abortDay", () => ga({ dateRanges: TWO, dimensions: [D("date"), D("platform"), D("appVersion")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: and(REAL, eq("eventName", "lookup_abort")) }));
await part("cmpDay", () => ga({ dateRanges: [{ startDate: "2026-10-18", endDate: "2026-11-07" }], dimensions: [D("date"), D("platform"), D("appVersion"), D("eventName")], metrics: [M("eventCount"), M("totalUsers")], dimensionFilter: and(REAL, inList("eventName", ["car_lookup", "compare_open"])) }));
await part("cmpFrom", () => ga({ dateRanges: TWO, dimensions: [D("date"), D("platform"), C("from")], metrics: [M("eventCount")], dimensionFilter: and(REAL, eq("eventName", "compare_open")) }));
await part("newDay", () => ga({ dateRanges: LONG, dimensions: [D("date"), D("firstUserSource")], metrics: [M("newUsers")], dimensionFilter: APP }));
await part("newDayCamp", () => ga({ dateRanges: LONG, dimensions: [D("date"), D("firstUserCampaignName")], metrics: [M("newUsers")], dimensionFilter: APP }));

const data = Buffer.from(JSON.stringify(out));
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(data), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/anom1108.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
console.log("written, encrypted");
