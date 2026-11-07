// Passive fetch of a fixed list of public pages (GET only, no forms, no logins, no crawl).
// Also: each origin's /ads.txt and /robots.txt, the Wayback CDX first captures and crt.sh certificate log for listed hosts.
// Output is encrypted with the public key; the log shows a count only.
// Run: node .github/scripts/page-list.mjs <out.enc.json>   (env LIST: URLs separated by spaces; env HIST: hosts for Wayback/crt.sh)
import crypto from "node:crypto"; import fs from "node:fs"; import zlib from "node:zlib";
const [outFile] = process.argv.slice(2);
const list = (process.env.LIST || "").split(/\s+/).filter(Boolean);
const hist = (process.env.HIST || "").split(/\s+/).filter(Boolean);
const urls = new Set(list);
for (const u of list) { const o = new URL(u).origin; urls.add(o + "/ads.txt"); urls.add(o + "/robots.txt"); }
for (const h of hist) {
  urls.add(`https://web.archive.org/cdx/search/cdx?url=${h}&output=json&limit=5`);
  urls.add(`https://web.archive.org/cdx/search/cdx?url=${h}/*&output=json&limit=5&collapse=urlkey`);
  urls.add(`https://crt.sh/?q=${h}&output=json`);
}
const out = {};
for (const u of urls) {
  try {
    const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (page snapshot)", "accept-language": "he,en" }, redirect: "follow", signal: AbortSignal.timeout(30000) });
    const type = r.headers.get("content-type") || "";
    const body = /text|javascript|json|xml|html/.test(type) || !type ? (await r.text()).slice(0, 3e6) : "";
    out[u] = { status: r.status, final: r.url, headers: Object.fromEntries(r.headers), body };
  } catch (e) { out[u] = { error: String(e.message || e).slice(0, 120) }; }
}
console.log(`files: ${Object.keys(out).length}`);
const data = zlib.gzipSync(JSON.stringify({ at: new Date().toISOString(), files: out }));
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(data), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.writeFileSync(outFile, JSON.stringify({ v: 1, gz: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
