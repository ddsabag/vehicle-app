// One-off (probe-perf branch, not for main), 3.11.2026 for the measurement thread: the whole /live/data answer as the Worker builds it, plus
// (12.11: the answer is now built with liveData()'s own expression, copied from main's source, so new parts such as goals and acts come along;
// for the CEO thread's phone screenshots of the current build, Dudu 12.11 "תעבור עם אמולטור על הדשבורד לייב")
// the /live/now line, so every item on the dashboard can be checked for data (Dudu's ask: "שכל דבר שנמצא בדשבורד באמת מקבל נתון"). The
// Worker's code is taken from main (W_JS), its collect() and the readers of the side branches are run here with the same secrets; Workers KV
// is read through Cloudflare's API, nothing is written. Encrypted with .github/seo-data.pub.pem; the log says only which part answered and how long it took.
import crypto from "node:crypto";
import fs from "node:fs";
const E = process.env;
const WJS = fs.readFileSync(E.W_JS || "worker/live/worker.js", "utf8");
const WORK = /const work = \(async \(\) => (\(\{[\s\S]*?\}\))\)\(\);/.exec(WJS);
if (!WORK) throw new Error("liveData's work line changed: update live-audit.mjs");
const src = WJS.replace("export default", "const _default =") + "\nasync function __snap(env) { return " + WORK[1] + "; }\nexport { __snap, collect, onlineNow };\n";
const tmp = E.W_TMP || "/tmp/live-audit-worker.mjs";
fs.writeFileSync(tmp, src);
const toml = fs.existsSync(E.W_TOML || "") ? fs.readFileSync(E.W_TOML, "utf8") : "";
const tv = (k, dflt) => (new RegExp("^" + k + '\\s*=\\s*"([^"]+)"', "m").exec(toml) || [0, dflt])[1];
const rawTok = String(E.CLOUDFLARE_API_TOKEN || E.CF_API_TOKEN || ""), bt = /\bBearer\s+([A-Za-z0-9_-]{20,})(?![A-Za-z0-9_-])/.exec(rawTok);
const kvTok = bt ? bt[1] : rawTok.replace(/[^A-Za-z0-9_-]/g, ""), acc = String(E.CF_ACCOUNT_ID || "").trim();
const cf = p => fetch("https://api.cloudflare.com/client/v4/accounts/" + acc + p, { headers: { authorization: "Bearer " + kvTok }, signal: AbortSignal.timeout(15e3) });
let ns = null;
const nsId = async () => ns ??= ((await (await cf("/storage/kv/namespaces?per_page=100")).json()).result || []).find(x => x.title === "luchit-alerts")?.id || "";
const ALERTS = {
  get: async (k, type) => { const id = await nsId(); if (!id) return null; const r = await cf("/storage/kv/namespaces/" + id + "/values/" + encodeURIComponent(k)); if (r.status === 404) return null; if (!r.ok) throw new Error("kv " + r.status); return type === "json" ? r.json() : r.text(); },
  put: async () => {}, list: async () => ({ keys: [] }),
};
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const env = { ALERTS, GA_PROPERTY_ID: tv("GA_PROPERTY_ID", "557990379"), PLAY_REPORTS_BUCKET: tv("PLAY_REPORTS_BUCKET", "pubsite_prod_4688106336294834537"),
  GA_SERVICE_ACCOUNT_JSON: E.GA_SERVICE_ACCOUNT_JSON, CF_API_TOKEN: E.CF_API_TOKEN, CF_ACCOUNT_ID: acc };
const W = await import(tmp);
const out = { generated: new Date().toISOString(), parts: {}, ms: {} };
const part = async (name, fn) => { const t = Date.now(); try { out.parts[name] = await fn(); out.ms[name] = Date.now() - t; console.log(name, "ok", out.ms[name], "ms"); }
  catch (e) { out.parts[name] = { error: String(e.message || e).slice(0, 400) }; out.ms[name] = Date.now() - t; console.log(name, "failed", String(e.message || e).replace(/\d/g, "#").slice(0, 120)); } };
await part("snap", () => W.__snap(env));
await part("online", () => W.onlineNow(env));
const P = out.parts;
out.data = P.snap && !P.snap.error ? P.snap : null;
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), ci = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([ci.update(JSON.stringify(out)), ci.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/live-data.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: ci.getAuthTag().toString("base64"), data: enc.toString("base64") }));
console.log("written, encrypted; parts with errors:", Object.keys(P).filter(k => P[k] && P[k].error).join(", ") || "none");
