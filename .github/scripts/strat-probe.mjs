// probe-perf only, never main. 12.11.2026, CEO full review (Measurement task 2), inputs for strategy's 21.11 prep:
// 1. upgrade_open by from and upgrade_purchase_start by plan, distinct devices, app 1.38.0-1.38.4, from 26.10 (pre-launch test devices out: Israel only)
// 2. bulk_check: events and devices, app and web, and how many app devices could have run it twice or more in 14 days (GA4 has no per-device rows,
//    so the read gives bounds: extra runs = events - devices, and extra days = sum of daily devices - devices of the window)
// 3. car checks (car_lookup) on the app and on the site by day, 21.10 to the end of the window
// The window ends yesterday (Israel), or on the date in the last line of .github/strat-run.txt ("end YYYY-MM-DD"). Encrypted with .github/seo-data.pub.pem.
import crypto from "node:crypto";
import fs from "node:fs";
const E = process.env, PROP = "557990379";
const out = { generated: new Date().toISOString(), parts: {} }, log = (part, ok, why = "") => console.log(part, ok ? "ok" : "failed " + String(why).replace(/\d/g, "#").slice(0, 160));
async function part(name, fn) { try { out.parts[name] = await fn(); log(name, true); } catch (e) { out.parts[name] = { error: String(e.message || e).slice(0, 400) }; log(name, false, e.message || e); } }
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
const flat = j => ({ dims: (j.dimensionHeaders || []).map(h => h.name), mets: (j.metricHeaders || []).map(h => h.name), rows: (j.rows || []).map(r => [...r.dimensionValues.map(v => v.value), ...r.metricValues.map(v => Number(v.value))]), rowCount: j.rowCount || 0 });
let T = null;
const ga = async body => {
  T = T || await token();
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${PROP}:runReport`, { method: "POST", headers: { authorization: "Bearer " + T, "content-type": "application/json" },
    body: JSON.stringify({ limit: 100000, ...body }), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(r.status + " " + (await r.text()).slice(0, 200));
  return flat(await r.json());
};
const ilDay = (d = new Date()) => new Date(d.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
const iso = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const lastLine = fs.readFileSync(".github/strat-run.txt", "utf8").trim().split("\n").pop();
const m = /end (\d{4}-\d{2}-\d{2})/.exec(lastLine), y = ilDay(); y.setDate(y.getDate() - 1);
const END = m ? m[1] : iso(y);
out.end = END;
const f = (k, v) => ({ filter: { fieldName: k, stringFilter: { value: v } } }), inl = (k, v) => ({ filter: { fieldName: k, inListFilter: { values: v } } });
const and = (...x) => ({ andGroup: { expressions: x } });
const REAL = { orGroup: { expressions: [f("platform", "web"), f("countryId", "IL")] } };
const APP = and(f("platform", "Android"), f("countryId", "IL")), V138 = inl("appVersion", ["1.38.0", "1.38.1", "1.38.2", "1.38.3", "1.38.4"]);
const M = [{ name: "eventCount" }, { name: "totalUsers" }], PRO = inl("eventName", ["upgrade_open", "upgrade_purchase_start"]);
const R1 = [{ startDate: "2026-10-26", endDate: END }];
if (sa) {
  // 1. PRO taps
  await part("pro.versions", () => ga({ dateRanges: R1, dimensions: [{ name: "eventName" }, { name: "appVersion" }], metrics: M, dimensionFilter: and(PRO, APP) }));
  await part("pro.total", () => ga({ dateRanges: R1, dimensions: [{ name: "eventName" }], metrics: M, dimensionFilter: and(PRO, APP, V138) }));
  await part("pro.from", () => ga({ dateRanges: R1, dimensions: [{ name: "eventName" }, { name: "customEvent:from" }], metrics: M, dimensionFilter: and(f("eventName", "upgrade_open"), APP, V138) }));
  await part("pro.plan", () => ga({ dateRanges: R1, dimensions: [{ name: "eventName" }, { name: "customEvent:plan" }], metrics: M, dimensionFilter: and(f("eventName", "upgrade_purchase_start"), APP, V138) }));
  await part("pro.web", () => ga({ dateRanges: R1, dimensions: [{ name: "eventName" }, { name: "customEvent:from" }, { name: "customEvent:plan" }], metrics: [{ name: "eventCount" }], dimensionFilter: and(PRO, f("platform", "web")) }));
  await part("pro.base", () => ga({ dateRanges: R1, dimensions: [{ name: "eventName" }], metrics: M, dimensionFilter: and(inl("eventName", ["first_open", "car_lookup", "session_start"]), APP, V138) }));
  // 2. bulk_check: whole history, 14-day windows ending on END, and by day
  const BC = f("eventName", "bulk_check");
  await part("bulk.all", () => ga({ dateRanges: [{ startDate: "2026-09-01", endDate: END }], dimensions: [{ name: "platform" }], metrics: M, dimensionFilter: and(BC, REAL) }));
  const w = []; for (let i = 0; i < 4; i++) { const e = new Date(END + "T12:00:00Z"); e.setUTCDate(e.getUTCDate() - 14 * i); const s = new Date(e); s.setUTCDate(s.getUTCDate() - 13); w.push({ startDate: s.toISOString().slice(0, 10), endDate: e.toISOString().slice(0, 10), name: "w" + i }); }
  await part("bulk.win14", () => ga({ dateRanges: w, dimensions: [{ name: "platform" }], metrics: M, dimensionFilter: and(BC, REAL) }));
  await part("bulk.day", () => ga({ dateRanges: [{ startDate: w[3].startDate, endDate: END }], dimensions: [{ name: "date" }, { name: "platform" }], metrics: M, dimensionFilter: and(BC, REAL) }));
  // 3. car checks, app and site, by day from 21.10
  await part("checks.day", () => ga({ dateRanges: [{ startDate: "2026-10-21", endDate: END }], dimensions: [{ name: "date" }, { name: "platform" }], metrics: M, dimensionFilter: and(f("eventName", "car_lookup"), REAL) }));
  await part("checks.total", () => ga({ dateRanges: [{ startDate: "2026-10-21", endDate: END }], dimensions: [{ name: "platform" }, { name: "customEvent:kind" }], metrics: M, dimensionFilter: and(f("eventName", "car_lookup"), REAL) }));
}
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(JSON.stringify(out)), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/strat.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
fs.writeFileSync("out/run.txt", (E.GITHUB_RUN_ID || "local") + "\n");
console.log("written, encrypted");
