// One-off probe (data thread, 7.11): check failures of the last 14 days vs the 14 before, by kind, platform and app version.
// GA4 only, real traffic (web or Israel). The numbers are private: the JSON is encrypted with .github/seo-data.pub.pem, the log prints states only.
import crypto from "node:crypto";
import fs from "node:fs";
import { encrypt } from "./camp-data.mjs";
const J = s => { try { return JSON.parse(s); } catch { return null; } };
const PROPERTY = String(J(fs.readFileSync("analytics/ga4-admin.json", "utf8")).property || "");
async function gaToken(sa) {
  const b64 = x => Buffer.from(x).toString("base64url"), now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 }));
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) });
  return (J(await r.text()) || {}).access_token;
}
const REAL = { orGroup: { expressions: [{ filter: { fieldName: "platform", stringFilter: { value: "web" } } }, { filter: { fieldName: "countryId", stringFilter: { value: "IL" } } }] } };
const ev = names => ({ andGroup: { expressions: [{ filter: { fieldName: "eventName", inListFilter: { values: names } } }, REAL] } });
const dateRanges = [{ startDate: "14daysAgo", endDate: "yesterday", name: "now" }, { startDate: "28daysAgo", endDate: "15daysAgo", name: "before" }];
const Q = {
  events: { dateRanges, dimensions: [{ name: "platform" }, { name: "appVersion" }, { name: "eventName" }], metrics: [{ name: "eventCount" }],
    dimensionFilter: ev(["car_lookup", "lookup_failed", "lookup_timeout", "lookup_slow", "lookup_abort", "js_error", "app_exception"]), limit: 5000 },
  kinds: { dateRanges, dimensions: [{ name: "platform" }, { name: "appVersion" }, { name: "customEvent:kind" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }],
    dimensionFilter: ev(["lookup_failed"]), limit: 5000 },
  days: { dateRanges: [dateRanges[0]], dimensions: [{ name: "date" }, { name: "platform" }, { name: "customEvent:kind" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }],
    dimensionFilter: ev(["lookup_failed"]), limit: 5000 },
  hours: { dateRanges: [dateRanges[0]], dimensions: [{ name: "dateHour" }, { name: "customEvent:kind" }], metrics: [{ name: "eventCount" }],
    dimensionFilter: ev(["lookup_failed"]), limit: 5000 },
  jsdetail: { dateRanges, dimensions: [{ name: "platform" }, { name: "customEvent:kind" }], metrics: [{ name: "eventCount" }],
    dimensionFilter: ev(["js_error"]), limit: 200 },
  checks_days: { dateRanges: [dateRanges[0]], dimensions: [{ name: "date" }, { name: "platform" }], metrics: [{ name: "eventCount" }],
    dimensionFilter: ev(["car_lookup"]), limit: 5000 },
};
const sa = J(process.env.GA_SERVICE_ACCOUNT_JSON || ""); const tok = sa && await gaToken(sa);
if (!tok) { console.log("probe: no GA4 sign-in"); process.exit(1); }
const out = {};
for (const [k, body] of Object.entries(Q)) {
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:runReport`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = J(await r.text()); out[k] = r.ok ? (j.rows || []).map(x => [...x.dimensionValues.map(d => d.value), ...x.metricValues.map(m => +m.value)]) : { error: String(j?.error?.message || r.status).slice(0, 200) };
  console.log(`probe: ${k}: ${r.ok ? (out[k].length + " rows") : "error"}`);
}
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/fail-split.enc.json", JSON.stringify(encrypt(out, fs.readFileSync(".github/seo-data.pub.pem", "utf8"))));
console.log("probe: written encrypted");
