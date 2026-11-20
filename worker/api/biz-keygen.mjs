// Dealer key pair for /api/business-key (ops 20.11.2026). Dudu runs it once on his own computer: node biz-keygen.mjs
// It prints two lines. PRIVATE goes only into Cloudflare (luchit-api > Settings > Variables and Secrets > Add > type Secret, name BIZ_SIGNING_KEY),
// pasted by Dudu and never into a chat, a file in the repo or a commit. PUBLIC is not secret: product embeds it in the site and the app to check keys offline.
// verify(key, publicB64) below is the check the site and the app copy (Node 20+, Workers and modern browsers have Ed25519 in WebCrypto).
import crypto from "node:crypto";
const b64u = s => s.replace(/-/g, "+").replace(/_/g, "/");
export async function verify(key, publicB64, today = Math.floor(Date.now() / 864e5), revoked = []) {
  const m = /^LD1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(key || "").trim());
  if (!m) return { ok: false, why: "format" };
  const pub = await crypto.webcrypto.subtle.importKey("raw", Buffer.from(publicB64, "base64"), { name: "Ed25519" }, false, ["verify"]);
  const good = await crypto.webcrypto.subtle.verify({ name: "Ed25519" }, pub, Buffer.from(b64u(m[2]), "base64"), new TextEncoder().encode("LD1." + m[1]));
  if (!good) return { ok: false, why: "signature" };
  let p; try { p = JSON.parse(Buffer.from(b64u(m[1]), "base64").toString("utf8")); } catch { return { ok: false, why: "format" }; }
  if (p.v !== 1 || p.plan !== "dealer" || !Number.isInteger(p.exp)) return { ok: false, why: "format" };
  if (revoked.includes(p.id)) return { ok: false, why: "revoked", id: p.id };
  if (p.exp < today) return { ok: false, why: "expired", id: p.id, exp: p.exp };
  return { ok: true, id: p.id, exp: p.exp };
}
if (process.argv[1] && process.argv[1].endsWith("biz-keygen.mjs")) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  console.log("PUBLIC  " + publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"));
  console.log("PRIVATE " + privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
}
