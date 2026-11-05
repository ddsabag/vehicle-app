// One-off, 5.11.2026: the live goals backtest (CEO spec 5.11). Runs the weekly rows of /live's goals code (branch meas/live-goals,
// worker/live/worker.js: goalRows, goalSide) on the whole weeks since 18.10 and on the part of the week 1.11-4.11 so far. Read-only. The output
// is encrypted with .github/seo-data.pub.pem (business numbers never in the log or a branch in clear); the log says only which part answered.
import crypto from "node:crypto";
import fs from "node:fs";
const E = process.env, mask = s => String(s).replace(/\d/g, "#").slice(0, 200);
const src = fs.readFileSync(E.W_JS, "utf8").replace("export default", "const _d =") + "\nexport { goalRows, goalSide };";
fs.writeFileSync(E.W_TMP, src);
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const env = { GA_PROPERTY_ID: "557990379", PLAY_REPORTS_BUCKET: "pubsite_prod_4688106336294834537", GA_SERVICE_ACCOUNT_JSON: E.GA_SERVICE_ACCOUNT_JSON };
const { goalRows, goalSide } = await import(E.W_TMP);
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
const out = { at: new Date().toISOString(), today };
try { const c = await goalRows(env, "2026-10-18", "2026-10-25"); await goalSide(env, today, c.rows, "2026-10-25"); out.closed = c.rows; out.closedErrs = c.errs; console.log("closed weeks", c.errs.length ? "partly: " + mask(c.errs.join("; ")) : "ok"); }
catch (e) { out.closedErr = String(e.message || e); console.log("closed weeks failed", mask(e.message || e)); }
try { const p = await goalRows(env, "2026-11-01", "2026-11-01", null, "2026-11-04"); out.part = p.rows; out.partErrs = p.errs; out.partDays = 4; console.log("week so far", p.errs.length ? "partly: " + mask(p.errs.join("; ")) : "ok"); }
catch (e) { out.partErr = String(e.message || e); console.log("week so far failed", mask(e.message || e)); }
const data = Buffer.from(JSON.stringify(out)), key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(data), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/goals.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
fs.writeFileSync("out/run.txt", (E.GITHUB_RUN_ID || "local") + "\n");
console.log("written, encrypted");
