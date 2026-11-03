// Passive snapshot of a public web page and the same-origin files it serves to every visitor (HTML, JS, CSS, JSON).
// GET only, no forms, no logins, no API calls with data. The output is encrypted (public key), never readable in the repo or the logs.
// Run: node .github/scripts/site-probe.mjs <start-url> <out.enc.json>
import crypto from "node:crypto"; import fs from "node:fs"; import zlib from "node:zlib";

const [start, outFile] = process.argv.slice(2);
const origin = new URL(start).origin, MAX = 120, MAXB = 25e6;
const seen = new Map(), queue = [start, ...(process.env.SEEDS || "").split(/\s+/).filter(Boolean).map(s => new URL(s, origin).href)];
const DENY = process.env.DENY ? new RegExp(process.env.DENY) : null;
let bytes = 0;
const skip = u => /\/\.netlify\/functions\/|\/api\//.test(u) || (DENY && DENY.test(u));   // their server endpoints are named from the code, never called
function refs(body, base, type) {
  const out = new Set(), add = s => { try { const u = new URL(s, base); u.hash = ""; if (u.origin === origin) out.add(u.href); } catch {} };
  if (/html/.test(type)) for (const m of body.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  if (/javascript|html/.test(type)) for (const m of body.matchAll(/["'`]((?:\.{0,2}\/)[\w./-]+\.(?:js|mjs|css|json|html))["'`]/g)) add(m[1]);
  if (/css/.test(type)) for (const m of body.matchAll(/url\(\s*["']?([^"')]+)/g)) if (!/\.(png|jpe?g|svg|woff2?|ttf|gif|webp|ico)$/i.test(m[1])) add(m[1]);
  return [...out].filter(u => !/\.(png|jpe?g|svg|woff2?|ttf|gif|webp|ico|mp4|pdf)(\?|$)/i.test(u));
}
while (queue.length && seen.size < MAX && bytes < MAXB) {
  const u = queue.shift(); if (seen.has(u) || skip(u)) continue;
  try {
    const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (site snapshot)" }, redirect: "follow", signal: AbortSignal.timeout(20000) });
    const type = r.headers.get("content-type") || "", body = /text|javascript|json|xml|css/.test(type) ? await r.text() : "";
    bytes += body.length;
    seen.set(u, { status: r.status, final: r.url, headers: Object.fromEntries(r.headers), body });
    if (r.ok) for (const n of refs(body, r.url, type)) if (!seen.has(n)) queue.push(n);
  } catch (e) { seen.set(u, { error: String(e.message || e).slice(0, 100) }); }
}
console.log(`files: ${seen.size}`);   // a count only: no names, no content in the log
const data = zlib.gzipSync(JSON.stringify({ start, at: new Date().toISOString(), files: Object.fromEntries(seen) }));
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(data), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.writeFileSync(outFile, JSON.stringify({ v: 1, gz: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
