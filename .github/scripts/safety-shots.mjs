// One-off (probe-go branch, not for main), 20.10: the safety level as a user sees it, on main (live) and on next (the fix), for real
// cars of chosen model-years and trims, opened like a user in Chrome. Prints model, year, trim, the register's own level and what each
// page shows (insights, the safety card, the simple view, the comparison). Plates are never printed: cars are case ids.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execSync } from "node:child_process";

const T0 = Date.now(), ts = () => `[${Math.round((Date.now() - T0) / 1000)}s]`;
const say = (...a) => console.log(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
const sh = c => execSync(c, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 }).toString().trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- the two versions of the site ---------- */
const REPO = "https://github.com/ddsabag/vehicle-app.git", SITES = {};
for (const ref of ["main", "next"]) {
  const dir = `/tmp/site-${ref}`;
  sh(`git fetch -q --depth 1 ${REPO} ${ref}`);
  const sha = sh("git rev-parse FETCH_HEAD");
  fs.mkdirSync(dir, { recursive: true });
  sh(`git archive FETCH_HEAD | tar -x -C ${dir}`);
  SITES[ref] = { dir, sha };
  say(ts(), ref, sha.slice(0, 8), "safetyLevel in page:", fs.readFileSync(dir + "/index.html", "utf8").includes("function safetyLevel"));
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain", ".webmanifest": "application/manifest+json" };
async function serve(root) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname); if (p.endsWith("/")) p += "index.html";
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r)); server.unref();
  return `http://127.0.0.1:${server.address().port}/`;
}
for (const s of Object.values(SITES)) s.base = await serve(s.dir);

/* ---------- data.gov.il, kept under its per-minute limit (my calls and the pages' calls share one window) ---------- */
const html = fs.readFileSync(SITES.next.dir + "/index.html", "utf8");
const block = html.slice(html.indexOf("const PLATE_SETS"), html.indexOf("const MODEL_SETS"));
const SETS = Object.fromEntries([...block.matchAll(/\{key:"([^"]+)",\s*id:"([0-9a-f-]{36})"/g)].map(m => [m[1], m[2]]));
const API = "https://data.gov.il/api/3/action/datastore_search";
const HITS = [], LIMIT = 50;
const inWin = () => { const t = Date.now() - 60000; while (HITS.length && HITS[0] < t) HITS.shift(); return HITS.length; };
async function room(n) { while (HITS.length && inWin() + n > LIMIT) await sleep(Math.max(500, HITS[0] + 60000 - Date.now() + 100)); }
async function search(id, p) {
  for (let a = 0; a < 4; a++) {
    await room(1); HITS.push(Date.now());
    try {
      const q = new URLSearchParams({ resource_id: id, ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])) });
      const r = await fetch(API + "?" + q, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(60000) });
      if (!r.ok) { await sleep(5000 * (a + 1)); continue; }
      const j = await r.json(); if (j.success) return j.result;
    } catch { await sleep(3000 * (a + 1)); }
  }
  throw new Error("search failed");
}

/* ---------- the two cars ---------- */
const T = s => String(s ?? "").trim(), U = s => T(s).toUpperCase();
async function car(q, y, trim) {
  const rows = (await search(SETS.active, { q, filters: { shnat_yitzur: y }, limit: 200 })).records.filter(r => /IONIQ/.test(U(r.kinuy_mishari)) && !/ELECTRIC|PLUG|EV/.test(U(r.kinuy_mishari)) && U(r.ramat_gimur) === trim);
  return rows[Math.floor(rows.length / 2)];
}
const GLS = await car("IONIQ GLS", 2016, "GLS"), PREM = await car("IONIQ PREMIUM", 2016, "PREMIUM");
say(ts(), "cars found:", !!GLS, !!PREM);

/* ---------- phone screenshots of the cards (no plate in them) ---------- */
const BLOCK = /cloudflareinsights|google-analytics|googletagmanager|doubleclick|googlesyndication|facebook\.(com|net)|clarity\.ms|hotjar|luchit\.app\/api\/e/;
const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "he-IL", timezoneId: "Asia/Jerusalem", serviceWorkers: "block", colorScheme: "light" });
await ctx.addInitScript(() => { try { localStorage.setItem("analyticsOff", "1"); localStorage.setItem("reviewAsked", "1"); localStorage.setItem("fold:בטיחות", "0"); localStorage.setItem("fold:מידע חשוב שעלה מהנתונים", "0"); } catch {} });
await ctx.route("**/*", route => BLOCK.test(route.request().url()) ? route.abort() : route.continue());
const shots = {};
async function shoot(ref, r, tab, title, name) {
  await room(18);
  const page = await ctx.newPage();
  page.on("request", x => { if (/data\.gov\.il/.test(x.url())) HITS.push(Date.now()); });
  await page.goto(SITES[ref].base + "?plate=" + r.mispar_rechev, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => document.querySelector("#out .id-card"), null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.click(`.tabs [data-tab="${tab}"]`).catch(() => null); await page.waitForTimeout(700);
  const el = await page.evaluateHandle(t => [...document.querySelectorAll("#tabpanel section.card")].find(x => (x.querySelector(".head h2") || {}).textContent?.trim() === t) || null, title);
  if (el && await el.evaluate(x => !!x)) { const b = await el.screenshot({ type: "png" }); shots[name] = b.toString("base64"); fs.writeFileSync(`out/${name}.png`, b); say(ts(), "shot", name, b.length); }
  else say(ts(), "no card", name, title);
  await page.close();
}
await shoot("main", GLS, "overview", "מידע חשוב שעלה מהנתונים", "main-gls-insights");
await shoot("main", GLS, "specs", "בטיחות", "main-gls-safety");
await shoot("next", GLS, "specs", "בטיחות", "next-gls-safety");
await shoot("main", PREM, "specs", "בטיחות", "main-premium-safety");
await shoot("next", PREM, "specs", "בטיחות", "next-premium-safety");

/* ---------- one before/after sheet ---------- */
const img = (n, cap) => shots[n] ? `<figure><figcaption>${cap}</figcaption><img src="data:image/png;base64,${shots[n]}"></figure>` : "";
const sheet = `<!doctype html><html dir="rtl" lang="he"><meta charset="utf-8"><style>
body{margin:0;padding:24px;background:#f4f5f7;font:15px system-ui,Arial;color:#1d2433}h1{font-size:20px;margin:0 0 4px}p.s{margin:0 0 18px;color:#5b6475}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:28px;align-items:start}.col h2{font-size:17px;margin:0 0 10px;padding:6px 10px;border-radius:8px;background:#fff;border:1px solid #dde1e8}
figure{margin:0 0 16px}figcaption{font-weight:600;margin:0 0 6px}img{width:390px;display:block;border-radius:10px;box-shadow:0 1px 4px #0002}</style>
<h1>רמת אבזור בטיחותי: היום מול אחרי התיקון</h1><p class="s">יונדאי IONIQ היברידי 2016, שתי רמות גימור. GLS עם ניטור שטח מת, PREMIUM בלעדיו (אבל עם שמירה על נתיב ושמירת מרחק).</p>
<div class="cols"><div class="col"><h2>היום באתר</h2>${img("main-gls-insights", "GLS, מסך הסקירה")}${img("main-gls-safety", "GLS, כרטיס הבטיחות")}${img("main-premium-safety", "PREMIUM, כרטיס הבטיחות")}</div>
<div class="col"><h2>אחרי התיקון</h2><figure><figcaption>GLS, מסך הסקירה</figcaption><p>אין יותר אזהרה על רמת בטיחות.</p></figure>${img("next-gls-safety", "GLS, כרטיס הבטיחות")}${img("next-premium-safety", "PREMIUM, כרטיס הבטיחות")}</div></div></html>`;
fs.writeFileSync("/tmp/sheet.html", sheet);
const p2 = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 1 });
await p2.goto("file:///tmp/sheet.html"); await p2.waitForTimeout(500);
await p2.screenshot({ path: "out/safety-before-after.png", fullPage: true });
say(ts(), "sheet", fs.statSync("out/safety-before-after.png").size);
await browser.close();
say(ts(), "done");
