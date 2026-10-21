// Release builds only: seals the private service-interval table for the APK. service.json (written from a secret, never in the repo)
// becomes service.bin, AES-256-GCM under a fresh key per build, and the key goes into the minified page (android/build-web/index.html),
// so unzipping the APK shows no readable table. A marker row (a model name that no car carries, so the app never shows it) is added
// first, so a copied table can be recognised.
import fs from "node:fs";
import crypto from "node:crypto";

const root = new URL("../../", import.meta.url);
const src = new URL("service.json", root), page = new URL("android/build-web/index.html", root);
if (!fs.existsSync(src)) { console.log("no service.json; nothing to seal"); process.exit(0); }
const j = JSON.parse(fs.readFileSync(src, "utf8"));
if (!Array.isArray(j.rows) || !j.rows.length) throw new Error("service.json has no rows");
const MARK = ["סקודה", "KORAVIN", "i", 1395, 15000, 12];
if (!j.rows.some(r => r[1] === MARK[1])) j.rows.splice(Math.floor(j.rows.length / 2), 0, MARK);

const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
const c = crypto.createCipheriv("aes-256-gcm", key, iv);
const ct = Buffer.concat([c.update(JSON.stringify(j), "utf8"), c.final(), c.getAuthTag()]);   // the same layout WebCrypto reads: data then tag
fs.writeFileSync(new URL("service.bin", root), Buffer.concat([iv, ct]));

const html = fs.readFileSync(page, "utf8");
if (!html.includes("__SVK__")) throw new Error("the page has no key slot (__SVK__)");
fs.writeFileSync(page, html.split("__SVK__").join(key.toString("base64")));
fs.unlinkSync(src);
console.log(`service table sealed: ${j.rows.length} rows`);
