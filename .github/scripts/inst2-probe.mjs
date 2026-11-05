// One-off (probe-perf branch, not for main), 5.11.2026: why the installs in Play Console differ from /live (Dudu 19:14 UTC). Reads Google
// Play's own monthly installs and store reports (overview = all countries, country = by country) and GA4's new Android users and first
// opens by day and country, Oct-Nov 2026. Business numbers never reach the log or the branch in clear: the JSON is encrypted with
// .github/seo-data.pub.pem and the log says only which part answered.
import crypto from "node:crypto";
import fs from "node:fs";
const E = process.env, PKG = "com.ddsabag.pratirechev", PROP = "557990379", BUCKET = "pubsite_prod_4688106336294834537";
const out = { generated: new Date().toISOString(), parts: {} }, log = (part, ok, why = "") => console.log(part, ok ? "ok" : "failed " + String(why).replace(/\d/g, "#").slice(0, 160));
const sa = JSON.parse(E.GA_SERVICE_ACCOUNT_JSON || "null");
const b64 = b => Buffer.from(b).toString("base64url");
async function token() {
  const now = Math.floor(Date.now() / 1000), head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const scope = ["analytics.readonly", "devstorage.read_only"].map(x => "https://www.googleapis.com/auth/" + x).join(" ");
  const claim = b64(JSON.stringify({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 }));
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) });
  if (!r.ok) throw new Error("auth " + r.status);
  return (await r.json()).access_token;
}
const T = await token(), H = { authorization: "Bearer " + T, "content-type": "application/json" };
async function call(url, body, raw = false) {
  const r = await fetch(url, { ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), headers: H, signal: AbortSignal.timeout(60000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(r.status + " " + (await r.text()).slice(0, 200));
  return raw ? Buffer.from(await r.arrayBuffer()) : r.json();
}
async function part(name, fn) { try { out.parts[name] = await fn(); log(name, true); } catch (e) { out.parts[name] = { error: String(e.message || e).slice(0, 400) }; log(name, false, e.message || e); } }
const flat = j => ({ dims: (j.dimensionHeaders || []).map(h => h.name), mets: (j.metricHeaders || []).map(h => h.name), rows: (j.rows || []).map(r => [...r.dimensionValues.map(v => v.value), ...r.metricValues.map(v => Number(v.value))]) });
const ga = body => call(`https://analyticsdata.googleapis.com/v1beta/properties/${PROP}:runReport`, { limit: 100000, ...body }).then(flat);
const csv = b => { if (!b) return null; const le = b[0] === 0xff && b[1] === 0xfe; const t = le ? b.subarray(2).toString("utf16le") : b.toString("utf8");
  const lines = t.split(/\r?\n/).filter(l => l.trim()); const split = l => { const o = []; let c = "", q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { o.push(c.trim()); c = ""; } else c += ch; } o.push(c.trim()); return o; };
  return { head: split(lines[0] || ""), rows: lines.slice(1).map(split) }; };
const gcs = p => call(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(p)}?alt=media`, null, true).then(csv);
for (const m of ["202610", "202611"]) for (const kind of ["overview", "country"]) {
  await part(`installs_${m}_${kind}`, () => gcs(`stats/installs/installs_${PKG}_${m}_${kind}.csv`));
  await part(`store_${m}_${kind}`, () => gcs(`stats/store_performance/store_performance_${PKG}_${m}_${kind}.csv`));
}
const eq = (f, v) => ({ filter: { fieldName: f, stringFilter: { value: v } } }), and = (...x) => ({ andGroup: { expressions: x } });
await part("ga_new", () => ga({ dateRanges: [{ startDate: "2026-10-01", endDate: "today" }], dimensions: [{ name: "date" }, { name: "countryId" }], metrics: [{ name: "newUsers" }, { name: "totalUsers" }], dimensionFilter: eq("platform", "Android") }));
await part("ga_first_open", () => ga({ dateRanges: [{ startDate: "2026-10-01", endDate: "today" }], dimensions: [{ name: "date" }, { name: "countryId" }, { name: "appVersion" }], metrics: [{ name: "eventCount" }], dimensionFilter: and(eq("platform", "Android"), eq("eventName", "first_open")) }));
await part("ga_remove", () => ga({ dateRanges: [{ startDate: "2026-10-01", endDate: "today" }], dimensions: [{ name: "date" }, { name: "countryId" }], metrics: [{ name: "eventCount" }], dimensionFilter: and(eq("platform", "Android"), eq("eventName", "app_remove")) }));
const data = Buffer.from(JSON.stringify(out)), key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(data), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/inst2.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
fs.writeFileSync("out/run.txt", (E.GITHUB_RUN_ID || "local") + "\n");
console.log("written, encrypted");
