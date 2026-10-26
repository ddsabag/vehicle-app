// The real app on an Android emulator: the release build of this commit (build type qa: the same shrinking and minified page as the
// Play build, debuggable so its WebView can be driven, debug-signed), opened the way people open it and walked like ui-flows.cjs walks
// the page, with ui-flows' fixtures, journeys and rules. What only the phone shows:
//   - the phone's font size (the WebView's text zoom follows it, 100% to 200%) and display size (411, 360, 320 dp wide), turned on its side
//   - the system bars: the page sits between them and the bars match it, light and dark, with their icons visible
//   - the keyboard: the plate field and its button stay in view above it
//   - Back (key or gesture) through the screens, and at home the app goes to the background instead of closing
//   - a dark phone: no white flash while the app opens, and "לפי המכשיר" follows the phone
//   - the ways in from outside the page: a launcher shortcut, a tapped alert (warm and cold), a shared text, a luchit.app link
// The registry is mocked (example plates only), every other address outside the app is cut, as in the browser runs.
// Blocking (exit 1): page errors, a step on the wrong screen, sideways scroll, anything past the screen edge, the bottom bar moving or
// growing, a way in that does not reach its screen, the page under a system bar, invisible bar icons, "לפי המכשיר" against the phone.
// Usage (inside the emulator, app-guardian.yml): node .github/scripts/app-real.cjs --apk <apk> [--out <dir>] [--quick] [--label <api>]
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
const { _android: android } = require("playwright");
const { PNG } = require("pngjs");
const UF = require("./ui-flows.cjs");
const { add, findings } = UF;

const args = process.argv.slice(2), arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const OUT = path.resolve(arg("--out") || "app-real"), APK = arg("--apk"), QUICK = args.includes("--quick"), LABEL = arg("--label") || "a";
fs.mkdirSync(path.join(OUT, "shots"), { recursive: true });
const PKG = "com.ddsabag.pratirechev", ACT = `${PKG}/.MainActivity`;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const adb = (a, opt = {}) => spawnSync("adb", a, { maxBuffer: 256 << 20, timeout: opt.timeout || 60000, encoding: opt.raw ? null : "utf8" }).stdout || (opt.raw ? Buffer.alloc(0) : "");
const sh = (cmd) => String(adb(["shell", cmd])).trim();
const log = (...a) => console.log(`[${LABEL}]`, ...a);
const meta = { label: LABEL, scenarios: [] };

// ---- the phone: display size, font size, dark mode, rotation
const W_PX = 1080;   // pixel_6 profile: 1080 x 2400 px
const DENSITY = { 411: 420, 360: 480, 320: 540 };
function setPhone({ dp = 411, font = 1, night = false, land = false }) {
  sh(`wm density ${DENSITY[dp]}`);
  sh(`settings put system font_scale ${font}`);
  sh(`cmd uimode night ${night ? "yes" : "no"}`);
  sh("settings put system accelerometer_rotation 0");
  sh(`settings put system user_rotation ${land ? 1 : 0}`);
}

// ---- the app: start it, find its WebView, mock the network there
let device = null;
const pidOf = () => sh(`pidof ${PKG}`).split(/\s+/)[0] || "";
async function attach(timeout = 30000) {
  const t0 = Date.now();
  for (;;) {
    const pid = pidOf();
    const wv = device.webViews().find((w) => w.pkg() === PKG && String(w.pid()) === pid);
    if (wv) {
      const page = await wv.page();
      page.on("pageerror", (e) => add("block", "error", cur.run, cur.step, "page error: " + e.message.slice(0, 160)));
      page.on("dialog", (d) => d.dismiss().catch(() => {}));
      try { await page.route(/^https?:\/\/(?!appassets\.androidplatform\.net\/)/, (r) => (/data\.gov\.il/.test(r.request().url()) && !net.offline ? UF.govRoute(r, net.gov) : r.abort("internetdisconnected"))); }
      catch (e) { add("block", "launch", cur.run, cur.step, "the registry could not be mocked in the WebView: " + e.message.split("\n")[0].slice(0, 120)); }
      return page;
    }
    if (Date.now() - t0 > timeout) throw new Error(`no inspectable WebView of ${PKG} (pid ${pid || "none"}) after ${timeout / 1000} s`);
    await sleep(400);
  }
}
const net = { gov: null, offline: false };
const READY = "#homeMark, #chead .mini-plate, #carsHead, #alertsHead";
async function launch({ clear = false, extra = "" } = {}) {
  sh(`am force-stop ${PKG}`);
  if (clear) { sh(`pm clear ${PKG}`); sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`); }
  sh(`am start -W -n ${ACT} ${extra}`);
  const page = await attach();
  await page.waitForSelector(READY, { state: "attached", timeout: 20000 });
  return page;
}
// a data state (no cars / one / many / an owner's car) and a theme, then the page loaded again with them
async function prepare(page, state, theme) {
  await page.evaluate(({ ls }) => { localStorage.clear(); for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v); }, { ls: { analyticsOff: "1", theme, ...UF.STATES[state] } });
  await page.evaluate(() => location.replace(location.pathname));
  await page.waitForSelector("#homeMark", { state: "attached", timeout: 20000 });
  await page.addStyleTag({ content: "*{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}" });
}

// ---- what the screen shows: a screenshot, the WebView's place on it, the colours of the bars
function screencap() { const buf = adb(["exec-out", "screencap", "-p"], { raw: true }); try { return PNG.sync.read(buf); } catch { return null; } }
function webViewBox() {
  let x = "";
  for (let i = 0; i < 3 && !/WebView/.test(x); i++) { sh("rm -f /sdcard/ui.xml; uiautomator dump /sdcard/ui.xml >/dev/null 2>&1"); x = sh("cat /sdcard/ui.xml 2>/dev/null"); }
  const m = x.match(/class="android\.webkit\.WebView"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) || x.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*?class="android\.webkit\.WebView"/);
  return m ? { l: +m[1], t: +m[2], r: +m[3], b: +m[4] } : null;
}
const px = (png, x, y) => { const i = (png.width * y + x) << 2; return [png.data[i], png.data[i + 1], png.data[i + 2]]; };
const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// the most common colour of a band of rows (the background, not the icons on it), and how much of it differs strongly (the icons)
function band(png, y0, y1) {
  const hist = new Map(), all = [];
  for (let y = Math.max(0, y0); y < Math.min(png.height, y1); y += 2) for (let x = 0; x < png.width; x += 3) { const c = px(png, x, y); all.push(c); const k = c.join(","); hist.set(k, (hist.get(k) || 0) + 1); }
  if (!all.length) return null;
  const bg = [...hist.entries()].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
  return { bg, marks: all.filter((c) => dist(c, bg) > 90).length / all.length };
}
// half-size copy for the report (a full screenshot is 1080 x 2400)
function saveShot(png, name) {
  if (!png) return;
  const w = png.width >> 1, h = png.height >> 1, o = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (png.width * (y << 1) + (x << 1)) << 2, j = (w * y + x) << 2; o.data[j] = png.data[i]; o.data[j + 1] = png.data[i + 1]; o.data[j + 2] = png.data[i + 2]; o.data[j + 3] = 255; }
  fs.writeFileSync(path.join(OUT, "shots", name.replace(/[^\w.-]+/g, "_") + ".png"), PNG.sync.write(o));
}
// the page between the bars, the bars painted like the page next to them, and their icons visible
function judgeBars(run, step, png, box, dark) {
  if (!png || !box) { add("warn", "bars", run, step, "could not read the screen or the WebView's place on it"); return; }
  const top = band(png, 0, box.t), bottom = band(png, box.b, png.height);
  const pageTop = band(png, box.t + 1, box.t + 6), pageBottom = band(png, box.b - 6, box.b - 1);
  if (box.t < 40) add("block", "bars", run, step, `the page starts ${box.t}px from the top of the screen, under the status bar`);
  if (top && top.marks < 0.002) add("block", "bars", run, step, `the status bar's icons cannot be seen (bar ${top.bg.join(",")})`);
  if (top && pageTop && dist(top.bg, pageTop.bg) > 24) add("warn", "bars", run, step, `the status bar (${top.bg.join(",")}) does not match the top of the page (${pageTop.bg.join(",")})${dark ? " in dark" : ""}`);
  if (bottom && png.height - box.b > 8 && pageBottom && dist(bottom.bg, pageBottom.bg) > 24) add("warn", "bars", run, step, `the navigation bar (${bottom.bg.join(",")}) does not match the bottom of the page (${pageBottom.bg.join(",")})${dark ? " in dark" : ""}`);
}

// ---- one journey of ui-flows on the phone
const cur = { run: "-", step: "-" };
const realBack = async (p) => { sh("input keyevent 4"); await sleep(700); };
const shotOnce = new Set();
async function journey(page, sc, state, J, theme) {
  const run = `${J.name}/${state}/${sc.id}/${theme}`;
  cur.run = run; cur.step = "load";
  try { await prepare(page, state, theme); } catch (e) { add("block", "logic", run, "load", "could not load the state: " + e.message.split("\n")[0].slice(0, 120)); return; }
  const c = { dev: { id: sc.id, w: sc.dp, h: 860 }, theme, state, app: true, ctx: null, net, page, plate: state === "many" ? "7654321" : "1234567", back: realBack };
  const seen = []; let prev = null;
  for (const [name, act, expect] of J.steps) {
    cur.step = name;
    if (act) { try { await act(page, c); } catch (e) { add("block", "logic", run, name, "could not act: " + e.message.split("\n")[0].slice(0, 120)); } }
    await sleep(500);
    let m; try { m = await UF.measure(page); } catch (e) { add("block", "error", run, name, "measure failed: " + e.message.slice(0, 100)); continue; }
    let ok = expect ? await expect(m, c) : true;
    if (ok && ok.warn) { add("warn", "logic", run, name, ok.warn); ok = true; }
    if (ok !== true) add("block", "logic", run, name, ok);
    UF.judgeStep(run, name, m, { app: true, barMax: Math.round(80 * Math.max(1, sc.font)) });
    if (ok === true && act === UF.back && prev && ["screen", "sheet", "url", "carPlate", "msg", "tab"].every((k) => prev[k] === m[k]) && !(m.screen === "home" && m.home)) add("block", "logic", run, name, `Back did nothing on ${m.screen} (a dead press)`);
    prev = m;
    seen.push({ step: name, screen: m.screen, sheet: m.sheet, nav: m.nav, col: m.col, title: m.title, y: m.y, vw: m.vw });
    // each screen once per phone setting: a screenshot, and the bars checked against the page
    const key = `${sc.id}/${theme}/${m.screen}/${m.sheet || ""}`;
    if (!shotOnce.has(key)) {
      shotOnce.add(key);
      const png = screencap(), box = webViewBox();
      judgeBars(run, name, png, box, theme === "dark");
      saveShot(png, `${sc.id}__${theme}__${m.screen}${m.sheet ? "-" + m.sheet : ""}__${J.name}-${name}`);
    }
  }
  UF.judgeRun(run, seen, sc.dp);
}

// ---- the text zoom the phone's font size gives the page (a 16px line measured)
const zoomOf = (page) => page.evaluate(() => { const s = document.createElement("span"); s.style.cssText = "font:16px/1 sans-serif;position:absolute;visibility:hidden"; s.textContent = "אבג"; document.body.appendChild(s); const h = s.getBoundingClientRect().height; s.remove(); return Math.round((h / 16) * 100) / 100; });

// ---- the ways in from outside the page, with the app already open (warm) and from a cold start
const screenOf = (page) => page.evaluate(() => ({ screen: document.body.dataset.screen, sheet: [...document.querySelectorAll(".sheet:not([hidden]), #compareSheet:not([hidden])")].map((e) => e.id || e.className).join(","), car: ((document.querySelector("#chead .mini-plate") || {}).textContent || "").replace(/\D/g, ""), tab: typeof currentTab !== "undefined" ? currentTab : null, url: location.search + location.hash }));
async function waitFor(page, ok, ms = 12000) { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await screenOf(page).catch(() => null); if (s && ok(s)) return s; await sleep(400); } return s; }
async function entries(page, sc) {
  const run = `entries/one/${sc.id}/light`; cur.run = run;
  await prepare(page, "one", "light");
  const warm = async (name, extra, ok, want) => {
    cur.step = name;
    sh(`am start -n ${ACT} ${extra}`);
    const s = await waitFor(page, ok);
    if (!s || !ok(s)) add("block", "entry", run, name, `${want}; got ${s ? `${s.screen} ${s.sheet} car ${s.car || "-"} tab ${s.tab}` : "no page"}`);
    const png = screencap(); saveShot(png, `${sc.id}__entry__${name}`);
    await page.evaluate(() => { for (const b of document.querySelectorAll("#compareSheet:not([hidden]) [data-act=closeCompare], #closeCompare")) b.click(); }).catch(() => {});
    await page.click('#bnav [data-nav="search"]').catch(() => {});
    await sleep(400);
  };
  const flags = "-f 0x24000000";   // CLEAR_TOP | SINGLE_TOP, as the alert's own intent
  await warm("shortcut-saved", "-a android.intent.action.VIEW -d luchit://saved", (s) => s.screen === "cars", "the launcher shortcut הרכבים שלי should open הרכבים שלי");
  await warm("shortcut-compare", "-a android.intent.action.VIEW -d luchit://compare", (s) => /compare/i.test(s.sheet) || s.screen === "sub", "the launcher shortcut השוואה should open the comparison");
  await warm("alert-recall", `${flags} -d luchit://plate/1234567 --es plate 1234567 --es nkind recall`, (s) => s.screen === "car" && s.car === "1234567" && s.tab === "recalls", "a tapped recall alert should open the car on its recalls tab");
  await warm("alert-test", `${flags} -d luchit://plate/7654321 --es plate 7654321 --es nkind test`, (s) => s.screen === "car" && s.car === "7654321" && s.tab === "file", "a tapped test alert should open the car in its file");
  await warm("share-text", `-a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT 'למכירה טויוטה קורולה 2021 מספר רכב 12-345-67'`, (s) => s.screen === "car" && s.car === "1234567", "an ad shared into the app should check its plate");
  await warm("app-link", `-a android.intent.action.VIEW -d 'https://luchit.app/?plate=7654321&s=wa'`, (s) => s.screen === "car" && s.car === "7654321", "a luchit.app link with a plate should open that car");
  await warm("campaign-link", `-a android.intent.action.VIEW -d 'https://luchit.app/?utm_source=facebook&utm_campaign=market'`, (s) => s.screen === "home", "a campaign link should open the home screen");
  // cold: the page is not running yet, so the registry is not mocked when it starts; the address it was given and the tab it keeps
  // for the car are what the app is responsible for
  cur.step = "alert-cold";
  sh(`am force-stop ${PKG}`);
  sh(`am start -W -n ${ACT} -d luchit://plate/1234567 --es plate 1234567 --es nkind recall`);
  const p2 = await attach();
  const s = await p2.evaluate(() => ({ url: location.search + location.hash, tab: typeof openTab !== "undefined" && openTab ? openTab.t : null })).catch(() => null);
  if (!s || !/nk=recall/.test(s.url) || !/#1234567/.test(s.url) || s.tab !== "recalls") add("block", "entry", run, "alert-cold", `a recall alert tapped with the app closed should open index.html?nk=recall#1234567 with the recalls tab kept; got ${JSON.stringify(s)}`);
  return p2;
}

// ---- Back at home, the keyboard, a turn on its side
async function phoneChecks(page, sc) {
  const run = `phone/one/${sc.id}/light`; cur.run = run;
  await prepare(page, "one", "light");
  // the keyboard: tap the plate field like a finger, the field and its button must stay above the keyboard
  cur.step = "keyboard";
  sh("settings put secure show_ime_with_hard_keyboard 1");
  const box = webViewBox(), r = await page.evaluate(() => { const e = document.getElementById("plate").getBoundingClientRect(); return { x: e.left + e.width / 2, y: e.top + e.height / 2, h: innerHeight, dpr: devicePixelRatio }; });
  if (box) { sh(`input tap ${Math.round(box.l + r.x * r.dpr)} ${Math.round(box.t + r.y * r.dpr)}`); await sleep(1500); }
  const k = await page.evaluate(() => { const v = (id) => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; }; const nav = document.getElementById("bnav"); return { h: innerHeight, plate: v("plate"), go: v("go"), focus: document.activeElement && document.activeElement.id, nav: nav ? Math.round(nav.getBoundingClientRect().top) : null }; });
  const kbUp = k.h < r.h - 100;
  if (!kbUp) add("warn", "keyboard", run, "keyboard", `the keyboard did not open over the plate field (page height ${r.h} → ${k.h}, focus ${k.focus})`);
  else {
    if (!k.plate || k.plate.bottom > k.h) add("block", "keyboard", run, "keyboard", `the plate field is under the keyboard (field bottom ${k.plate && k.plate.bottom}, visible height ${k.h})`);
    if (!k.go || k.go.bottom > k.h) add("block", "keyboard", run, "keyboard", `the check button is under the keyboard (button bottom ${k.go && k.go.bottom}, visible height ${k.h})`);
    if (k.nav !== null && k.plate && k.nav < k.plate.bottom) add("block", "keyboard", run, "keyboard", "the bottom bar rides up over the plate field with the keyboard open");
  }
  saveShot(screencap(), `${sc.id}__keyboard`);
  meta.keyboard = { before: r.h, after: k.h };
  sh("input keyevent 4"); await sleep(800);   // the first Back only closes the keyboard
  // Back at home: the app goes to the background (Android 12 and later keep it warm), it is not finished
  cur.step = "back-home";
  await page.click('#bnav [data-nav="search"]').catch(() => {});
  await page.evaluate(() => { window.__warm = 1; });
  sh("input keyevent 4"); await sleep(1500);
  const acts = sh(`dumpsys activity activities | grep -E "ActivityRecord.*${PKG}"`);
  meta.backAtHome = acts ? "kept" : "finished";
  sh(`am start -n ${ACT}`); await sleep(1500);
  let p2 = page, warm = false;
  try { warm = await page.evaluate(() => window.__warm === 1); } catch { p2 = await attach(); }
  if (!warm) add("warn", "back", run, "back-home", "Back on the home screen closes the app: the next open starts from scratch (Android 12 and later leave an app in the background)");
  // turned on its side
  cur.step = "landscape";
  setPhone({ dp: sc.dp, font: sc.font, night: false, land: true }); await sleep(2000);
  p2 = await attach().catch(() => p2);
  await p2.waitForSelector(READY, { state: "attached", timeout: 15000 }).catch(() => {});
  try { const m = await UF.measure(p2); UF.judgeStep(run, "landscape", m, { app: true, barMax: 80 }); } catch (e) { add("warn", "logic", run, "landscape", "could not measure on its side: " + e.message.slice(0, 80)); }
  saveShot(screencap(), `${sc.id}__landscape`);
  setPhone({ dp: sc.dp, font: sc.font, night: false, land: false }); await sleep(1500);
  return attach().catch(() => p2);
}

// ---- a dark phone: the theme "לפי המכשיר" follows it, and the app does not flash white while it opens
async function darkChecks(sc) {
  const run = `dark/one/${sc.id}/auto`; cur.run = run;
  for (const night of [false, true]) {
    cur.step = night ? "auto-dark" : "auto-light";
    setPhone({ dp: sc.dp, font: 1, night });
    let page = await launch();
    await prepare(page, "one", "auto");
    const d = await page.evaluate(() => ({ mq: matchMedia("(prefers-color-scheme: dark)").matches, bg: getComputedStyle(document.body).backgroundColor }));
    const bgDark = (() => { const m = d.bg.match(/\d+/g) || [255, 255, 255]; return lum(m.slice(0, 3).map(Number)) < 0.4; })();
    if (d.mq !== night || bgDark !== night) add("block", "theme", run, cur.step, `with "לפי המכשיר" and the phone ${night ? "dark" : "light"}, the page is ${bgDark ? "dark" : "light"} (prefers-color-scheme: ${d.mq ? "dark" : "light"})`);
    const png = screencap(); judgeBars(run, cur.step, png, webViewBox(), night); saveShot(png, `${sc.id}__auto-${night ? "dark" : "light"}`);
  }
  // the opening frames of a dark phone with the dark theme chosen
  cur.step = "launch-dark";
  let page = await launch();
  await prepare(page, "one", "dark");
  sh(`am force-stop ${PKG}`);
  spawnSync("adb", ["shell", `am start -n ${ACT}`]);
  const frames = [];
  for (let i = 0; i < 6; i++) { const png = screencap(); if (png) { const b = band(png, png.height * 0.3 | 0, png.height * 0.7 | 0); frames.push(b ? Math.round(lum(b.bg) * 100) / 100 : null); if (i === 1) saveShot(png, `${sc.id}__launch-dark-early`); } }
  meta.launchDark = frames;
  if (frames.some((l) => l !== null && l > 0.8)) add("warn", "flash", run, "launch-dark", `a dark phone sees a white screen while the app opens (brightness of the frames: ${frames.join(", ")})`);
  setPhone({ dp: sc.dp, font: 1, night: false });
}

// ---- the phone settings each run uses
const SCENARIOS = QUICK
  ? [{ id: "411-f100", dp: 411, font: 1, runs: [["tour", "many", "light"], ["check", "one", "light"]], extra: true }]
  : [
    { id: "411-f100", dp: 411, font: 1, extra: true, runs: [["tour", "empty", "light"], ["tour", "many", "light"], ["check", "one", "light"], ["plus", "one", "light"], ["plus-undo", "one", "light"], ["file-door", "one", "light"], ["saved", "many", "light"], ["compare", "one", "light"], ["tools", "one", "light"], ["owner", "owner", "light"], ["check", "many", "dark"]] },
    { id: "360-f130", dp: 360, font: 1.3, runs: [["tour", "many", "light"], ["check", "many", "light"], ["saved", "many", "light"], ["compare", "one", "light"]] },
    { id: "320-f130", dp: 320, font: 1.3, runs: [["tour", "one", "dark"], ["check", "one", "dark"], ["saved", "many", "dark"]] },
    { id: "411-f200", dp: 411, font: 2, runs: [["tour", "one", "light"], ["check", "one", "light"]] },
  ];

(async () => {
  const t0 = Date.now();
  if (APK) { const r = spawnSync("adb", ["install", "-r", "-g", APK], { encoding: "utf8" }); log("install:", (r.stdout || r.stderr || "").trim().split("\n").pop()); }
  [device] = await android.devices({ omitDriverInstall: true });
  if (!device) throw new Error("no Android device");
  meta.model = device.model(); meta.sdk = sh("getprop ro.build.version.sdk");
  sh("settings put global window_animation_scale 0"); sh("settings put global transition_animation_scale 0"); sh("settings put global animator_duration_scale 0");
  for (const sc of SCENARIOS) {
    const ts = Date.now();
    setPhone({ dp: sc.dp, font: sc.font });
    let page;
    try { page = await launch({ clear: true }); }
    catch (e) { add("block", "launch", `launch/-/${sc.id}/-`, "launch", e.message.slice(0, 200)); continue; }
    const z = await zoomOf(page).catch(() => null), ua = await page.evaluate(() => navigator.userAgent).catch(() => "");
    log(`${sc.id}: text zoom ${z}, ${ua.match(/Chrome\/[\d.]+/) || ua}`);
    for (const [name, state, theme] of sc.runs) {
      const J = UF.JOURNEYS.find((j) => j.name === name);
      try { await journey(page, sc, state, J, theme); } catch (e) { add("block", "error", `${name}/${state}/${sc.id}/${theme}`, cur.step, "run crashed: " + e.message.split("\n")[0].slice(0, 160)); page = await launch().catch(() => page); }
    }
    if (sc.extra) {
      try { page = await entries(page, sc); } catch (e) { add("block", "error", `entries/one/${sc.id}/light`, cur.step, "crashed: " + e.message.split("\n")[0].slice(0, 160)); page = await launch().catch(() => page); }
      try { page = await phoneChecks(page, sc); } catch (e) { add("block", "error", `phone/one/${sc.id}/light`, cur.step, "crashed: " + e.message.split("\n")[0].slice(0, 160)); }
      try { await darkChecks(sc); } catch (e) { add("block", "error", `dark/one/${sc.id}/auto`, cur.step, "crashed: " + e.message.split("\n")[0].slice(0, 160)); }
    }
    meta.scenarios.push({ id: sc.id, zoom: z, webview: (ua.match(/Chrome\/[\d.]+/) || [""])[0], seconds: Math.round((Date.now() - ts) / 1000) });
  }
  setPhone({ dp: 411, font: 1 });
  await device.close().catch(() => {});
  fs.writeFileSync(path.join(OUT, "findings.json"), JSON.stringify(findings, null, 1));
  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify(meta, null, 1));
  const groups = {};
  for (const f of findings) { const k = f.sev + "|" + f.kind + "|" + f.step + "|" + f.msg.replace(/\d+px|\d+\.\d+|[\d,]{6,}/g, "#"); (groups[k] = groups[k] || { ...f, n: 0, runs: [] }).n++; groups[k].runs.push(f.run); }
  const list = Object.values(groups).sort((a, b) => (a.sev === b.sev ? b.n - a.n : a.sev === "block" ? -1 : 1));
  for (const g of list) console.log(`${g.sev === "block" ? "::error::" : "::warning::"}(real app, API ${meta.sdk}) [${g.kind}] ${g.step}: ${g.msg} (${g.n}x, e.g. ${g.runs[0]})`);
  const blocks = findings.filter((f) => f.sev === "block").length;
  log(`real app on API ${meta.sdk}: ${SCENARIOS.reduce((n, s) => n + s.runs.length, 0)} journeys in ${Math.round((Date.now() - t0) / 1000)} s, ${blocks} blocking, ${findings.length - blocks} warnings, ${list.length} distinct`);
  process.exit(blocks ? 1 : 0);
})().catch((e) => { console.log(`::error::(real app) the run crashed: ${e.message}`); fs.writeFileSync(path.join(OUT, "findings.json"), JSON.stringify(findings, null, 1)); fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify(meta, null, 1)); process.exit(2); });
