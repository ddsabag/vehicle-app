// One-off (probe-live branch, not for main), 20.10 evening: live-28 before release. (1) live-watch.mjs dry against Cloudflare's real record
// of the luchit-live Worker (no Telegram, no redeploy: no token for either), (2) the live-28 Worker code with the real keys: the answer and
// its time, (3) the page in Chrome with that answer: script errors, words like NaN or undefined, sideways scroll, and the changed parts as
// text with every digit replaced by # (no business numbers in this public log).
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const say = (...a) => console.log(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
const mask = t => String(t || "").replace(/\d/g, "#").replace(/\s*\n+\s*/g, " | ");
say("at", new Date().toISOString());

// 1. the watch, dry
try { say(execFileSync("node", [".github/scripts/live-watch.mjs"], { env: { PATH: process.env.PATH, DRY: "1", CF_API_TOKEN: process.env.CF_API_TOKEN, CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID }, encoding: "utf8", timeout: 60000 })); }
catch (e) { say("live-watch failed:", String(e.stdout || "") + String(e.stderr || e.message).slice(0, 500)); }

// 2. the live-28 code with the real keys
const env = { GA_SERVICE_ACCOUNT_JSON: process.env.GA_SERVICE_ACCOUNT_JSON, GA_PROPERTY_ID: "557990379", CF_API_TOKEN: process.env.CF_API_TOKEN, CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID, PLAY_REPORTS_BUCKET: "pubsite_prod_4688106336294834537" };
const store = new Map();
globalThis.caches = { default: { put: async (k, r) => { store.set(k, await r.text()); }, match: async k => store.has(k) ? new Response(store.get(k)) : undefined } };
fs.writeFileSync("/tmp/live28.mjs", fs.readFileSync(".github/scripts/live28-worker.js", "utf8") + "\nexport { liveData, PAGE };\n");
const m = await import("/tmp/live28.mjs");
const t0 = Date.now(), r = await m.liveData(env, { waitUntil: p => p }), full = await r.json();
say("liveData:", r.status, "in", Date.now() - t0, "ms | build", full.build, "| late", !!full.late, "| kept for later:", store.size === 1, "| source errors:", Object.keys(full.errors || {}));
say("flashes:", (full.flashes || []).length, "items, newest", (full.flashes || [])[0]?.t, "| kinds", (full.flashes || []).map(f => f.k + "/" + f.l).join(" "));
for (const f of (full.flashes || []).slice(0, 8)) say("  ", f.t.slice(0, 16), f.k, f.l, mask(f.x).slice(0, 90));

// 3. the page in Chrome
const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
for (const [name, vp, scheme, body] of [["phone", { width: 390, height: 844 }, "light", full], ["phone", { width: 390, height: 844 }, "dark", full], ["desktop", { width: 1280, height: 900 }, "light", full], ["phone late", { width: 390, height: 844 }, "light", { ...full, late: true }]]) {
  const page = await browser.newPage({ viewport: vp, locale: "he-IL", timezoneId: "Asia/Jerusalem", colorScheme: scheme });
  const bad = [];
  page.on("pageerror", e => bad.push("pageerror: " + e.message.slice(0, 300)));
  page.on("console", x => { if (x.type() === "error" && !/Failed to load resource/.test(x.text())) bad.push("console: " + x.text().slice(0, 200)); });
  await page.route("**/*", rt => {
    const u = new URL(rt.request().url());
    if (u.pathname === "/live/data") return rt.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (u.hostname === "luchit.app" && (u.pathname === "/live" || u.pathname === "/live/")) return rt.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: m.PAGE });
    return rt.abort();
  });
  await page.goto("https://luchit.app/live", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  await page.evaluate(() => document.querySelectorAll("details").forEach(x => x.open = true));
  const o = await page.evaluate(() => {
    const t = document.body.innerText, q = s => { const e = document.querySelector(s); return e ? e.innerText : "(none)"; }, tiles = [...document.querySelectorAll("#tiles article")].map(a => a.innerText);
    const hits = ["NaN", "undefined", "null", "Infinity", "[object"].filter(w => new RegExp("(^|[^A-Za-z])" + w.replace("[", "\\[") + "([^A-Za-z]|$)").test(t));
    return { hits, scroll: document.documentElement.scrollWidth > innerWidth, meta: q("#meta"), t1: tiles[0], t4: tiles[3], att: q("#att"), src: q("#src"), fl: q("#fl") };
  });
  say(`page ${name}/${scheme}: errors`, bad.length ? bad : "none", "| bad words", o.hits.length ? o.hits : "none", "| sideways scroll", o.scroll, "| meta:", mask(o.meta));
  if (name === "phone" && scheme === "light") { for (const k of ["t1", "t4", "att", "src", "fl"]) say(`  ${k}:`, mask(o[k])); }
  await page.close();
}
await browser.close();
say("done", new Date().toISOString());
