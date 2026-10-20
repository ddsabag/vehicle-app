// One-off (probe-go branch, not for main), 20.10 after the live-26 release: (1) which code the luchit-live Worker runs (Cloudflare API,
// read-only), (2) main's /live code run with the real keys: outside calls (a Worker request may make 50) and source errors, (3) the page
// rendered in Chrome with that data: script errors, broken values, sideways scroll, the key lines. Prints a summary only, no data dump.
import fs from "node:fs";
import { createHash } from "node:crypto";
const SHA = "da376370c83159816fe93d40cf50425ed76c143b";
const say = (...a) => console.log(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
say("at", new Date().toISOString());

// 1. the code the Worker runs, against main's file
const mainCode = await (await fetch(`https://raw.githubusercontent.com/ddsabag/vehicle-app/${SHA}/worker/live/worker.js`)).text();
say("main file", mainCode.length, "chars, sha256", createHash("sha256").update(mainCode).digest("hex").slice(0, 12), "| BUILD live-26:", mainCode.includes('const BUILD = "live-26"'));
const raw = String(process.env.CLOUDFLARE_API_TOKEN || ""), mm = raw.match(/Bearer\s+([A-Za-z0-9_\-]{20,})/i);
const tok = (mm ? mm[1] : raw).trim().replace(/^["']|["']$/g, ""), acc = String(process.env.CF_ACCOUNT_ID || "").trim();
const API = `https://api.cloudflare.com/client/v4/accounts/${acc}/workers/scripts/luchit-live`;
const get = async (p, asText) => { const r = await fetch(API + p, { headers: { authorization: "Bearer " + tok } }); if (!r.ok) return { err: r.status + " " + (await r.text()).slice(0, 200) }; return asText ? r.text() : r.json(); };
const dep = await get("/deployments");
const list = (dep.result && dep.result.deployments) || [];
if (dep.err) say("deployments", dep.err);
for (const x of list.slice(0, 2)) say("deployment", x.created_on, x.versions, x.annotations || {});
const vid = list[0] && list[0].versions && list[0].versions[0] && list[0].versions[0].version_id;
if (vid) {
  const code = await get(`/content/v2?version=${vid}`, true);
  const txt = typeof code === "string" ? code : JSON.stringify(code);
  say("live code", txt.length, "chars | holds main's whole file byte for byte:", txt.includes(mainCode), "| BUILD live-26:", txt.includes('const BUILD = "live-26"'));
}

// 2. main's code with the real keys, counting its outside calls
const env = { GA_SERVICE_ACCOUNT_JSON: process.env.GA_SERVICE_ACCOUNT_JSON, GA_PROPERTY_ID: "557990379", CF_API_TOKEN: process.env.CF_API_TOKEN, CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID, PLAY_REPORTS_BUCKET: "pubsite_prod_4688106336294834537" };
fs.writeFileSync("/tmp/live-main.mjs", mainCode + "\nexport { collect, getFlashes, getMetrics, PAGE };\n");
const real = globalThis.fetch; let calls = 0; const hosts = {};
globalThis.fetch = (u, o) => { calls++; const h = new URL(String(u && u.url ? u.url : u)).hostname; hosts[h] = (hosts[h] || 0) + 1; return real(u, o); };
const m = await import("/tmp/live-main.mjs");
const t0 = Date.now();
const d = await m.collect(env);
say("cold collect:", calls, "outside calls in", Date.now() - t0, "ms", hosts);
globalThis.fetch = real;
say("build:", d.build, "| top keys:", Object.keys(d).join(","));
const errs = []; (function walk(o, p) { if (!o || typeof o !== "object") return; for (const [k, v] of Object.entries(o)) { if (k === "errors" && v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length) errs.push([p + k, v]); else walk(v, p + k + "."); } })(d, "");
say("source errors:", errs.length ? errs : "none");
const life = d.daily && d.daily.life, ch = d.daily && d.daily.ch;
say("daily.life days:", life ? Object.keys(life).length : null, "| daily.ch site ranges:", ch && ch.site ? ch.site.length : null, "| app ranges:", ch && ch.app ? ch.app.length : null);

// 3. the page in Chrome with that data
const full = { ...JSON.parse(JSON.stringify(d)), flashes: (await m.getFlashes()).slice(0, 15), metrics: await m.getMetrics() };
const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
for (const [name, vp] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 900 }]]) {
  for (const scheme of name === "phone" ? ["light", "dark"] : ["light"]) {
    const page = await browser.newPage({ viewport: vp, locale: "he-IL", timezoneId: "Asia/Jerusalem", colorScheme: scheme });
    const bad = [];
    page.on("pageerror", e => bad.push("pageerror: " + e.message));
    page.on("console", x => { if (x.type() === "error") bad.push("console: " + x.text().slice(0, 200)); });
    await page.route("**/*", r => {
      const u = new URL(r.request().url());
      if (u.pathname === "/live/data") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(full) });
      if (u.hostname === "luchit.app" && (u.pathname === "/live" || u.pathname === "/live/")) return r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: m.PAGE });
      return r.abort();
    });
    await page.goto("https://luchit.app/live", { waitUntil: "load" });
    await page.waitForTimeout(2500);
    const r = await page.evaluate(() => {
      document.querySelectorAll("details").forEach(x => { x.open = true; });
      const t = document.body.innerText;
      const hits = ["NaN", "undefined", "null", "Infinity", "[object"].filter(w => new RegExp("(^|[^A-Za-z])" + w.replace("[", "\\[") + "([^A-Za-z]|$)").test(t));
      const inst = (t.match(/מותקנת עכשיו[^\n]*/) || [""])[0];
      const src = document.getElementById("dr-src");
      const srcRows = src ? src.querySelectorAll("tr").length : -1;
      const nets = src ? ["פייסבוק", "וואטסאפ", "טיקטוק", "יוטיוב", "אינסטגרם"].filter(n => src.innerText.includes(n)) : [];
      const wide = [...document.querySelectorAll("body *")].filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > innerWidth + 1 || b.left < -1) && !e.closest("[style*=overflow],.tw,.scroll"); }).slice(0, 5).map(e => e.tagName + "." + e.className);
      return { hits, inst, srcRows, nets, scrollW: document.documentElement.scrollWidth, innerW: innerWidth, wide, len: t.length, build: (t.match(/live-\d+/) || [""])[0] };
    });
    say(`page ${name}/${scheme}:`, r, "| errors:", bad.length ? bad : "none");
    await page.close();
  }
}
await browser.close();
