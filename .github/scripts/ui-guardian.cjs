// UI guardian, phase B: drives the real page in Chromium with mocked registry answers and checks the vehicle screen.
//   blocking (exit 1): script errors, horizontal overflow, card order / unregistered cards vs ui-contract.json, promo card not last in overview
//   warning:           tap targets < 40px, text < 12px, axe-core (WCAG A/AA) violations above baseline, screenshot diff vs ui-baseline/
// Usage: node .github/scripts/ui-guardian.cjs [--shots] [--update-baseline]
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = process.cwd();
const OUT = path.join(ROOT, "ui-shots");
const BASE_SHOTS = path.join(ROOT, "ui-baseline");
const BASE_FILE = path.join(ROOT, "ui-guardian-baseline.json");
const contract = JSON.parse(fs.readFileSync(path.join(ROOT, "ui-contract.json"), "utf8"));
const args = process.argv.slice(2);
const updateBaseline = args.includes("--update-baseline");
const wantShots = args.includes("--shots");

const errors = [], warnings = [];
const fail = (m) => { errors.push(m); console.log(`::error::${m}`); };
const warn = (m) => { warnings.push(m); console.log(`::warning::${m}`); };

// ---- tiny static server for the repo root
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]); if (p.endsWith("/")) p += "index.html";
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
});

// ---- fixtures: registry answers are mocked, so the run needs no network and is repeatable
const iso = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10) + "T00:00:00"; };
const BASE = { _id: 1, mispar_rechev: 12345678, tozeret_nm: "טויוטה יפן", kinuy_mishari: "COROLLA", degem_nm: "ZRE172", shnat_yitzur: 2021, tzeva_rechev: "לבן", sug_delek_nm: "בנזין", tokef_dt: iso(400), moed_aliya_lakvish: "2021-5", tozeret_cd: 1, degem_cd: 1, nefach_manoa: 1798, baalut: "פרטי" };
const FIXTURES = [
  { name: "petrol-clean", rec: BASE },
  { name: "test-soon", rec: { ...BASE, tokef_dt: iso(18) } },
  { name: "test-expired", rec: { ...BASE, tokef_dt: iso(-30) } },
  { name: "ev", rec: { ...BASE, tozeret_nm: "טסלה", kinuy_mishari: "MODEL 3", degem_nm: "3", sug_delek_nm: "חשמל", nefach_manoa: 0, tozeret_cd: 2 } },
  // an open recall: the recalls tab (a car without an open recall or a settlement shows the "checked" line instead)
  { name: "open-recall", rec: BASE, recall: [{ _id: 1, MISPAR_RECHEV: 12345678, RECALL_ID: 16100, SHNAT_RECALL: 2025, TEUR_TAKALA: "החלפת משאבת דלק", SUG_TAKALA: "מערכת דלק", TAARICH_PTICHA: "2025-06-10T00:00:00" }] },
  // the states where the "checked" line must not say "checked": each is drawn once, and the page must not throw on it
  { name: "settlement-only", rec: { ...BASE, tozeret_nm: "קיה סלובקיה", kinuy_mishari: "SPORTAGE", degem_nm: "QL", shnat_yitzur: 2019, tozeret_cd: 3 } },
  { name: "checked", rec: BASE, model: { modelRecalls: [] } },
  { name: "maybe-recall", rec: BASE, model: { modelRecalls: [{ RECALL_ID: 16900, SHNAT_RECALL: 2026, TEUR_TAKALA: "עדכון תוכנה ליחידת הבלמים", SUG_RECALL: "ריקול בטיחות", fits: true, fresh: true }] } },
  { name: "recall-unknown", rec: BASE, recallStatus: 500 },
  { name: "list-reloading", rec: BASE, listTotal: 0 },
  { name: "saved-copy", rec: BASE, savedDaysAgo: 12 },
];
const TABS = contract.tabs.map((t) => t.id);
const WIDTHS = process.env.UG_QUICK ? [390] : [320, 390];
const THEMES = process.env.UG_QUICK ? ["light"] : ["light", "dark"];

// ---- contract helpers
const tabOf = {}; // title -> tab
for (const [tab, list] of Object.entries(contract.cards)) for (const t of list) tabOf[t] = tab;
const dynamicBase = contract.dynamicCards.map((t) => t.replace(/\s*\(.*\)\s*$/, ""));
const isDynamic = (t) => dynamicBase.includes(t.replace(/\s*\(.*\)\s*$/, "")) || contract.dynamicCards.some((d) => t.startsWith(d.slice(0, 8)));
const baseline = fs.existsSync(BASE_FILE) ? JSON.parse(fs.readFileSync(BASE_FILE, "utf8")) : null;
const totals = { tapSmall: 0, fontSmall: 0, axe: {} };
const shotResults = [];

async function runPage(browser, fx, theme, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 1, isMobile: true, colorScheme: theme, locale: "he-IL" });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());   // registered first: Playwright tries later routes first, so the mock below wins
  await ctx.route(/data\.gov\.il/, (r) => {
    const u = r.request().url(), recList = u.includes("36bf1404");
    if (recList && fx.recallStatus) return r.fulfill({ status: fx.recallStatus, body: "" });
    // a dataset's own size (limit=0): the per-car recall list is loaded unless the fixture says it is being reloaded
    if (/[?&]limit=0\b/.test(u)) return r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ success: true, result: { records: [], total: recList && fx.listTotal !== undefined ? fx.listTotal : 120000 } }) });
    const recs = u.includes("053cea08") ? [fx.rec] : recList && fx.recall ? fx.recall : [];
    r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ success: true, result: { records: recs, total: recs.length } }) });
  });
  // model data the catalogue would give (the catalogue itself is not fetched in the run): fetchModelData is a page-level function
  if (fx.model) await ctx.addInitScript((m) => { addEventListener("DOMContentLoaded", () => { const f = window.fetchModelData; window.fetchModelData = async (...a) => ({ ...(await f(...a)), modelRecallsUnknown: false, ...m }); }); }, fx.model);
  await ctx.addInitScript(() => { try { localStorage.setItem("analyticsOff", "1"); } catch {} });
  const page = await ctx.newPage();
  const label = `${fx.name}/${theme}/${width}px`;
  page.on("pageerror", (e) => fail(`[${label}] page error: ${e.message}`));
  await page.goto(`http://127.0.0.1:${server.address().port}/?plate=12345678`);
  try { await page.waitForSelector(".tabs [role=tab]", { timeout: 15000 }); } catch { fail(`[${label}] the vehicle screen did not render`); await ctx.close(); return; }
  // a saved car opened while the ministry does not answer: the page draws its stored copy, dated
  if (fx.savedDaysAgo) await page.evaluate((d) => { current.fromCache = Date.now() - d * 864e5; renderResult(); }, fx.savedDaysAgo);
  // the "checked" line says "checked" only when every check ran on a live answer
  const line = await page.$eval("details.ckl", (d) => ({ state: d.dataset.line, title: d.querySelector("summary b").textContent })).catch(() => null);
  if (theme === "light" && width === 390) console.log(`  line [${fx.name}] ${line ? line.state + ": " + line.title : "none"}`);
  const live = !fx.savedDaysAgo && !fx.recallStatus && fx.listTotal !== 0 && !!fx.model;
  if (line && /^נבדק/.test(line.title) && !live) fail(`[${label}] the line says "${line.title}" although a check did not run on a live answer`);
  if ((fx.recallStatus || fx.listTotal === 0) && line) fail(`[${label}] the "checked" line shows while the per-car recall list did not answer`);
  if (fx.model && fx.model.modelRecalls.some((r) => r.fresh) && (!line || line.state !== "warn")) fail(`[${label}] a fresh model recall did not turn the line amber`);
  if (live && !fx.model.modelRecalls.length && (!line || line.state !== "ok")) fail(`[${label}] every check ran clean, but the line is "${line ? line.title : "missing"}"`);
  if (fx.savedDaysAgo && line && line.state !== "cached") fail(`[${label}] a saved copy shows the line as "${line.state}", not "cached"`);
  await page.addStyleTag({ content: "#plateStrip{display:none!important}*{animation:none!important;transition:none!important}" });

  // a car shows only the tabs that apply to it (the recalls tab only with an open recall or a settlement), so the run walks the tabs on screen;
  // every one of them must be in the contract, in the contract's order
  const shown = await page.$$eval(".tabs [data-tab]", (bs) => bs.map((b) => b.dataset.tab));
  for (const t of shown) if (!TABS.includes(t)) fail(`[${label}] tab "${t}" is not registered in ui-contract.json`);
  if (/^(open-recall|settlement-only)$/.test(fx.name) !== shown.includes("recalls")) fail(`[${label}] the recalls tab ${shown.includes("recalls") ? "shows" : "is missing"} (tabs: ${shown.join(", ")})`);
  if (shown.filter((t) => TABS.includes(t)).some((t, i, a) => i && TABS.indexOf(t) < TABS.indexOf(a[i - 1]))) fail(`[${label}] tabs render as ${shown.join(", ")}, not in the contract order`);
  for (const tab of shown.filter((t) => TABS.includes(t))) {
    const L = `${label}/${tab}`;
    await page.click(`.tabs [data-tab=${tab}]`); await page.waitForTimeout(350);
    const r = await page.evaluate(() => {
      const titles = [...document.querySelectorAll("#tabpanel .card > .head h2, #tabpanel .card > .head > h2")].map((h) => h.textContent.trim());
      const panel = document.getElementById("tabpanel");
      const hint = panel.querySelector(".apphint");
      const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      const small = [...document.querySelectorAll("#out button, #out a[href], #out [role=button], #out summary, #out select, #out input:not([type=hidden])")].filter(vis).map((e) => ({ e, b: e.getBoundingClientRect() })).filter((x) => x.b.height < 40 && x.b.width < 40).map((x) => (x.e.getAttribute("aria-label") || x.e.textContent.trim() || x.e.className).slice(0, 24));
      const fonts = []; document.querySelectorAll("#tabpanel *").forEach((e) => { if (e.children.length === 0 && e.textContent.trim() && vis(e)) { const f = parseFloat(getComputedStyle(e).fontSize); if (f < 12) fonts.push(e.textContent.trim().slice(0, 20) + " " + f); } });
      return { titles, hintLast: hint ? panel.lastElementChild === hint : true, small, fonts, over: [document.documentElement.scrollWidth, innerWidth] };
    });

    // overflow (blocking)
    if (r.over[0] > r.over[1]) fail(`[${L}] horizontal overflow: page ${r.over[0]}px wide in a ${r.over[1]}px viewport`);
    // overview: promo card last (blocking)
    if (tab === "overview" && !r.hintLast) fail(`[${L}] the app promo card is not the last card in the overview`);
    // order and registration (blocking)
    const order = contract.cards[tab] || [];
    let last = -1;
    for (const t of r.titles) {
      if (isDynamic(t)) continue;
      if (!(t in tabOf)) { fail(`[${L}] card "${t}" is not registered in ui-contract.json`); continue; }
      if (tabOf[t] !== tab) { fail(`[${L}] card "${t}" is registered under "${tabOf[t]}" but renders in "${tab}"`); continue; }
      const i = order.indexOf(t);
      if (i < last) fail(`[${L}] card "${t}" renders before "${order[last]}", but the contract order is the reverse`);
      last = Math.max(last, i);
    }
    totals.tapSmall += r.small.length; totals.fontSmall += r.fonts.length;
    if (r.small.length) console.log(`  tap<40 [${L}] ${[...new Set(r.small)].slice(0, 4).join(", ")}`);
    if (r.fonts.length) console.log(`  font<12 [${L}] ${[...new Set(r.fonts)].slice(0, 4).join(", ")}`);

    // axe (warning vs baseline)
    try {
      await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
      const ax = await page.evaluate(async () => (await axe.run(document.getElementById("out"), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } })).violations.map((v) => ({ id: v.id, n: v.nodes.length })));
      for (const v of ax) totals.axe[v.id] = (totals.axe[v.id] || 0) + v.n;
    } catch (e) { warn(`[${L}] axe did not run: ${e.message.slice(0, 80)}`); }

    if (wantShots) {
      fs.mkdirSync(OUT, { recursive: true });
      const name = `${fx.name}-${tab}-${width}-${theme}.png`;
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(OUT, name), fullPage: true });
      shotResults.push(name);
    }
  }
  await ctx.close();
}

function compareShots() {
  if (!wantShots || !fs.existsSync(BASE_SHOTS)) { if (wantShots) console.log("no ui-baseline/ folder: screenshot comparison skipped (run the workflow with update_baseline to create it)"); return []; }
  const { PNG } = require("pngjs"); const pixelmatch = require("pixelmatch");
  const diffs = []; fs.mkdirSync(path.join(OUT, "diff"), { recursive: true });
  for (const n of shotResults) {
    const bf = path.join(BASE_SHOTS, n); if (!fs.existsSync(bf)) { diffs.push(`${n}: new screen, no baseline`); continue; }
    const a = PNG.sync.read(fs.readFileSync(bf)), b = PNG.sync.read(fs.readFileSync(path.join(OUT, n)));
    if (a.width !== b.width || a.height !== b.height) { diffs.push(`${n}: size changed ${a.width}x${a.height} -> ${b.width}x${b.height}`); continue; }
    const d = new PNG({ width: a.width, height: a.height });
    const px = pixelmatch(a.data, b.data, d.data, a.width, a.height, { threshold: 0.12 });
    const ratio = px / (a.width * a.height);
    if (ratio > 0.005) { diffs.push(`${n}: ${(ratio * 100).toFixed(2)}% of pixels changed`); fs.writeFileSync(path.join(OUT, "diff", n), PNG.sync.write(d)); }
  }
  return diffs;
}

(async () => {
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  let browser;
  try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium" }); }
  for (const fx of FIXTURES) for (const theme of THEMES) for (const w of WIDTHS) await runPage(browser, fx, theme, w);
  await browser.close(); server.close();

  if (updateBaseline) { fs.writeFileSync(BASE_FILE, JSON.stringify({ tapSmall: totals.tapSmall, fontSmall: totals.fontSmall, axe: totals.axe }, null, 2) + "\n"); console.log("baseline written", totals); }
  else if (baseline) {
    if (totals.tapSmall > baseline.tapSmall) warn(`tap targets under 40px: ${totals.tapSmall} (baseline ${baseline.tapSmall})`);
    if (totals.fontSmall > baseline.fontSmall) warn(`text under 12px: ${totals.fontSmall} (baseline ${baseline.fontSmall})`);
    for (const [id, n] of Object.entries(totals.axe)) if (n > ((baseline.axe || {})[id] || 0)) warn(`axe "${id}": ${n} nodes (baseline ${(baseline.axe || {})[id] || 0})`);
  } else warn("ui-guardian-baseline.json is missing; run with --update-baseline");

  const diffs = compareShots();
  for (const d of diffs) warn(`screenshot: ${d}`);

  const md = ["### UI guardian: browser checks", "", `Screens checked: ${FIXTURES.length} fixtures x the tabs each one shows x ${WIDTHS.length} widths x ${THEMES.length} themes`, "",
    `**Blocking problems: ${errors.length}** | warnings: ${warnings.length}`, "",
    ...(errors.length ? ["#### Blocking", ...[...new Set(errors)].slice(0, 30).map((e) => `- ${e}`), ""] : []),
    ...(warnings.length ? ["#### Warnings", ...[...new Set(warnings)].slice(0, 30).map((e) => `- ${e}`), ""] : []),
    `Tap targets under 40px: ${totals.tapSmall}; text under 12px: ${totals.fontSmall}; axe: ${Object.entries(totals.axe).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`].join("\n");
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  process.exit(errors.length ? 1 : 0);
})();
