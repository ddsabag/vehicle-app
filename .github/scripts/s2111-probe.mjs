// probe-perf only, never main. 21.11.2026, strategy's ask for the 21.11 talk: car checks by day and platform to today, first_save/app_return by
// version and from, and Cloudflare Web Analytics visits by day and OS (the iPhone share of the site). Encrypted with .github/seo-data.pub.pem.
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

const f = (k, v) => ({ filter: { fieldName: k, stringFilter: { value: v } } }), inl = (k, v) => ({ filter: { fieldName: k, inListFilter: { values: v } } });
const and = (...x) => ({ andGroup: { expressions: x } });
const REAL = { orGroup: { expressions: [f("platform", "web"), f("countryId", "IL")] } }, APP = and(f("platform", "Android"), f("countryId", "IL"));
const M = [{ name: "eventCount" }, { name: "totalUsers" }];
const cleanTok = raw => { raw = String(raw || ""); const m = raw.match(/Bearer\s+([A-Za-z0-9_\-]{20,})/i); return (m ? m[1] : raw).trim().replace(/^["']|["']$/g, "").replace(/[^\x21-\x7e]/g, ""); };
async function gql(query, variables) {
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + cleanTok(E.CF_API_TOKEN), "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const j = await r.json(); if (j.errors) throw new Error(j.errors.map(e => e.message).join(" | ")); return j.data;
}
const acc = String(E.CF_ACCOUNT_ID || "").trim(), SITES = ["03eb6fb7a75440649781d7a00b29c4ff", "5c0a33a14f5f4201b25fd680a29ae723"];
const rum = (dims, from, to, limit) => gql(`query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){rumPageloadEventsAdaptiveGroups(filter:$f,limit:${limit},orderBy:[count_DESC]){count sum{visits} dimensions{${dims}}}}}}`,
  { acc, f: { AND: [{ datetime_geq: from + "T00:00:00Z", datetime_lt: to + "T00:00:00Z" }, { siteTag_in: SITES }, { requestPath_notlike: "/live%" }, { userAgentBrowser_neq: "ChromeHeadless" }] } })
  .then(d => d.viewer.accounts[0].rumPageloadEventsAdaptiveGroups.map(x => ({ ...x.dimensions, n: x.count, visits: x.sum.visits })));
if (sa) {
  await part("checks.day", () => ga({ dateRanges: [{ startDate: "2026-10-21", endDate: "today" }], dimensions: [{ name: "date" }, { name: "platform" }], metrics: M, dimensionFilter: and(f("eventName", "car_lookup"), REAL) }));
  await part("save.from", () => ga({ dateRanges: [{ startDate: "2026-10-26", endDate: "today" }], dimensions: [{ name: "eventName" }, { name: "appVersion" }, { name: "customEvent:from" }], metrics: M, dimensionFilter: and(inl("eventName", ["first_save", "app_return"]), APP) }));
}
for (const [a, b] of [["2026-10-21", "2026-11-01"], ["2026-11-01", "2026-11-11"], ["2026-11-11", "2026-11-22"]])
  await part("rum.os." + a, () => rum("date userAgentOS", a, b, 2000));
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(JSON.stringify(out)), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/s2111.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
fs.writeFileSync("out/run.txt", (E.GITHUB_RUN_ID || "local") + "\n");
console.log("written, encrypted");
