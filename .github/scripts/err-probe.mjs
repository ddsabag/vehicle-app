// One-off (probe-perf branch, not for main), 24.10: the pipe canary counted 8 code errors on 23.10 against a median of 0. Which errors,
// from where (web or app, which app version, which hour), and do the live pages throw today? Part 1 reads GA4 (js_error and
// lookup_failed of kind js_err, with car checks for scale). Part 2 opens the live site in Chromium (phone and desktop) on pages that
// changed lately and records every page error and console error with its line. Demo plate only. Business numbers never reach the log
// or the branch in clear: the JSON is encrypted with .github/seo-data.pub.pem and the log says only which part answered.
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
const eq = (f, v) => ({ filter: { fieldName: f, stringFilter: { value: v } } }), inList = (f, values) => ({ filter: { fieldName: f, inListFilter: { values } } });
const ERR = { orGroup: { expressions: [eq("eventName", "js_error"), { andGroup: { expressions: [eq("eventName", "lookup_failed"), eq("customEvent:kind", "js_err")] } }] } };
const days = (a, b) => [{ startDate: a, endDate: b }];

if (sa) {
  // the canary's own view: errors per day, platform and kind, two weeks
  await part("ga.daily", () => ga({ dateRanges: days("2026-10-10", "today"), dimensions: [{ name: "date" }, { name: "platform" }, { name: "eventName" }, { name: "customEvent:kind" }], metrics: [{ name: "eventCount" }, { name: "totalUsers" }],
    dimensionFilter: inList("eventName", ["js_error", "lookup_failed"]) }));
  // 22-24.10 in detail: hour, app version, source of the visit, country
  await part("ga.detail", () => ga({ dateRanges: days("2026-10-22", "today"), dimensions: [{ name: "dateHour" }, { name: "platform" }, { name: "eventName" }, { name: "customEvent:kind" }, { name: "appVersion" }, { name: "countryId" }, { name: "customEvent:src" }], metrics: [{ name: "eventCount" }], dimensionFilter: ERR }));
  await part("ga.devices", () => ga({ dateRanges: days("2026-10-22", "today"), dimensions: [{ name: "date" }, { name: "platform" }, { name: "deviceModel" }, { name: "operatingSystemWithVersion" }, { name: "browser" }], metrics: [{ name: "eventCount" }], dimensionFilter: ERR }));
  // scale: car checks and page views per day and platform
  await part("ga.scale", () => ga({ dateRanges: days("2026-10-10", "today"), dimensions: [{ name: "date" }, { name: "platform" }, { name: "eventName" }], metrics: [{ name: "eventCount" }],
    dimensionFilter: inList("eventName", ["car_lookup", "web_visit", "first_open", "link_out", "exp_expose"]) }));
  // events fired in the same hours as the errors (what people were doing)
  await part("ga.sameHours", () => ga({ dateRanges: days("2026-10-23", "2026-10-23"), dimensions: [{ name: "dateHour" }, { name: "platform" }, { name: "eventName" }], metrics: [{ name: "eventCount" }] }));
}

// Part 2: the live site in a browser
let pw = null; try { pw = await import("playwright"); } catch { /* no browser on this run */ }
if (pw) {
  const SITE = "https://luchit.app/";
  const pages = ["", "?plate=1234567", "check/", "model/", "magazine/", "business/", "guide/buy-used-car/", "email/signature.html", "privacy.html"];
  const devices = { phone: { ...pw.devices["iPhone 13"] }, android: { ...pw.devices["Pixel 7"] }, desk: { viewport: { width: 1440, height: 900 } } };
  const browser = await pw.chromium.launch();
  for (const [dn, dev] of Object.entries(devices)) {
    await part("site." + dn, async () => {
      const ctx = await browser.newContext({ ...dev, locale: "he-IL", serviceWorkers: "block" });
      const res = [];
      for (const p of pages) {
        const page = await ctx.newPage(), errs = [], beacons = [];
        page.on("pageerror", e => errs.push({ t: "pageerror", m: String(e.message).slice(0, 300), s: String(e.stack || "").split("\n").slice(0, 4).join(" | ").slice(0, 500) }));
        page.on("console", m => { if (m.type() === "error") errs.push({ t: "console", m: m.text().slice(0, 300), l: m.location() }); });
        page.on("request", r => { if (/\/api\/e/.test(r.url())) { const b = r.postData() || ""; if (/js_error|lookup_failed/.test(b)) beacons.push(b.slice(0, 400)); } });
        try {
          await page.goto(SITE + p, { waitUntil: "load", timeout: 45000 });
          await page.waitForTimeout(p.includes("plate") ? 12000 : 4000);
          // what a visitor does on the home page: scroll, open the settings sheet, tap the footer links (they open a new tab)
          if (p === "") {
            await page.mouse.wheel(0, 3000).catch(() => {});
            for (const s of ["a[data-soc]", "#soc a"]) { const a = await page.$(s); if (a) { await a.click({ modifiers: [], timeout: 3000 }).catch(() => {}); break; } }
            await page.waitForTimeout(1500);
          }
        } catch (e) { errs.push({ t: "goto", m: String(e.message).slice(0, 200) }); }
        res.push({ p, errs, beacons });
        await page.close();
      }
      await ctx.close();
      return res;
    });
  }
  await browser.close();
}

const data = Buffer.from(JSON.stringify(out));
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([c.update(data), c.final()]);
const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/err.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
console.log("written, encrypted");
