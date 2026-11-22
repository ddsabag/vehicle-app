// One-off, read-only (22.11.2026, CEO weekly review): who is on the magazine list in Brevo, by date and source, so ops can tell whether any
// subscriber is real or all are tests. No address is kept: only its domain, whether the local part looks like a test, and Brevo's dates.
// Business numbers never reach the log or the branch in clear: the JSON is encrypted with .github/seo-data.pub.pem.
import fs from "node:fs";
import crypto from "node:crypto";
const KEY = process.env.BREVO_KEY, LIST = Number(process.env.BREVO_LIST_ID || 7);
const h = { "api-key": KEY, accept: "application/json" };
const get = async p => { const r = await fetch("https://api.brevo.com/v3" + p, { headers: h }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const out = { at: new Date().toISOString(), list: LIST, contacts: [], lists: null, err: [] };
const L = await get(`/contacts/lists/${LIST}`); out.lists = { status: L.status, name: L.j.name, totalSubscribers: L.j.totalSubscribers, totalBlacklisted: L.j.totalBlacklisted, uniqueSubscribers: L.j.uniqueSubscribers };
for (let off = 0; off < 2000; off += 500) {
  const r = await get(`/contacts/lists/${LIST}/contacts?limit=500&offset=${off}&sort=asc`);
  if (r.status !== 200) { out.err.push(`list contacts ${r.status}`); break; }
  for (const c of r.j.contacts || []) {
    const [local = "", dom = ""] = String(c.email || "").toLowerCase().split("@");
    out.contacts.push({ created: c.createdAt, modified: c.modifiedAt, domain: dom, testy: /test|probe|example|bdika|\+|^qa|smoke|claude|luchit/.test(local) || /example\.|luchit\.app|mailinator|test/.test(dom),
      own: dom === "luchit.app" || local.startsWith("luchit.app.service"), src: c.attributes?.SOURCE || "", consent: c.attributes?.CONSENT_AT || "", black: !!c.emailBlacklisted, lists: c.listIds });
  }
  if ((r.j.contacts || []).length < 500) break;
}
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), ci = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([ci.update(JSON.stringify(out)), ci.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/subs.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: ci.getAuthTag().toString("base64"), data: enc.toString("base64") }));
console.log("sealed", out.err.length ? "with errors" : "ok");
