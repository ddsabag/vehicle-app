// One-off (25.11.2026): can the publish service account read Play's store_performance and installs CSVs? Lists the objects and reads the
// latest months; encrypted output (business numbers). The bucket address comes from secret PLAY_REPORTS_URI, never printed.
import crypto from "node:crypto"; import fs from "node:fs";
const sa = JSON.parse(process.env.SHIP_SA_JSON), B = String(process.env.PLAY_REPORTS_URI || "").trim().replace(/^gs:\/\//, "").replace(/\/.*$/, "");
if (!B) { console.log("no bucket secret"); process.exit(1); }
const b64 = b => Buffer.from(b).toString("base64url"), now = Math.floor(Date.now() / 1000), head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
const claim = b64(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/devstorage.read_only", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 }));
const sig = crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key, "base64url");
const T = (await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) })).json()).access_token;
const H = { authorization: "Bearer " + T }, out = {};
for (const pre of ["stats/store_performance/", "stats/installs/"]) {
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${B}/o?prefix=${encodeURIComponent(pre)}&maxResults=200`, { headers: H });
  console.log(pre, "list", r.status);
  if (!r.ok) { out[pre] = { status: r.status }; continue; }
  const items = ((await r.json()).items || []).map(o => o.name).sort(); out[pre] = { names: items, files: {} };
  for (const n of items.filter(n => /2026(10|11)/.test(n))) {
    const f = await fetch(`https://storage.googleapis.com/storage/v1/b/${B}/o/${encodeURIComponent(n)}?alt=media`, { headers: H });
    const buf = Buffer.from(await f.arrayBuffer()); const txt = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString("utf16le") : buf.toString("utf8");
    out[pre].files[n] = f.ok ? txt.slice(0, 20000) : "status " + f.status; }
}
const k = crypto.randomBytes(32), iv = crypto.randomBytes(12), ci = crypto.createCipheriv("aes-256-gcm", k, iv);
const data = Buffer.concat([ci.update(JSON.stringify(out)), ci.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, k);
console.log("ENC " + JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: ci.getAuthTag().toString("base64"), data: data.toString("base64") }));
