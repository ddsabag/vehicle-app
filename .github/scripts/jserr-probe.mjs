// One-off (7.11.2026, again 12.11 from 5.11): web js_error 24.10 to today split by kind, uacl, efile, line, operating system and day. Encrypted output (business numbers).
import crypto from "node:crypto"; import fs from "node:fs";
const PROP = "557990379", sa = JSON.parse(process.env.GA_SERVICE_ACCOUNT_JSON);
const b64 = b => Buffer.from(b).toString("base64url"), now = Math.floor(Date.now() / 1000), head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
const claim = b64(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 }));
const sig = crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key, "base64url");
const T = (await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) })).json()).access_token;
const ga = async body => { const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${PROP}:runReport`, { method: "POST", headers: { authorization: "Bearer " + T, "content-type": "application/json" }, body: JSON.stringify({ limit: 10000, ...body }) }); const j = await r.json(); return { status: r.status, err: j.error?.message, dims: (j.dimensionHeaders || []).map(h => h.name), rows: (j.rows || []).map(x => [...x.dimensionValues.map(v => v.value), ...x.metricValues.map(v => +v.value)]) }; };
const f = { andGroup: { expressions: [{ filter: { fieldName: "eventName", stringFilter: { value: "js_error" } } }, { filter: { fieldName: "platform", stringFilter: { value: "web" } } }] } };
const out = {};
out.split = await ga({ dateRanges: [{ startDate: "2026-11-05", endDate: "today" }], dimensions: ["date", "customEvent:kind", "customEvent:uacl", "customEvent:efile", "customEvent:line", "operatingSystem"].map(name => ({ name })), metrics: [{ name: "eventCount" }], dimensionFilter: f });
out.where = await ga({ dateRanges: [{ startDate: "2026-11-05", endDate: "today" }], dimensions: ["customEvent:kind", "customEvent:where", "browser", "operatingSystem", "sessionSource"].map(name => ({ name })), metrics: [{ name: "eventCount" }], dimensionFilter: f });
const k = crypto.randomBytes(32), iv = crypto.randomBytes(12), ci = crypto.createCipheriv("aes-256-gcm", k, iv);
const data = Buffer.concat([ci.update(JSON.stringify(out)), ci.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, k);
console.log("ENC " + JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: ci.getAuthTag().toString("base64"), data: data.toString("base64") }));
