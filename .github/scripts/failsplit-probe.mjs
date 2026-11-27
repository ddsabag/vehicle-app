// One-off (data, 27.11.2026, CEO for Dudu "הבדיקות שנכשלות"): failed car checks 12.10 to 26.11 by day, hour, platform, version, kind and duration.
// Read only; the output is encrypted with .github/seo-data.pub.pem (business numbers), never printed in the clear.
import crypto from "node:crypto"; import fs from "node:fs";
const PROP = "557990379", sa = JSON.parse(process.env.GA_SERVICE_ACCOUNT_JSON);
const b64 = b => Buffer.from(b).toString("base64url"), now = Math.floor(Date.now() / 1000), head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
const claim = b64(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 }));
const sig = crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key, "base64url");
const T = (await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) })).json()).access_token;
const ga1 = async (body, offset) => { const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${PROP}:runReport`, { method: "POST", headers: { authorization: "Bearer " + T, "content-type": "application/json" }, body: JSON.stringify({ limit: 50000, offset, ...body }) }); return { status: r.status, j: await r.json() }; };
const ga = async body => { const out = { dims: body.dimensions.map(d => d.name), mets: body.metrics.map(m => m.name), rows: [] };
  try { for (let off = 0; off < 400000; off += 50000) { const { status, j } = await ga1(body, off); if (j.error) { out.err = `${status} ${j.error.message}`.slice(0, 300); break; }
      out.rows.push(...(j.rows || []).map(x => [...x.dimensionValues.map(v => v.value), ...x.metricValues.map(v => +v.value)])); out.rowCount = j.rowCount; if (out.rows.length >= (j.rowCount || 0)) break; } }
  catch (e) { out.err = String(e.message || e).slice(0, 200); }
  return out; };
const D = [{ startDate: "2026-10-12", endDate: "2026-11-26" }], dims = a => a.map(name => ({ name }));
const evs = v => ({ filter: { fieldName: "eventName", inListFilter: { values: v } } });
const REAL = { orGroup: { expressions: [{ filter: { fieldName: "platform", stringFilter: { value: "web" } } }, { filter: { fieldName: "countryId", stringFilter: { value: "IL" } } }] } };
const ALL = ["car_lookup", "lookup_failed", "lookup_timeout", "lookup_from_cache", "lookup_abort", "lookup_repeat", "lookup_slow"];
const f = v => ({ andGroup: { expressions: [evs(v), REAL] } });
const out = {};
// 1. day x platform x event x kind, events and users
out.day = await ga({ dateRanges: D, dimensions: dims(["date", "platform", "eventName", "customEvent:kind"]), metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: f(ALL) });
// users per week (users do not add up over days)
out.week = await ga({ dateRanges: D, dimensions: dims(["isoYearIsoWeek", "platform", "eventName", "customEvent:kind"]), metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: f(ALL) });
// 2+4+5. hour x platform x event x kind x dur
out.hour = await ga({ dateRanges: D, dimensions: dims(["dateHour", "platform", "eventName", "customEvent:kind", "customEvent:dur"]), metrics: [{ name: "eventCount" }], dimensionFilter: f(["car_lookup", "lookup_failed", "lookup_timeout"]) });
// 3. versions
out.ver = await ga({ dateRanges: D, dimensions: dims(["date", "platform", "appVersion", "eventName", "customEvent:kind"]), metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: f(["car_lookup", "lookup_failed", "lookup_timeout"]) });
// failures per user in the window: how concentrated (users with n failures)
out.conc = await ga({ dateRanges: D, dimensions: dims(["platform", "eventName"]), metrics: [{ name: "eventCount" }, { name: "totalUsers" }, { name: "eventCountPerUser" }], dimensionFilter: f(["car_lookup", "lookup_failed", "lookup_timeout"]) });
// web browsers and app network (connection hints) on tech failures
out.dev = await ga({ dateRanges: D, dimensions: dims(["platform", "operatingSystem", "browser", "mobileDeviceBranding", "eventName", "customEvent:kind"]), metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: f(["car_lookup", "lookup_failed", "lookup_timeout"]) });
for (const [k, v] of Object.entries(out)) console.log(`${k}: rows ${v.rows.length}${v.err ? " error " + v.err.replace(/\d{3,}/g, "#") : ""}`);
const k = crypto.randomBytes(32), iv = crypto.randomBytes(12), ci = crypto.createCipheriv("aes-256-gcm", k, iv);
const data = Buffer.concat([ci.update(JSON.stringify(out)), ci.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, k);
fs.writeFileSync("failsplit.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: ci.getAuthTag().toString("base64"), data: data.toString("base64") }));
