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

// B (25.10 evening): the toggles' direction, the cohort day on first_save/app_return by day, hints by place, and owners' share of tab views
const W = [{ startDate: "2026-10-19", endDate: "2026-10-25", name: "w1925" }];
const P = [["simple_view", "on"], ["alerts_toggle", "on"], ["alert_kind", "on"], ["calendar_reminder_click", "where"], ["calendar_reminder_shown", "where"], ["web_hint_click", "where"],
  ["tab_view", "own"], ["share", "exp_v"], ["exp_expose", "exp_v"], ["buy_card_open", "kind"], ["settlement_shown", "n"]];
for (const [ev, p] of P) await part(`p.${ev}.${p}`, () => ga({ dateRanges: W, dimensions: [{ name: "platform" }, { name: "appVersion" }, { name: "customEvent:" + p }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: and(REAL, eq("eventName", ev)) }));
await part("coh.byDay", () => ga({ dateRanges: [{ startDate: "2026-10-19", endDate: "today" }], dimensions: [{ name: "date" }, { name: "eventName" }, { name: "appVersion" }, { name: "customEvent:kind" }, { name: "customEvent:n" }], metrics: [{ name: "eventCount" }], dimensionFilter: and(APP, inList("eventName", ["first_save", "app_return", "check_open", "lookup_failed"])) }));
await part("coh.anyCountry", () => ga({ dateRanges: [{ startDate: "2026-10-19", endDate: "today" }], dimensions: [{ name: "eventName" }, { name: "customEvent:kind" }, { name: "countryId" }], metrics: [{ name: "eventCount" }], dimensionFilter: inList("eventName", ["first_save", "app_return"]) }));
// users who opened compare or simple view: did they also save, by version (overlap via a segment-free proxy: users of each event pair per day)
await part("lookupsPerUser", () => ga({ dateRanges: W, dimensions: [{ name: "platform" }, { name: "appVersion" }], metrics: [{ name: "eventCountPerUser" }, { name: "totalUsers" }, { name: "eventCount" }], dimensionFilter: and(REAL, eq("eventName", "car_lookup")) }));

const data = Buffer.from(JSON.stringify(out));
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(data), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/ui138b.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
console.log("written, encrypted");
