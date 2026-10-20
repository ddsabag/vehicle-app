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

/* ---------- the cars: one real car per chosen model-year and trim, picked here on the runner ---------- */
const T = s => String(s ?? "").trim(), U = s => T(s).toUpperCase();
const TARGETS = [
  { set: "active", q: "", y: 2024, level: 6, why: "level 6" },
  { set: "active", q: "", y: 2025, level: 7, why: "level 7" },
  { set: "active", q: "", y: 2026, level: 8, why: "level 8" },
];
const CASES = [];
for (const t of TARGETS) {
  if (!SETS[t.set]) { say("no dataset", t.set); continue; }
  let rows = [];
  try { rows = (await search(SETS[t.set], { ...(t.q ? { q: t.q } : {}), filters: { shnat_yitzur: t.y, ...(t.level ? { ramat_eivzur_betihuty: t.level } : {}) }, limit: 200 })).records; }
  catch (e) { say("search", t.why, e.message); continue; }
  const fit = rows.filter(r => (!t.kin || t.kin.test(U(r.kinuy_mishari || r.degem_nm))) && !(t.not && t.not.test(U(r.kinuy_mishari || r.degem_nm))) && (!t.trim || U(r.ramat_gimur) === t.trim));
  const r = fit[Math.floor(fit.length / 2)];
  if (!r) { say("no car for", t.why, "| rows", rows.length); continue; }
  const id = "c" + String(CASES.length + 1).padStart(2, "0");
  CASES.push({ id, t, plate: String(r.mispar_rechev), row: r });
  say(ts(), id, `${T(r.tozeret_nm)} ${T(r.kinuy_mishari || r.degem_nm)} ${T(r.shnat_yitzur)} ${T(r.ramat_gimur)} | type ${T(r.sug_degem)} | register level "${T(r.ramat_eivzur_betihuty)}" | ${t.set} | ${t.why} | ${fit.length} of ${rows.length} fit`);
}

/* ---------- the pages ---------- */
const BLOCK = /cloudflareinsights|google-analytics|googletagmanager|doubleclick|googlesyndication|facebook\.(com|net)|clarity\.ms|hotjar|luchit\.app\/api\/e/;
const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
async function context(simple) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: "he-IL", timezoneId: "Asia/Jerusalem", serviceWorkers: "block" });
  await ctx.addInitScript(s => { try { localStorage.setItem("analyticsOff", "1"); localStorage.setItem("reviewAsked", "1"); if (s) localStorage.setItem("simpleView", "1"); } catch {} }, simple);
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
const OUT = { main: {}, next: {} };
for (const ref of ["main", "next"]) {
  const ctx = await context(false);
  for (const c of CASES) {
    const { page, bad } = await open(ctx, SITES[ref].base + "?plate=" + c.plate, carReady);
    try {
      const head = await page.evaluate(() => { const T = el => (el ? el.textContent : "").replace(/\s+/g, " ").trim(); return { title: T(document.querySelector("#out .id-title")), sub: T(document.querySelector("#out .id-sub")), edge: T(document.querySelector("#out .msg.edge")) }; });
      const tab = async k => { await page.click(`.tabs [data-tab="${k}"]`).catch(() => null); await page.waitForTimeout(500); };
      await tab("overview");
      const ins = await page.evaluate(() => [...document.querySelectorAll("#tabpanel .insights > li")].map(li => ({ b: (li.querySelector("b") || {}).textContent || "", t: li.textContent.replace(/\s+/g, " ").trim().slice(0, 160) })));
      await tab("specs");
      const card = await page.evaluate(() => {
        const T = el => (el ? el.textContent : "").replace(/\s+/g, " ").trim();
        const c = [...document.querySelectorAll("#tabpanel section.card")].find(x => T(x.querySelector(".head h2")) === "בטיחות");
        if (!c) return null;
        return { facts: [...c.querySelectorAll("dl.facts > div")].map(d => T(d.querySelector("dt")) + ": " + T(d.querySelector("dd"))), yes: [...c.querySelectorAll("span.y")].map(T), no: [...c.querySelectorAll("span.n")].map(T), notes: [...c.querySelectorAll("p.note")].map(T) };
      });
      OUT[ref][c.id] = { head, ins, card, bad };
    } catch (e) { OUT[ref][c.id] = { err: e.message.slice(0, 160), bad }; }
    await page.close();
  }
  await ctx.close();
}

/* ---------- report: each car, main vs next ---------- */
say("\n========== each car: main (live) vs next (the fix)");
for (const c of CASES) {
  const r = c.row; say(`\n## ${c.id} ${T(r.tozeret_nm)} ${T(r.kinuy_mishari || r.degem_nm)} ${T(r.shnat_yitzur)} ${T(r.ramat_gimur)} | register level "${T(r.ramat_eivzur_betihuty)}" | ${c.t.why}`);
  for (const ref of ["main", "next"]) {
    const o = OUT[ref][c.id] || {};
    if (o.err) { say(`  ${ref}: ERROR ${o.err} | ${o.bad}`); continue; }
    say(`  ${ref}: page "${o.head.title} | ${o.head.sub}"${o.head.edge ? " EDGE " + o.head.edge.slice(0, 100) : ""}`);
    const sIns = o.ins.filter(i => /בטיחות/.test(i.t));
    say(`    insights about safety: ${sIns.length ? sIns.map(i => i.t).join(" || ") : "(none)"} | all insight titles: ${o.ins.map(i => i.b).join(", ") || "(none)"}`);
    if (!o.card) say("    safety card: (none)");
    else { say(`    safety card facts: ${o.card.facts.join(" ; ") || "(none)"}`); say(`    systems yes: ${o.card.yes.join(", ") || "-"} | no: ${o.card.no.join(", ") || "-"}`); say(`    notes: ${o.card.notes.join(" || ") || "(none)"}`); }
    if (o.bad.length) say(`    ERRORS: ${o.bad.join(" | ")}`);
  }
}

/* ---------- the simple view and the comparison, on next ---------- */
const byWhy = w => CASES.find(c => c.t.why === w);
const pick = [byWhy("the trim with blind-spot monitoring"), byWhy("the same model-year without it"), byWhy("built before 2014")].filter(Boolean);
say("\n========== simple view (next)");
{
  const ctx = await context(true);
  for (const c of pick) {
    const { page, bad } = await open(ctx, SITES.next.base + "?plate=" + c.plate, carReady);
    await page.click(".simple-more").catch(() => null); await page.waitForTimeout(400);
    const row = await page.evaluate(() => { const tr = [...document.querySelectorAll("table.simple tr")].find(x => /רמת אבזור בטיחותי/.test(x.textContent)); return tr ? tr.textContent.replace(/\s+/g, " ").trim() : "(no row)"; });
    say(`  ${c.id}: ${row}${bad.length ? " | ERRORS " + bad.join(" | ") : ""}`);
    await page.close();
  }
  await ctx.close();
}
say("\n========== comparison (next): two cars, then the same two as models");
const cmpReady = () => document.querySelector(".cmp-k") || document.querySelector("#out .msg");
async function cmpRow(code, label) {
  const ctx = await context(false);
  const { page, bad } = await open(ctx, SITES.next.base + "?compare=" + code, cmpReady);
  const r = await page.evaluate(() => {
    const T = el => (el ? el.textContent : "").replace(/\s+/g, " ").trim();
    const heads = [...document.querySelectorAll(".cmp-h")].map(h => T(h.querySelector("b")) + " " + T(h.querySelector("small")));
    const k = [...document.querySelectorAll(".cmp-k")].find(x => T(x) === "רמת אבזור בטיחותי");
    const vals = []; let n = k && k.nextElementSibling; while (n && n.classList.contains("cmp-v")) { vals.push(T(n) + (n.classList.contains("win") ? " (מודגש)" : "")); n = n.nextElementSibling; }
    return { heads, vals: k ? vals : null };
  });
  say(`  ${label}: columns ${JSON.stringify(r.heads)} | safety row ${JSON.stringify(r.vals)}${bad.length ? " | ERRORS " + bad.join(" | ") : ""}`);
  await page.close(); await ctx.close();
}
const [g, p] = [byWhy("the trim with blind-spot monitoring"), byWhy("the same model-year without it")];
if (g && p) {
  await cmpRow(`${g.plate},${p.plate}`, "cars GLS vs PREMIUM");
  const tok = c => "m" + [T(c.row.tozeret_cd), T(c.row.degem_cd) + (U(c.row.sug_degem) === "M" ? "M" : ""), T(c.row.shnat_yitzur)].join(".") + "." + encodeURIComponent(T(c.row.ramat_gimur));
  await cmpRow(`${tok(g)},${tok(p)}`, "models GLS vs PREMIUM");
}
await browser.close();
say(`\n${ts()} done`);
