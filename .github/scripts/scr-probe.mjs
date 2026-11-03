// One-off (probe-perf branch, not for main), 3.11 for the CEO thread (Dudu asked): can a screenshot count as a share? In the Android app (Israel):
// user_screenshot (Android 14+, from 1.24, param tab) against car_lookup, share and share_open, by week since 12.10, by OS version and app version;
// screenshots by tab; and devices that both screenshotted and shared (users of A, of B and of A-or-B, so A and B = A + B - union). Encrypted with .github/seo-data.pub.pem, log says only which part answered.
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
const W = [["2026-10-12", "2026-10-18", "w1"], ["2026-10-19", "2026-10-25", "w2"], ["2026-10-25", "2026-10-31", "w25"], ["2026-10-26", "2026-11-01", "w3"], ["2026-11-02", "2026-11-02", "w4part"]].map(([startDate, endDate, name]) => ({ startDate, endDate, name }));
const EV = ["user_screenshot", "car_lookup", "share", "share_open"];
const evs = v => ({ filter: { fieldName: "eventName", inListFilter: { values: v } } });
const APP = [{ filter: { fieldName: "platform", stringFilter: { value: "Android" } } }, { filter: { fieldName: "countryId", stringFilter: { value: "IL" } } }];
const and = (...x) => ({ andGroup: { expressions: [...APP, ...x] } });
const OS14 = { filter: { fieldName: "operatingSystemVersion", inListFilter: { values: ["Android 14", "Android 15", "Android 16", "Android 17"] } } };
const ranges = a => { const out = []; for (let i = 0; i < a.length; i += 4) out.push(a.slice(i, i + 4)); return out; };
if (sa) {
  for (const [i, R] of ranges(W).entries()) {
    await part("ga.ev" + i, () => ga({ dateRanges: R, dimensions: [{ name: "eventName" }, { name: "operatingSystemVersion" }, { name: "appVersion" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: and(evs(EV)) }));
    await part("ga.tab" + i, () => ga({ dateRanges: R, dimensions: [{ name: "customEvent:tab" }, { name: "appVersion" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: and(evs(["user_screenshot"])) }));
    for (const [k, list] of [["scr", ["user_screenshot"]], ["shr", ["share"]], ["union", ["user_screenshot", "share"]]]) {
      await part(`ga.u.${k}.all${i}`, () => ga({ dateRanges: R, metrics: [{ name: "totalUsers" }], dimensionFilter: and(evs(list)) }));
      await part(`ga.u.${k}.os14${i}`, () => ga({ dateRanges: R, metrics: [{ name: "totalUsers" }], dimensionFilter: and(evs(list), OS14) }));
    }
  }
  await part("ga.os", () => ga({ dateRanges: [{ startDate: "2026-10-12", endDate: "2026-11-02" }], dimensions: [{ name: "operatingSystemVersion" }], metrics: [{ name: "totalUsers" }], dimensionFilter: and() }));
}
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(JSON.stringify(out)), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/scr.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
console.log("written, encrypted");
