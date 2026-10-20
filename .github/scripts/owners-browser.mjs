// One-off (probe-go branch, not for main), 20.10: the ownership card and the ownership notes as a user sees them, on main (live) and on
// next (the fix), for real cars of each kind: the reported car (found by the hash of its plate), transfers of one month in each order,
// a dealer that really holds the car now, a register that disagrees with the log, a leased car, a cancelled car, a car on the road before
// 2017 and a dealer's car with no log rows. Plates are never printed: cars are case ids.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
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
  say(ts(), ref, sha.slice(0, 8), "orderOwners in page:", fs.readFileSync(dir + "/index.html", "utf8").includes("function orderOwners"));
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
      const r = await fetch(API + "?" + q, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(90000) });
      if (!r.ok) { await sleep(5000 * (a + 1)); continue; }
      const j = await r.json(); if (j.success) return j.result;
    } catch { await sleep(3000 * (a + 1)); }
  }
  throw new Error("search failed");
}
const T = s => String(s ?? "").trim();
const plateOf = r => String(r.mispar_rechev).replace(/\D/g, "").replace(/^0+/, "");
const ownRows = async p => (await search(SETS.owners, { filters: { mispar_rechev: Number(p) }, limit: 100 })).records;
const regRow = async (key, p) => (await search(SETS[key], { filters: { mispar_rechev: Number(p) }, limit: 5 })).records[0] || null;
const logText = rows => rows.map(r => `${r.baalut_dt} ${T(r.baalut)}`).join(" > ");

/* ---------- the cars ---------- */
const CASES = [];
const addCase = (why, plate, reg, own, set = "active") => { const id = "c" + String(CASES.length + 1).padStart(2, "0"); CASES.push({ id, why, plate, reg, own, set }); say(ts(), id, why, `| register "${T(reg && reg.baalut)}" on road ${T(reg && reg.moed_aliya_lakvish)} | log (API order) ${logText(own)}`); };

// batch lookups (a list in a filter is one request for up to 200 cars)
async function regMany(key, plates, fields = "mispar_rechev,baalut,moed_aliya_lakvish") {
  const m = new Map();
  for (let i = 0; i < plates.length; i += 200) {
    try { for (const r of (await search(SETS[key], { filters: { mispar_rechev: plates.slice(i, i + 200).map(Number) }, limit: 1000, fields })).records) m.set(plateOf(r), r); } catch (e) { say("regMany", e.message); }
  }
  return m;
}
async function ownMany(plates) {
  const m = new Map();
  for (let i = 0; i < plates.length; i += 200) {
    try { for (const r of (await search(SETS.owners, { filters: { mispar_rechev: plates.slice(i, i + 200).map(Number) }, limit: 5000 })).records) { const p = plateOf(r); if (!m.has(p)) m.set(p, []); m.get(p).push(r); } } catch (e) { say("ownMany", e.message); }
  }
  return m;
}
// rows of one month of the log (the month column may be a number or text)
async function monthRows(filters, fields, max = 400000) {
  for (const form of [Number, String]) {
    const out = [];
    for (let off = 0; off < max; off += 32000) {
      let rows = [];
      try { rows = (await search(SETS.owners, { filters: { ...filters, baalut_dt: form(filters.baalut_dt) }, limit: 32000, offset: off, fields })).records; } catch (e) { say("month rows", e.message); break; }
      out.push(...rows); if (rows.length < 32000) break;
    }
    if (out.length) return out;
  }
  return [];
}

// 1. the reported car: a dealer record of 01/2025, matched by the hash of its plate
const HASH = "b963c629a856e795e7c4caa4519e5428c7d08bf39033da273b62ee7e7e41251d", sha = s => createHash("sha256").update(String(s)).digest("hex");
{ const rows = await monthRows({ baalut_dt: 202501, baalut: "סוחר" }, "mispar_rechev"), hit = rows.find(r => sha(Number(r.mispar_rechev)) === HASH);
  if (hit) { const p = plateOf(hit); addCase("the reported car (KIA SPORTAGE 2024)", p, await regRow("active", p), await ownRows(p)); }
  else say("reported car not found among", rows.length, "dealer rows of 01/2025"); }

// 2. recent months of the log, grouped by car, for the other cases
const MONTHS = (process.env.MONTHS || "202609,202410").split(",").map(Number), pool = new Map();
for (const m of MONTHS) { const rows = await monthRows({ baalut_dt: m }, "mispar_rechev,baalut"); for (const r of rows) { const p = plateOf(r); if (!pool.has(p)) pool.set(p, { m, g: [] }); pool.get(p).g.push(T(r.baalut)); } say(ts(), `month ${m}: ${rows.length} rows`); }
say(ts(), `months ${MONTHS}: ${pool.size} cars`);
const groups = (want, max = 400, month = MONTHS[0]) => [...pool].filter(([, x]) => x.m === month && x.g.join(">") === want).slice(0, max).map(([p]) => p);
// regTest on the register row first (one request per 200 cars), then the log of the survivors
async function pickCase(why, cands, regTest, ownTest, set = "active") {
  const regs = await regMany(set, cands), keep = cands.filter(p => regs.has(p) && regTest(regs.get(p))).slice(0, 200), owns = await ownMany(keep);
  for (const p of keep) { const own = owns.get(p) || []; if (ownTest(own, p)) { addCase(why, p, await regRow(set, p), await ownRows(p), set); return; } }
  say("no car for:", why, `| ${cands.length} candidates, ${keep.length} passed the register test`);
}
const lastIs = (own, p) => Math.max(...own.map(r => Number(r.baalut_dt))) === pool.get(p).m;
const reg = v => r => T(r.baalut) === v;
await pickCase("private then dealer in one month (log order), register private: the bug pattern", groups("פרטי>סוחר"), reg("פרטי"), lastIs);
await pickCase("private then dealer in one month, register dealer: a dealer really holds it now", groups("פרטי>סוחר"), reg("סוחר"), lastIs);
await pickCase("dealer then private in one month, register private: already right today", groups("סוחר>פרטי"), reg("פרטי"), (own, p) => lastIs(own, p) && own.length >= 3);
await pickCase("dealer then leasing in one month, register company or empty", [...groups("סוחר>החכר"), ...groups("סוחר>חברה")], () => true, lastIs);
await pickCase("a dealer record two years ago and nothing since, register private: the register and the log disagree", groups("סוחר", 8000, MONTHS[1]), reg("פרטי"), lastIs);
await pickCase("leasing car, register leasing", groups("החכר", 300), reg("ליסינג"), (own, p) => lastIs(own, p) && own.length >= 2);
// 3. a cancelled car with several owners (the log has cars that went on the road from 2017 only)
{ let rows = []; try { rows = (await search(SETS.cancel, { filters: { shnat_yitzur: 2018 }, limit: 400, offset: 300, fields: "mispar_rechev" })).records; } catch (e) { say("cancel sample", e.message); }
  await pickCase("cancelled car (left the road), several owners", rows.map(plateOf), () => true, own => own.length >= 2, "cancel"); }
// 4. a dealer's car with no ownership log rows (on the road before 2017: the log does not cover it)
{ let rows = []; try { rows = (await search(SETS.active, { filters: { baalut: "סוחר" }, limit: 400, offset: 3000, fields: "mispar_rechev" })).records; } catch (e) { say("dealer sample", e.message); }
  const plates = rows.map(plateOf), owns = await ownMany(plates), p = plates.find(x => !owns.has(x));
  if (p) addCase("register dealer, no ownership log rows", p, await regRow("active", p), []); else say("no car for: register dealer, no ownership log rows"); }

/* ---------- the pages ---------- */
const BLOCK = /cloudflareinsights|google-analytics|googletagmanager|doubleclick|googlesyndication|facebook\.(com|net)|clarity\.ms|hotjar|luchit\.app\/api\/e/;
const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
async function context(simple) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2, locale: "he-IL", timezoneId: "Asia/Jerusalem", serviceWorkers: "block" });
  await ctx.addInitScript(s => { try { localStorage.setItem("analyticsOff", "1"); localStorage.setItem("reviewAsked", "1"); localStorage.setItem("fold:מידע חשוב שעלה מהנתונים", "0"); localStorage.setItem("fold:היסטוריית בעלויות", "0"); if (s) localStorage.setItem("simpleView", "1"); } catch {} }, simple);
  await ctx.route("**/*", route => BLOCK.test(route.request().url()) ? route.abort() : route.continue());
  return ctx;
}
async function open(ctx, url, ready) {
  await room(18);
  const page = await ctx.newPage(), bad = [];
  page.on("pageerror", e => bad.push("pageerror: " + String(e.message).slice(0, 140).replace(/\d{6,8}/g, "<n>")));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|net::ERR/.test(m.text())) bad.push("console: " + m.text().slice(0, 140).replace(/\d{6,8}/g, "<n>")); });
  page.on("request", r => { if (/data\.gov\.il/.test(r.url())) HITS.push(Date.now()); });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(ready, null, { timeout: 60000 }).catch(() => bad.push("not ready"));
  await page.waitForTimeout(1500);
  return { page, bad };
}
const carReady = () => document.querySelector("#out .id-card") || document.querySelector("#out .msg.edge");
fs.mkdirSync("out/shots", { recursive: true });
const OUT = { main: {}, next: {} };
for (const ref of ["main", "next"]) {
  const ctx = await context(false);
  for (const c of CASES) {
    const { page, bad } = await open(ctx, SITES[ref].base + "?plate=" + c.plate, carReady);
    try {
      await page.click(`.tabs [data-tab="overview"]`).catch(() => null); await page.waitForTimeout(500);
      const got = await page.evaluate(() => {
        const T = el => (el ? el.textContent : "").replace(/\s+/g, " ").trim();
        const cards = [...document.querySelectorAll("#tabpanel section.card")];
        const own = cards.find(x => /^(היסטוריית בעלויות|בעלות)$/.test(T(x.querySelector(".head h2"))));
        const ins = cards.find(x => /^מידע חשוב/.test(T(x.querySelector(".head h2"))));
        return {
          ownTitle: own ? T(own.querySelector(".head h2")) : "(no card)", count: own ? T(own.querySelector(".head .count")) : "",
          firstOwn: own ? [...own.querySelectorAll(".first-own")].map(T) : [],
          timeline: own ? [...own.querySelectorAll(".timeline > li")].map(li => ({ time: T(li.querySelector("time")), text: T(li.querySelectorAll(":scope > span")[1]), dur: T(li.querySelector(".dur")), cur: li.classList.contains("cur") })) : [],
          facts: own ? [...own.querySelectorAll("dl.facts > div")].map(d => T(d.querySelector("dt")) + ": " + T(d.querySelector("dd"))) : [],
          note: own ? T(own.querySelector("p.note")) : "",
          insights: ins ? [...ins.querySelectorAll(".insights > li")].map(li => T(li.querySelector("b"))) : [],
        };
      });
      // a picture of the ownership card only (no plate on it), at phone width
      if (ref === "next" || c.id === "c01") {
        const el = await page.$$("#tabpanel section.card").then(async els => { for (const e of els) { if (/^(היסטוריית בעלויות|בעלות)$/.test((await e.$eval(".head h2", h => h.textContent.trim()).catch(() => "")))) return e; } return null; });
        if (el) await el.screenshot({ path: `out/shots/${c.id}-${ref}.png` }).catch(() => null);
      }
      OUT[ref][c.id] = { ...got, bad };
    } catch (e) { OUT[ref][c.id] = { err: e.message.slice(0, 160), bad }; }
    await page.close();
  }
  await ctx.close();
}
// the simple view's current owner, on next
const SIMPLE = {};
{ const ctx = await context(true);
  for (const c of CASES) {
    const { page, bad } = await open(ctx, SITES.next.base + "?plate=" + c.plate, carReady);
    await page.click(".simple-more").catch(() => null); await page.waitForTimeout(400);
    SIMPLE[c.id] = await page.evaluate(() => [...document.querySelectorAll("table.simple tr")].filter(x => /בעלות|מספר בעלים/.test(x.textContent)).map(x => x.textContent.replace(/\s+/g, " ").trim()).join(" ; ") || "(no row)") + (bad.length ? " | ERRORS " + bad.join(" | ") : "");
    await page.close();
  }
  await ctx.close(); }
await browser.close();

/* ---------- report: each car, main vs next ---------- */
say("\n========== each car: main (live) vs next (the fix)");
for (const c of CASES) {
  say(`\n## ${c.id} ${c.why} | register "${T(c.reg && c.reg.baalut)}" | log (API order) ${logText(c.own)}`);
  for (const ref of ["main", "next"]) {
    const o = OUT[ref][c.id] || {};
    if (o.err) { say(`  ${ref}: ERROR ${o.err} | ${o.bad}`); continue; }
    say(`  ${ref}: card "${o.ownTitle}" count "${o.count}"${o.firstOwn.length ? " | " + o.firstOwn.join(" || ") : ""}${o.facts.length ? " | facts " + o.facts.join(" ; ") : ""}`);
    for (const t of o.timeline) say(`     ${t.cur ? "●" : "○"} ${t.time} ${t.text}${t.dur ? " · " + t.dur : ""}`);
    say(`    note: ${o.note || "(none)"}`);
    say(`    insights: ${o.insights.join(", ") || "(none)"}`);
    if (o.bad.length) say(`    ERRORS: ${o.bad.join(" | ")}`);
  }
  say(`  simple view (next): ${SIMPLE[c.id]}`);
}
say(ts(), "done");
