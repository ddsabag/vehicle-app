// UI guardian, phase B: drives the real page in Chromium with mocked registry answers and checks the vehicle screen and the other screens
// (home, "הרכבים שלי", "התראות", a tool) with the bottom bar.
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
  // the owner's file: a car marked as theirs, with a service log, shows "תיק הרכב" in place of "קנייה"
  { name: "owner", rec: BASE, ls: { mine: '{"12345678":1}', svc: JSON.stringify({ 12345678: { log: [{ id: 1, d: iso(-140).slice(0, 10), km: 63900, type: "טיפול תקופתי", cost: 1250, note: "" }, { id: 2, d: iso(-20).slice(0, 10), km: 66100, type: "קריאת ק״מ", cost: 0, note: "" }], meta: null } }) } },
  // an open recall: the recalls tab (a car without an open recall or a settlement shows the "checked" line instead)
  { name: "open-recall", rec: BASE, recall: [{ _id: 1, MISPAR_RECHEV: 12345678, RECALL_ID: 16100, SHNAT_RECALL: 2025, TEUR_TAKALA: "החלפת משאבת דלק", SUG_TAKALA: "מערכת דלק", TAARICH_PTICHA: "2025-06-10T00:00:00" }] },
  // the states where the "checked" line must not say "checked": each is drawn once, and the page must not throw on it
  { name: "settlement-only", rec: { ...BASE, tozeret_nm: "קיה סלובקיה", kinuy_mishari: "SPORTAGE", degem_nm: "QL", shnat_yitzur: 2019, tozeret_cd: 3 } },
  { name: "checked", rec: BASE, model: { modelRecalls: [] } },
  { name: "maybe-recall", rec: BASE, model: { modelRecalls: [{ RECALL_ID: 16900, SHNAT_RECALL: 2026, TEUR_TAKALA: "עדכון תוכנה ליחידת הבלמים", SUG_RECALL: "ריקול בטיחות", fits: true, fresh: true }] } },
  { name: "recall-unknown", rec: BASE, recallStatus: 500 },
  { name: "list-reloading", rec: BASE, listTotal: 0 },
  { name: "saved-copy", rec: BASE, savedDaysAgo: 12 },
  // the buyer-card rules of 11/2026 (data truth review): a taxi shown as private, "no red flags" beside a flag, recall lines that contradict the ministry
  { name: "public-use", rec: BASE, sets: { "cf29862d": [{ _id: 1, mispar_rechev: 12345678, tozeret_cd: 1, degem_cd: 1, sug_rechev_nm: "מונית", bitul_cd: "0" }] }, expect: { insight: /במאגר הרכב הציבורי \(מונית\)/, flag: /במאגר הרכב הציבורי/ } },
  { name: "rental-now", rec: { ...BASE, baalut: "השכרה" }, expect: { flag: /חברת השכרה/ } },
  { name: "after-road", rec: { ...BASE, moed_aliya_lakvish: "2021-3" }, model: { modelRecalls: [{ RECALL_ID: 16900, SHNAT_RECALL: 2026, TEUR_TAKALA: "החלפת כרית אוויר", SUG_RECALL: "ריקול בטיחות", BUILD_BEGIN_A: "2021-08-01", BUILD_END_A: "2022-02-28", fits: true, fresh: true }] }, expect: { line: "ok", noFlag: /ריקול/ } },
  { name: "unlisted", rec: BASE, model: { modelRecalls: [{ RECALL_ID: 9100, SHNAT_RECALL: 2015, TEUR_TAKALA: "החלפת כרית אוויר", SUG_RECALL: "ריקול בטיחות", fits: true, reach: "nolist" }] }, expect: { line: "unlisted" } },
  // data audit 14.11/19.11: the hands when the register's owner is not in the log yet, the drive type of a regular hybrid, a model list that fails
  { name: "hands-extra", rec: { ...BASE, baalut: "ליסינג" }, sets: { "bb2355dc": [{ _id: 1, mispar_rechev: 12345678, baalut: "החכר", baalut_dt: "201705" }, { _id: 2, mispar_rechev: 12345678, baalut: "פרטי", baalut_dt: "202001" }, { _id: 3, mispar_rechev: 12345678, baalut: "סוחר", baalut_dt: "202306" }] }, expect: { hands: /^לפחות יד שלישית/ } },
  { name: "regular-hybrid", rec: { ...BASE, sug_delek_nm: "חשמל/בנזין" }, model: { w: { technologiat_hanaa_nm: "היברידי רגיל" }, modelRecalls: [] }, expect: { drive: "היברידי" } },
  { name: "model-fails", rec: BASE, fail: ["142afde2", "39f455bf"], expect: { partial: true } },
  // a report someone sent (s= on the web): what was found on top, and a plate field as the one main action (share-loop spec 7.11)
  { name: "shared-recv", rec: BASE, query: "&s=wa", recv: true },
  // the share picture with a full set of spec tiles (engine model first)
  { name: "share-rich", rec: { ...BASE, degem_manoa: "2ZR-FXE" }, model: { w: { koah_sus: 122, nefah_manoa: 1798, automatic_ind: 1, hanaa_nm: "קדמית", mishkal_kolel: 1810, kosher_grira_im_blamim: 750 }, modelRecalls: [] }, expect: { specs: 6 } },
  // buy version 1: an expired test names the test as a blocker, a disabled-parking tag stays on the screen, a personal import has no price gauge,
  // a dashboard km far under the car's pace, an asking price above the range (the gauge's dot at its edge)
  { name: "buy-expired", rec: { ...BASE, tokef_dt: iso(-30) }, buy: { transfer: /^bad:הטסט פג .*העברה באינטרנט לא אפשרית/ } },
  { name: "buy-tag", rec: BASE, sets: { "c8b9f9c8": [{ _id: 1, "MISPAR RECHEV": 12345678, "TAARICH HAFAKAT TAG": "20240115" }] }, buy: { transfer: /^bad:לרכב יש תג חניה לנכה/ } },
  { name: "buy-km-low", rec: { ...BASE, kilometer_test_aharon: 60000, mivchan_acharon_dt: iso(-365), misgeret: "JTDKB3FU503124417" }, buy: { km: [61000, "low"] } },
  { name: "buy-import", rec: BASE, sets: { "03adc637": [{ _id: 1, mispar_rechev: 12345678, tozeret_nm: "טויוטה יפן", kinuy_mishari: "COROLLA", shnat_yitzur: 2021, sug_yevu: "יבוא אישי משומש", tozeret_cd: 1, degem_cd: 1 }] }, buy: { transfer: /^unk:רכב ביבוא אישי/, noGauge: true } },
  { name: "buy-bought", rec: BASE, buy: { bought: true } },
  { name: "app-buy", rec: { ...BASE, tokef_dt: iso(-30) }, app: true, buy: { transfer: /^bad:הטסט פג/ } },
  { name: "app-owner", rec: BASE, app: true, ls: { mine: '{"12345678":1}' } },
  { name: "buy-ask-above", rec: BASE, model: { price: { mehir: 150000 }, modelRecalls: [] }, buy: { ask: [400000, "above", true] } },
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
    if (fx.fail && fx.fail.some((k) => u.includes(k))) return r.fulfill({ status: 500, body: "" });
    const set = fx.sets && Object.keys(fx.sets).find((k) => u.includes(k));
    const recs = u.includes("053cea08") ? [fx.rec] : set ? fx.sets[set] : recList && fx.recall ? fx.recall : [];
    r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ success: true, result: { records: recs, total: recs.length } }) });
  });
  // model data the catalogue would give (the catalogue itself is not fetched in the run): fetchModelData is a page-level function
  if (fx.model) await ctx.addInitScript((m) => { addEventListener("DOMContentLoaded", () => { const f = window.fetchModelData; window.fetchModelData = async (...a) => ({ ...(await f(...a)), modelRecallsUnknown: false, ...m }); }); }, fx.model);
  // fx.app: the page as the Android app runs it, with the bridge methods buy version 1 calls (alerts, the share menu) and a record of what they got
  if (fx.app) await ctx.addInitScript(() => { const st = { alerts: false }; window.__app = { shared: [], alerts: [] }; window.AndroidApp = { setAlerts: (on) => { st.alerts = on; window.__app.alerts.push(on); }, alertsState: () => (st.alerts ? "on" : "off"), share: (t, x) => window.__app.shared.push(x), logEvent: () => {}, logError: () => {}, setTheme: () => {}, setBars: () => {}, systemDark: () => false, syncSaved: () => {}, savedCopy: () => "" }; });
  await ctx.addInitScript((ls) => { try { localStorage.setItem("analyticsOff", "1"); for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v); } catch {} }, { theme, ...(fx.ls || {}) });   // the app starts light whatever the phone says, so the dark run sets the choice
  const page = await ctx.newPage();
  const label = `${fx.name}/${theme}/${width}px`;
  page.on("pageerror", (e) => fail(`[${label}] page error: ${e.message}`));
  await page.goto(`http://127.0.0.1:${server.address().port}/?plate=12345678${fx.query || ""}`);
  try { await page.waitForSelector(".tabs [role=tab]", { timeout: 15000 }); } catch { fail(`[${label}] the vehicle screen did not render`); await ctx.close(); return; }
  // a saved car opened while the ministry does not answer: the page draws its stored copy, dated
  if (fx.savedDaysAgo) await page.evaluate((d) => { current.fromCache = Date.now() - d * 864e5; renderResult(); }, fx.savedDaysAgo);
  // the "checked" line says "checked" only when every check ran on a live answer
  const line = await page.$eval("details.ckl", (d) => ({ state: d.dataset.line, title: d.querySelector("summary b").textContent })).catch(() => null);
  if (theme === "light" && width === 390) console.log(`  line [${fx.name}] ${line ? line.state + ": " + line.title : "none"}`);
  const live = !fx.savedDaysAgo && !fx.recallStatus && fx.listTotal !== 0 && !!fx.model;
  if (line && /^נבדק/.test(line.title) && !live) fail(`[${label}] the line says "${line.title}" although a check did not run on a live answer`);
  if ((fx.recallStatus || fx.listTotal === 0) && line) fail(`[${label}] the "checked" line shows while the per-car recall list did not answer`);
  if (fx.model && !(fx.expect && fx.expect.line) && fx.model.modelRecalls.some((r) => r.fresh) && (!line || line.state !== "warn")) fail(`[${label}] a fresh model recall did not turn the line amber`);
  if (live && !fx.model.modelRecalls.length && (!line || line.state !== "ok")) fail(`[${label}] every check ran clean, but the line is "${line ? line.title : "missing"}"`);
  if (fx.savedDaysAgo && line && line.state !== "cached") fail(`[${label}] a saved copy shows the line as "${line.state}", not "cached"`);
  // the buyer card's flags and its "no red flags" line: that line only when every register answered and nothing was flagged
  const bc = await page.evaluate(() => { const d = document.createElement("div"); d.innerHTML = buyerCard(current); return { flags: [...d.querySelectorAll(".bflags li")].map((l) => l.textContent), none: /לא עלו דגלים אדומים/.test(d.textContent), partial: /לא כל הנתונים נטענו/.test(d.textContent), ins: buildInsights(current).map((i) => i.title), hands: ownersLabel(current), drive: (driveType(current) || {}).label || "", msg: /המידע על הרכב חלקי/.test(document.getElementById("out").textContent) }; }).catch((e) => ({ err: e.message }));
  if (bc.err) fail(`[${label}] the buyer card did not build: ${bc.err}`);
  else {
    if (bc.none && bc.flags.length) fail(`[${label}] the buyer card says "no red flags" beside ${bc.flags.length} flags`);
    if (bc.none && (fx.recallStatus || fx.listTotal === 0)) fail(`[${label}] the buyer card says "no red flags" while the per-car recall list did not answer`);
    if (fx.recallStatus && !bc.partial) fail(`[${label}] the recall list did not answer, and the buyer card does not say the data is partial`);
    const ex = fx.expect || {};
    if (ex.insight && !bc.ins.some((t) => ex.insight.test(t))) fail(`[${label}] no insight matches ${ex.insight}: ${bc.ins.join(" | ")}`);
    if (ex.flag && !bc.flags.some((t) => ex.flag.test(t))) fail(`[${label}] no buyer-card flag matches ${ex.flag}: ${bc.flags.join(" | ") || "none"}`);
    if (ex.noFlag && bc.flags.some((t) => ex.noFlag.test(t))) fail(`[${label}] a buyer-card flag matches ${ex.noFlag}: ${bc.flags.join(" | ")}`);
    if (ex.hands && !ex.hands.test(bc.hands)) fail(`[${label}] the hands read "${bc.hands}", not ${ex.hands}`);
    if (ex.drive && bc.drive !== ex.drive) fail(`[${label}] the drive type reads "${bc.drive}", not "${ex.drive}"`);
    if (ex.partial && !(bc.msg && bc.partial && !bc.none)) fail(`[${label}] a model list failed, and the page ${bc.msg ? "" : "does not say the data is partial"}${bc.none ? " says no red flags" : ""}`);
    if (ex.line && (!line || line.state !== ex.line)) fail(`[${label}] the checked line is "${line ? line.state : "missing"}", not "${ex.line}"`);
  }
  // one share button, no sheet (Dudu 20.11): the picture is drawn for every fixture, with tiles and no "clean" line while a register did not answer
  {
    // UG_SHARE_OUT=<dir> also saves each fixture's picture there, to look at
    if (process.env.UG_SHARE_OUT && theme === "light" && width === 390) { const u = await page.evaluate(async () => (await drawShareImage(current)).toDataURL("image/png")).catch(() => ""); if (u) fs.writeFileSync(path.join(process.env.UG_SHARE_OUT, fx.name + ".png"), Buffer.from(u.split(",")[1], "base64")); }
    const sh = await page.evaluate(async () => { const c = await drawShareImage(current), rows = shareRows(current), v = shareVerdict(current, rows); return { w: c.width, h: c.height, specs: shareSpecs(current).length, empty: shareSpecs(current).some((t) => !String(t[1]).trim()), verdict: v, sheet: !!document.querySelector("#shareSheet"), end: !!document.querySelector(".share-end [data-act=share]"), mine: isMine(current) }; }).catch((e) => ({ err: e.message }));
    if (sh.err) fail(`[${label}] the share picture did not draw: ${sh.err}`);
    else {
      if (sh.w !== 1080 || sh.h !== 1350) fail(`[${label}] the share picture is ${sh.w}x${sh.h}, not 1080x1350`);
      if (sh.empty) fail(`[${label}] the share picture has an empty spec tile`);
      if (sh.sheet) fail(`[${label}] the old share sheet is still on the page`);
      if ((fx.recallStatus || fx.listTotal === 0) && sh.verdict[0] === "ok") fail(`[${label}] the share picture reads "${sh.verdict[1]}" although the recall list did not answer`);
      if (fx.expect && fx.expect.specs && sh.specs !== fx.expect.specs) fail(`[${label}] the share picture has ${sh.specs} spec tiles, not ${fx.expect.specs}`);
      if (theme === "light" && width === 390) console.log(`  share [${fx.name}] ${sh.verdict.join(": ")}, ${sh.specs} tiles${sh.end ? ", end card" : ""}`);
    }
  }
  if (fx.recv) {
    const rv = await page.evaluate(() => ({ top: (document.querySelector(".shared-top b") || {}).textContent || "", line: !!document.querySelector(".shared-top .kl"), form: !!document.querySelector(".sharebar form[data-recv] input"), install: !!document.querySelector(".sharebar [data-act=openapp], .sharebar [data-act=openplay]") }));
    if (!/קיבלתם בדיקה של/.test(rv.top) || !rv.line || !rv.form || rv.install) fail(`[${label}] the shared report: ${JSON.stringify(rv)} (want the "received" title with the found line, a plate field, no install button before the recipient's own check)`);
  }
  // the buy tab of buy version 1 (buy-and-file spec 20.11): the transfer check, the seller message, the km check, the price gauge.
  // UG_BUY_OUT=<dir> also saves the stages, the message, the km check and the gauge of each fixture with fx.buy there, to look at
  if (fx.app && fx.ls?.mine) await appFileChecks(page, label);
  if (fx.buy && !fx.ls?.mine) await buyChecks(page, fx, label, theme === "light" && width === 390 ? process.env.UG_BUY_OUT : "");
  await page.addStyleTag({ content: "*{animation:none!important;transition:none!important}" });

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
      if (i < last) fail(`[${L}] card "${t}" renders after "${order[last]}", but ui-contract.json puts it before`);
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

// item 3 of the file (Dudu 20.11): in the app, a car that is the owner's asks for the alerts with its test date, once, and the answer is kept
async function appFileChecks(page, label) {
  await page.click(".tabs [data-tab=file]"); await page.waitForTimeout(300);
  const c = await page.evaluate(() => ({ tab: currentTab, ask: (document.querySelector("#tabpanel .cf-ask b") || {}).textContent || "" }));
  if (c.tab !== "file" || !/^הטסט ב-\d{1,2}\.\d{1,2}\.\d{2}\. נזכיר שבועיים לפני\.$/.test(c.ask)) { fail(`[${label}] the owner's file does not ask for the alerts with the test date: ${JSON.stringify(c)}`); return; }
  await page.click("#tabpanel .cf-ask [data-bm=askOn]"); await page.waitForTimeout(900);
  const a = await page.evaluate(() => ({ on: window.__app.alerts, card: !!document.querySelector("#tabpanel .cf-ask"), kept: JSON.parse(localStorage.getItem("alertAsk") || "{}")[current.plate] }));
  if (a.on.join() !== "true" || a.card || a.kept !== "granted") fail(`[${label}] "הפעלת תזכורות": ${JSON.stringify(a)}`);
}

async function buyChecks(page, fx, label, out) {
  const ex = fx.buy, shot = async (sel, name) => { if (!out) return; const el = await page.$(sel); if (el) await el.screenshot({ path: path.join(out, `${fx.name}-${name}.png`) }); };
  if (out) await page.addStyleTag({ content: "#bnav,.skip,#toast{display:none!important}.chead,.tabs{position:static!important}" });   // the bottom bar and the sticky head would cover the card in its picture
  await page.click(".tabs [data-tab=buy]"); await page.waitForTimeout(300);
  await shot("#tabpanel .buyer-card", "stages");
  const b = await page.evaluate(() => ({ rows: transferCheck(current).map((r) => r.k + ":" + r.t), pub: transferCheck(current, true).map((r) => r.t), msg: sellerText(current), chips: document.querySelectorAll(".bchips [data-bstage]").length }));
  if (b.chips !== 4) fail(`[${label}] the buy tab shows ${b.chips} stage chips, not 4`);
  if (ex.transfer && !b.rows.some((r) => ex.transfer.test(r))) fail(`[${label}] no transfer row matches ${ex.transfer}: ${b.rows.join(" | ")}`);
  if (/תג חניה לנכה|לרכב יש תג/.test(await page.evaluate(() => buyPrint(current)))) fail(`[${label}] the disabled-parking tag reaches the checklist PDF`);
  if (b.pub.some((t) => /נכה/.test(t)) || /נכה/.test(b.msg)) fail(`[${label}] the disabled-parking tag reaches a report or the seller message`);
  if (/לוחית/.test(b.msg)) fail(`[${label}] the seller message names לוחית without the buyer ticking it`);
  await page.click("[data-bm=msg]"); await page.waitForTimeout(150);
  if (!(await page.$("#smsg:not([hidden]) #smPrev"))) fail(`[${label}] the seller message did not open`);
  await shot("#tabpanel .buyer-card", "seller-msg");
  if (fx.app) { await page.click("[data-bm=wa]"); const sh = await page.evaluate(() => window.__app.shared); if (sh.length !== 1 || !/^היי, ראיתי את המודעה/.test(sh[0])) fail(`[${label}] in the app the seller message did not reach the share menu: ${JSON.stringify(sh)}`); }
  await page.click("[data-bm=msg]");
  if (ex.km) {
    await page.click("[data-bstage='2']"); await page.waitForTimeout(250);
    await page.fill("#kmIn", String(ex.km[0])); await page.click("form[data-bkm] button"); await page.waitForTimeout(150);
    const res = await page.$eval("#kmRes [data-res]", (e) => e.dataset.res).catch(() => "none shown");
    if (res !== ex.km[1]) fail(`[${label}] the km check of ${ex.km[0]} reads "${res}", not "${ex.km[1]}"`);
    if (!(await page.$("#mchk [data-bmatch]"))) fail(`[${label}] the check against the registration is missing beside the car`);
    await page.click("#mchk [data-bmatch=color][data-v='0']"); await page.waitForTimeout(100);
    if (!(await page.$("#mchk .vd.bad"))) fail(`[${label}] a colour marked as not matching does not say so`);
    await page.click("#mchk [data-bmatch=color][data-v='0']");
    const pr = await page.evaluate(() => buyPrint(current));
    if (!pr.includes(Number(ex.km[0]).toLocaleString("en-US"))) fail(`[${label}] the checklist PDF leaves out the dashboard km the buyer typed`);
    await shot("#tabpanel section.card:has(.kmchk)", "km-check");
    await page.click("[data-bstage='1']"); await page.waitForTimeout(150);
  }
  if (ex.ask) {
    await page.fill("#askIn", String(ex.ask[0])); await page.click("[data-act=candSave]"); await page.waitForTimeout(250);
    const g = await page.evaluate(() => { const e = document.querySelector(".bgauge"); return e ? { pos: e.dataset.pos || "", edge: !!e.querySelector(".pm-dot.edge"), vd: (document.querySelector(".bgauge + .vd") || {}).textContent || "" } : null; });
    if (!g) fail(`[${label}] the price card has no gauge`);
    else {
      if (g.pos !== ex.ask[1]) fail(`[${label}] an asking price of ${ex.ask[0]} reads "${g.pos}", not "${ex.ask[1]}"`);
      if (ex.ask[2] && !g.edge) fail(`[${label}] a price off the scale does not sit at its edge`);
      if (/מציאה|עסקה טובה|מומלץ|יקר מדי/.test(g.vd)) fail(`[${label}] the price sentence judges the deal: ${g.vd}`);
    }
    await shot("#tabpanel section.card:has(.bgauge)", "price-gauge");
  }
  if (ex.noGauge && (await page.$(".bgauge"))) fail(`[${label}] a car with no list price shows a price gauge`);
  // "קניתי אותו" at the end of the day of the transfer: the candidate becomes the owner's car and opens in its file
  if (ex.bought) {
    await page.click("[data-bstage='4']"); await page.waitForTimeout(200);
    const btn = await page.$(".bstage:not([hidden]) [data-cf=mine][data-from=bought]");
    if (!btn) fail(`[${label}] the day of the transfer has no "קניתי אותו"`);
    else {
      await btn.click(); await page.waitForTimeout(400);
      const f = await page.evaluate(() => ({ tab: currentTab, mine: isMine(current), buy: !!document.querySelector(".tabs [data-tab=buy]"), top: (document.querySelector("#tabpanel .cf-top") || {}).textContent || "" }));
      if (f.tab !== "file" || !f.mine || f.buy) fail(`[${label}] "קניתי אותו" did not open the car's file: ${JSON.stringify(f)}`);
      if (/הכול נשמר|לא אצלנו/.test(f.top)) fail(`[${label}] the file's storage line still promises more than is kept: ${f.top}`);
    }
  }
}

// ---- the screens around the car page: each opens from the bottom bar (or a home tool), shows its own header, keeps the bar, never overflows
const SAVED = (() => { const d = (n) => iso(n).slice(0, 10);
  return JSON.stringify([
    { plate: "11122233", title: "קיה SPORTAGE", sub: "2019", nick: "רכב המשפחה", at: 1, reg: "active", tokef: d(25), mivchan: d(-340), recalls: 1, recIds: "16100", checked: 1, owners: 1, active: true, events: [], alerts: true, color: "כסף מטלי" },
    { plate: "44455566", title: "מאזדה CX-5", sub: "2020", at: 2, reg: "active", tokef: d(160), mivchan: d(-205), recalls: 0, checked: 1, owners: 2, active: true, events: [], alerts: true, color: "אדום" },
    { plate: "33344455", title: "סקודה OCTAVIA", sub: "2018", at: 3, reg: "active", tokef: d(90), mivchan: d(-275), recalls: 0, checked: 1, owners: 1, active: true, events: [], alerts: true, color: "שחור", ask: 72000, fair: [68000, 75000] }]); })();
const SCREENS = [
  { name: "home-new", head: "#plate" },
  { name: "home", head: "#plate", ls: { savedVehicles: SAVED, recentPlates: '["44455566"]' } },
  { name: "cars", nav: "cars", head: "#carsHead", ls: { savedVehicles: SAVED, carsMode: "list" } },
  { name: "cars-table", nav: "cars", head: "#carsHead", ls: { savedVehicles: SAVED, carsMode: "table" } },
  { name: "cars-empty", nav: "cars", head: "#carsHead" },
  { name: "alerts", nav: "alerts", head: "#alertsHead", ls: { savedVehicles: SAVED } },
  { name: "bulk", act: "bulk", head: "#chead [data-act=toolBack]" },
];
async function runScreen(browser, sc, theme, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 1, isMobile: true, colorScheme: theme, locale: "he-IL" });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
  await ctx.addInitScript((ls) => { try { localStorage.setItem("analyticsOff", "1"); for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v); } catch {} }, { theme, ...(sc.ls || {}) });
  const page = await ctx.newPage();
  const L = `${sc.name}/${theme}/${width}px`;
  page.on("pageerror", (e) => fail(`[${L}] page error: ${e.message}`));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  try { await page.waitForSelector("#homeMark", { state: "attached", timeout: 15000 }); } catch { fail(`[${L}] the home screen did not render`); await ctx.close(); return; }
  await page.addStyleTag({ content: "*{animation:none!important;transition:none!important}" });
  if (sc.nav) await page.click(`#bnav [data-nav=${sc.nav}]`);
  if (sc.act) await page.click(`#out [data-act=${sc.act}]`);
  await page.waitForTimeout(350);
  const r = await page.evaluate((head) => {
    const vis = (e) => { const b = e && e.getBoundingClientRect(); return !!b && b.width > 0 && b.height > 0; };
    // a link inside a sentence (".note .lnk") is exempt, as in WCAG 2.5.8
    const small = [...document.querySelectorAll("#out button, #out a[href], #out [role=button], #out summary, #out input:not([type=hidden]), #bnav button")].filter((e) => vis(e) && !e.matches(".note .lnk")).map((e) => ({ e, b: e.getBoundingClientRect() })).filter((x) => x.b.height < 40 && x.b.width < 200).map((x) => (x.e.textContent || x.e.getAttribute("aria-label") || "").trim().slice(0, 20));
    const fonts = []; document.querySelectorAll("#out *, #bnav *").forEach((e) => { if (e.children.length === 0 && e.textContent.trim() && vis(e)) { const f = parseFloat(getComputedStyle(e).fontSize); if (f < 12) fonts.push(e.textContent.trim().slice(0, 20) + " " + f + "px"); } });
    return { head: vis(document.querySelector(head)), bar: vis(document.getElementById("bnav")), band: vis(document.querySelector(".band")), screen: document.body.dataset.screen, small, fonts, over: [document.documentElement.scrollWidth, innerWidth] };
  }, sc.head);
  if (!r.head) fail(`[${L}] the screen's own header (${sc.head}) is not on screen (screen: ${r.screen})`);
  if (!r.bar) fail(`[${L}] the bottom bar is hidden`);
  if (r.band !== (r.screen === "home")) fail(`[${L}] the search band ${r.band ? "shows" : "is missing"} on the "${r.screen}" screen`);
  if (r.over[0] > r.over[1]) fail(`[${L}] horizontal overflow: page ${r.over[0]}px wide in a ${r.over[1]}px viewport`);
  totals.tapSmall += r.small.length; totals.fontSmall += r.fonts.length;
  if (r.small.length) console.log(`  tap<40 [${L}] ${[...new Set(r.small)].slice(0, 4).join(", ")}`);
  if (r.fonts.length) console.log(`  font<12 [${L}] ${[...new Set(r.fonts)].slice(0, 4).join(", ")}`);
  try {
    await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
    const ax = await page.evaluate(async () => (await axe.run(document.body, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } })).violations.map((v) => ({ id: v.id, n: v.nodes.length })));
    for (const v of ax) totals.axe[v.id] = (totals.axe[v.id] || 0) + v.n;
  } catch (e) { warn(`[${L}] axe did not run: ${e.message.slice(0, 80)}`); }
  if (wantShots) {
    fs.mkdirSync(OUT, { recursive: true });
    const name = `screen-${sc.name}-${width}-${theme}.png`;
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(OUT, name), fullPage: true });
    shotResults.push(name);
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
  for (const fx of FIXTURES.filter((f) => !process.env.UG_ONLY || process.env.UG_ONLY.split(",").includes(f.name))) for (const theme of THEMES) for (const w of WIDTHS) await runPage(browser, fx, theme, w);
  for (const sc of SCREENS) for (const theme of THEMES) for (const w of WIDTHS) await runScreen(browser, sc, theme, w);
  await browser.close(); server.close();

  if (updateBaseline) { fs.writeFileSync(BASE_FILE, JSON.stringify({ tapSmall: totals.tapSmall, fontSmall: totals.fontSmall, axe: totals.axe }, null, 2) + "\n"); console.log("baseline written", totals); }
  else if (baseline) {
    if (totals.tapSmall > baseline.tapSmall) warn(`tap targets under 40px: ${totals.tapSmall} (baseline ${baseline.tapSmall})`);
    if (totals.fontSmall > baseline.fontSmall) warn(`text under 12px: ${totals.fontSmall} (baseline ${baseline.fontSmall})`);
    for (const [id, n] of Object.entries(totals.axe)) if (n > ((baseline.axe || {})[id] || 0)) warn(`axe "${id}": ${n} nodes (baseline ${(baseline.axe || {})[id] || 0})`);
  } else warn("ui-guardian-baseline.json is missing; run with --update-baseline");

  const diffs = compareShots();
  for (const d of diffs) warn(`screenshot: ${d}`);

  const md = ["### UI guardian: browser checks", "", `Screens checked: ${FIXTURES.length} car fixtures x the tabs each one shows, and ${SCREENS.length} other screens, x ${WIDTHS.length} widths x ${THEMES.length} themes`, "",
    `**Blocking problems: ${errors.length}** | warnings: ${warnings.length}`, "",
    ...(errors.length ? ["#### Blocking", ...[...new Set(errors)].slice(0, 30).map((e) => `- ${e}`), ""] : []),
    ...(warnings.length ? ["#### Warnings", ...[...new Set(warnings)].slice(0, 30).map((e) => `- ${e}`), ""] : []),
    `Tap targets under 40px: ${totals.tapSmall}; text under 12px: ${totals.fontSmall}; axe: ${Object.entries(totals.axe).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`].join("\n");
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  process.exit(errors.length ? 1 : 0);
})();
