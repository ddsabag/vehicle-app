// The real app on an Android emulator: the release build of this commit (build type qa: the same shrinking and minified page as the
// Play build, debuggable so its WebView can be driven, debug-signed), opened the way people open it and walked like ui-flows.cjs walks
// the page, with ui-flows' fixtures, journeys and rules. What only the phone shows:
//   - the phone's font size (the WebView's text zoom follows it, 100% to 200%) and display size (411, 360, 320 dp wide), turned on its side
//   - the system bars: the page sits between them and the bars match it, light and dark, with their icons visible
//   - the keyboard: the plate field and its button stay in view above it, the bottom bar steps aside, and returns when Back closes it
//   - Back (key or gesture) through the screens, and at home the app goes to the background instead of closing
//   - what is filled in stays: the "keeps" journey sends the app to the background, stops it as a swipe in the recent apps does, starts
//     it again and finds the nickname, the file, the policy's expiry, the settings and the alerts where they were put
//   - a dark phone: no white flash while the app opens, and "לפי המכשיר" follows the phone, also when it turns dark with the app open
//   - the ways in from outside the page: a launcher shortcut, a tapped alert (warm, and cold without a network), a shared text, a
//     luchit.app link to a car or a comparison
// The registry is mocked (example plates only), every other address outside the app is cut, as in the browser runs.
// Blocking (exit 1): the app crashing, or not responding in both tries of a journey, page errors, a step on the wrong screen, sideways
// scroll, anything past the screen edge, the bottom bar moving or growing or riding on the keyboard, a way in that does not reach its
// screen, the page under a system bar, invisible bar icons, "לפי המכשיר" against the phone. A journey the phone disturbed (another app's
// "isn't responding" dialog, the app not responding, its page closed under it, the system's bars restarting, the window changing height
// with no keyboard) runs once more on a fresh start, and only that try counts; so does the first start of each phone setting.
// The emulator itself stopping is not the app's fault: exit 2, with what was found until then, and a file "gone" beside the findings
// (app-guardian.yml then runs the phone setting once more on a new emulator); so is a journey disturbed in both tries by what is not the
// app's (no crash of the app, no ANR in its own code or without a stack).
// Usage (inside the emulator, app-guardian.yml): node .github/scripts/app-real.cjs --apk <apk> [--out <dir>] [--scenario <id>] [--quick] [--label <api>]
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
const { _android: android } = require("playwright");
const { PNG } = require("pngjs");
const UF = require("./ui-flows.cjs");
const { add, findings } = UF;

const args = process.argv.slice(2), arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const OUT = path.resolve(arg("--out") || "app-real"), APK = arg("--apk"), QUICK = args.includes("--quick"), LABEL = arg("--label") || "a", ONLY = arg("--scenario");
fs.mkdirSync(path.join(OUT, "shots"), { recursive: true });
const PKG = "com.ddsabag.pratirechev", ACT = `${PKG}/.MainActivity`;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const adb = (a, opt = {}) => spawnSync("adb", a, { maxBuffer: 256 << 20, timeout: opt.timeout || 60000, encoding: opt.raw ? null : "utf8" }).stdout || (opt.raw ? Buffer.alloc(0) : "");
const sh = (cmd) => String(adb(["shell", cmd])).trim();
const log = (...a) => console.log(`[${LABEL}]`, ...a);
const meta = { label: LABEL, scenarios: [] };
const cur = { run: "-", step: "-" };

// ---- the emulator: still there? When it is gone every adb call answers nothing, which would read as a pile of app failures
class Gone extends Error {}
const alive = () => /^device/.test(String(adb(["get-state"], { timeout: 15000 })).trim());
const mustLive = () => { if (!alive()) throw new Gone(`the emulator stopped during ${cur.run} ${cur.step}`); };

// ---- the phone: display size, font size, dark mode, rotation
const DENSITY = { 411: 420, 360: 480, 320: 540 };   // pixel_6 profile: 1080 x 2400 px
let boxCache = null;   // the WebView's place on the screen, read once per phone setting (uiautomator is slow and heavy)
function setPhone({ dp = 411, font = 1, night = false, land = false }) {
  sh(`wm density ${DENSITY[dp]}`);
  sh(`settings put system font_scale ${font}`);
  sh(`cmd uimode night ${night ? "yes" : "no"}`);
  sh("settings put system accelerometer_rotation 0");
  sh(`settings put system user_rotation ${land ? 1 : 0}`);
  boxCache = null;
}
// the network off: nothing leaves the emulator while a page starts before its requests can be mocked (a cold start)
const network = (on) => { sh(`svc wifi ${on ? "enable" : "disable"}`); sh(`svc data ${on ? "enable" : "disable"}`); };

// ---- the connection to the phone
// Playwright's Android connection gives its sockets no error handler: a write that meets a closed WebView (the app stopped or crashed
// while its page was connected) fails with EPIPE and would end the whole run. The page is gone then, which the next step reports, and
// the run goes on with a new connection. When a poll of the phone fails, Playwright closes the device: it is connected again.
let device = null, deviceClosed = true;
async function connect() {
  [device] = await android.devices({ omitDriverInstall: true });
  if (!device) throw new Gone("no Android device");
  deviceClosed = false;
  device.on("close", () => { deviceClosed = true; log("the connection to the phone closed"); });
}
async function reconnect() { await device.close().catch(() => {}); deviceClosed = true; await connect(); }
process.on("uncaughtException", (e) => {
  if (e && ["EPIPE", "ECONNRESET"].includes(e.code)) { meta.drops = (meta.drops || 0) + 1; log(`a connection to the phone dropped (${e.code}) during ${cur.run} ${cur.step}`); return; }
  finish(`::error::(real app) the run crashed: ${(e && e.stack) || e}`, 2);
});

// ---- crashes: the app's own (a Java exception) and not responding (ANR), from the phone's log; the stack goes to crash-N.txt / anr-N.txt.
// The system's "isn't responding" dialog is switched off (hide_error_dialogs): it would cover every later step. An ANR keeps its reason and
// its main thread's stack (dropbox, no root needed): the app's own code on that stack is the app's fault (blocking); a main thread that
// was idle or waiting on the WebView's drawing is the emulator's software rendering falling behind, which a phone's GPU does not
// (warning, with the stack kept). Google Play's vitals count the ANRs of real phones
let crashN = 0, anrN = 0, anrRead = 0, lastAnr = null;
// a journey the phone disturbed, and how: "anr" (the app's, lastAnr says where its main thread was), "closed" (the app's page closed
// under the journey), "dialog <app>" (another app's "isn't responding"), "systemui" (the process that draws the system's bars started
// again under the journey), "resized" (the window grew or shrank with no keyboard and no turn: the bars went away or came back). Read by
// the main loop: the journey runs once more
const disturbed = new Set();
const SAY = { anr: "the app stopped responding", closed: "the app's page closed", systemui: "the system's bars started again", resized: "the window changed height with no keyboard" };
const disturbedSay = () => [...disturbed].map((w) => SAY[w] || `${w.slice(7)} was not responding`).join(", ");
// the dropbox entry is written once the system has dumped the threads' stacks, which on the emulator comes many seconds after the ANR is
// logged (26.10, API 31: none yet 15 s after it); so it is waited for, up to 30 s, and only an entry newer than the last one read counts
function anrDetails() {
  let all = [];
  for (let i = 0; i < 12; i++) {
    const box = String(adb(["shell", "dumpsys dropbox --print data_app_anr"], { timeout: 30000 }));
    all = box.split(/^={20,}$/m).filter((e) => e.includes(`Process: ${PKG}`));
    if (all.length > anrRead) break;
    spawnSync("sleep", ["2.5"]);
  }
  const mine = all.length > anrRead ? all[all.length - 1] : "";
  anrRead = Math.max(anrRead, all.length);
  const subject = ((mine.match(/^Subject: (.+)$/m) || [])[1] || "").trim();
  const at = mine.indexOf('"main" prio='), mainStack = at < 0 ? "" : mine.slice(at, mine.indexOf("\n\n", at) < 0 ? undefined : mine.indexOf("\n\n", at));
  return { mine, subject, mainStack, ours: /\bat com\.ddsabag\.pratirechev\./.test(mainStack), idle: /nativePollOnce/.test(mainStack.split("\n").slice(0, 6).join("\n")) };
}
// inJourney: an ANR in a journey is a warning on the first try, which runs again (see the main loop); in both tries it is blocking.
// Elsewhere (the ways in, the phone checks, the dark launch) nothing runs again, and an ANR in the app's own code or without a stack blocks
function crashes(run, step, inJourney = false) {
  const t = sh("logcat -b crash -d -v brief"), anr = sh("logcat -b events -d -s am_anr");
  if (t || anr) sh("logcat -b crash -b events -c");
  for (const m of t.matchAll(/\(\s*(\d+)\): Process: ([\w.]+), PID/g)) {
    if (m[2] !== PKG) continue;
    const lines = t.split("\n").filter((l) => new RegExp(`\\(\\s*${m[1]}\\):`).test(l)).map((l) => l.replace(/^[^:]+:\s?/, ""));
    const why = lines[lines.findIndex((l) => l.startsWith("Process:")) + 1] || "?";
    crashN++; fs.writeFileSync(path.join(OUT, `crash-${crashN}.txt`), lines.join("\n") + "\n");
    add("block", "crash", run, step, `the app crashed: ${why.trim().slice(0, 160)} (crash-${crashN}.txt)`);
    log(`CRASH at ${run} ${step}: ${why.trim().slice(0, 200)}`);
  }
  if (anr.includes(PKG)) {
    const d = anrDetails();
    anrN++; fs.writeFileSync(path.join(OUT, `anr-${anrN}.txt`), `${anr}\n\n${d.mine || "(no dropbox entry)"}\n`);
    const why = d.subject ? `: ${d.subject.slice(0, 120)}` : "", where = d.ours ? "in the app's own code" : !d.mainStack ? "no stack was written" : d.idle ? "its main thread was idle" : "its main thread was outside the app's code";
    lastAnr = { ours: d.ours, stack: !!d.mainStack, file: `anr-${anrN}.txt` };
    if (inJourney) { disturbed.add("anr"); add("warn", "anr", run, step, `the app stopped responding (ANR)${why}; ${where} (anr-${anrN}.txt). The journey runs again: an ANR in both tries is blocking`); }
    else if (d.ours || !d.mainStack) add("block", "crash", run, step, `the app stopped responding (ANR)${why}${d.ours ? ", in the app's own code" : ""} (anr-${anrN}.txt)`);
    else add("warn", "crash", run, step, `the app stopped responding for a moment (ANR)${why}; its main thread was ${d.idle ? "idle" : "outside the app's code"}: the emulator's software rendering, not the app (anr-${anrN}.txt)`);
    log(`ANR at ${run} ${step}${why} (${where})`);
  }
}

// ---- another app's "isn't responding" or "has stopped" dialog: under software rendering the emulator's own launcher can fall behind,
// and Android puts its dialog over the app (seen on API 35: "Pixel Launcher isn't responding"), where it takes every Back and covers the
// screenshots. It is not the app's: that app is stopped (the dialog goes with it) and the run goes on. A dialog of System UI or of the app
// itself is answered "Wait"; the app's own ANRs and crashes are still read from the phone's log (crashes()), never closed away unseen
function clearDialogs() {
  const m = sh("dumpsys window | grep -m1 mCurrentFocus").match(/Application (?:Not Responding|Error): ([\w.]+)/);
  if (!m) return false;
  const who = m[1];
  let how = "";
  if (who !== PKG) disturbed.add(`dialog ${who}`);   // the app's own is an ANR, read from the phone's log
  if (who !== PKG && !/systemui/.test(who)) { sh(`am force-stop ${who}`); how = "that app stopped"; }
  else {
    sh("rm -f /sdcard/ui.xml"); adb(["shell", "uiautomator dump /sdcard/ui.xml >/dev/null 2>&1"], { timeout: 25000 });
    const b = sh("cat /sdcard/ui.xml 2>/dev/null").match(/resource-id="android:id\/aerr_wait"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (b) { sh(`input tap ${(+b[1] + +b[3]) >> 1} ${(+b[2] + +b[4]) >> 1}`); how = "Wait"; } else how = "nothing (no Wait button found)";
  }
  (meta.dialogs = meta.dialogs || []).push(`${who} during ${cur.run} ${cur.step}`);
  log(`a system dialog covered the screen (${m[0]}): ${how}`);
  spawnSync("sleep", ["0.8"]);
  return true;
}

// ---- the app: start it, find its page, mock the network there
const net = { gov: null, offline: false };
const routed = new WeakSet(), hooked = new WeakSet();
const pidOf = () => sh(`pidof ${PKG}`).split(/\s+/)[0] || "";
const sysUiPid = () => sh("pidof com.android.systemui").split(/\s+/)[0] || "";
const front = () => !!sh(`dumpsys activity activities | grep -E "(mResumedActivity|topResumedActivity).*${PKG}"`);
// the page the phone shows: after the activity was finished and started again in the same process, the old page can still be listed
async function visiblePage(ctx) {
  for (let i = 0; i < 24; i++) {
    for (const p of ctx.pages().slice().reverse()) { if (!p.isClosed() && (await p.evaluate(() => document.visibilityState).catch(() => null)) === "visible") return p; }
    await sleep(250);
  }
  return ctx.pages().filter((p) => !p.isClosed()).pop() || null;
}
async function attach(timeout = 30000) {
  const t0 = Date.now();
  let fresh = false;
  for (;;) {
    mustLive();
    if (deviceClosed) await connect();
    const pid = pidOf();
    const wv = pid && device.webViews().find((w) => w.pkg() === PKG && String(w.pid()) === pid);
    if (wv) {
      const ctx = (await wv.page()).context();
      if (!routed.has(ctx)) {
        routed.add(ctx);
        try { await ctx.route(/^https?:\/\/(?!appassets\.androidplatform\.net\/)/, (r) => (/data\.gov\.il/.test(r.request().url()) && !net.offline ? UF.govRoute(r, net.gov) : r.abort("internetdisconnected"))); }
        catch (e) { add("block", "launch", cur.run, cur.step, "the registry could not be mocked in the WebView: " + e.message.split("\n")[0].slice(0, 120)); }
      }
      const page = await visiblePage(ctx);
      if (page) {
        if (!hooked.has(page)) {
          hooked.add(page);
          page.on("pageerror", (e) => add("block", "error", cur.run, cur.step, "page error: " + e.message.slice(0, 160)));
          page.on("crash", () => add("block", "crash", cur.run, cur.step, "the page's renderer crashed (the WebView showed nothing until the app reloaded it)"));
          page.on("dialog", (d) => d.dismiss().catch(() => {}));
        }
        return page;
      }
      // every page of this connection is closed (the connection itself dropped): connect to the phone again
      if (!fresh) { fresh = true; await reconnect(); continue; }
    }
    if (Date.now() - t0 > timeout) throw new Error(`no inspectable WebView of ${PKG} (pid ${pid || "none"}) after ${timeout / 1000} s`);
    // the app runs but its WebView is not seen: Playwright's list may be stale, so connect to the phone once more
    if (!fresh && pid && Date.now() - t0 > timeout / 3) { fresh = true; await reconnect(); }
    await sleep(400);
  }
}
const READY = "#homeMark, #chead .mini-plate, #carsHead, #alertsHead";
async function launch({ clear = false, extra = "" } = {}) {
  const t0 = Date.now();
  mustLive();
  sh(`am force-stop ${PKG}`);
  if (clear) { sh(`pm clear ${PKG}`); if (+meta.sdk >= 33) sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`); }
  sh(`am start -W -n ${ACT} ${extra}`);
  const page = await attach();
  await page.waitForSelector(READY, { state: "attached", timeout: 20000 });
  if (!boxCache) await settleBox();   // the first start of a phone setting: the journeys begin once the WebView holds still
  log(`launched${clear ? " (fresh install state)" : ""}, pid ${pidOf()}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
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
// the view tree of the activity on top (dumpsys activity top): each view's left,top-right,bottom is relative to its parent
function webViewBoxFromTree() {
  const t = sh("dumpsys activity top"), i = t.lastIndexOf("View Hierarchy:");
  if (i < 0) return null;
  const stack = [];
  for (const l of t.slice(i).split("\n").slice(1)) {
    const m = l.match(/^(\s*)([\w.$]+)\{[^}]*?\s(-?\d+),(-?\d+)-(-?\d+),(-?\d+)/);
    if (!m) { if (/^\S/.test(l) || /^\s*Looper/.test(l)) break; continue; }
    const ind = m[1].length;
    while (stack.length && stack[stack.length - 1][0] >= ind) stack.pop();
    const [px, py] = stack.length ? stack[stack.length - 1].slice(1) : [0, 0];
    const box = { l: px + +m[3], t: py + +m[4], r: px + +m[5], b: py + +m[6] };
    if (/\.WebView$/.test(m[2])) return box.r > box.l && box.b > box.t ? box : null;
    stack.push([ind, box.l, box.t]);
  }
  return null;
}
function freshBox() {
  const tree = webViewBoxFromTree();
  if (tree) return tree;
  let x = "";
  for (let i = 0; i < 3 && !/WebView/.test(x); i++) { sh("rm -f /sdcard/ui.xml; uiautomator dump /sdcard/ui.xml >/dev/null 2>&1"); x = sh("cat /sdcard/ui.xml 2>/dev/null"); }
  const m = x.match(/class="android\.webkit\.WebView"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) || x.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*?class="android\.webkit\.WebView"/);
  return m ? { l: +m[1], t: +m[2], r: +m[3], b: +m[4] } : null;
}
function webViewBox() { return boxCache || (boxCache = freshBox()); }
// the WebView's place once it holds still. Right after boot, or a display or font size change, the system can still be laying out its
// bars: an app started then is laid out under the status bar first and moved down a moment later (on the emulator, API 31 at 200%: every
// look then read "under the status bar" and the navigation bar "moved"). Two reads a second apart that agree, with room for the status bar,
// are its place; after 8 s the last read stands, and a page that really starts under the bar is reported by the bars check
async function settleBox() {
  let last = null;
  for (let i = 0; i < 8; i++) {
    const b = freshBox();
    if (b && last && b.t === last.t && b.b === last.b && b.t >= 40) break;
    last = b; await sleep(1000);
  }
  if (last) boxCache = last;
  return last;
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
// first = true: nothing is reported yet when something is off, the caller looks again ("again"). Under the emulator's software rendering
// the screen can still show the WebView's previous frame while the bars already have the colours of the new one (a sheet opening), and
// the system redraws its bar after a font size change
function judgeBars(run, step, png, box, dark, first = false) {
  if (!png || !box) { if (first) return "again"; add("warn", "bars", run, step, "could not read the screen or the WebView's place on it"); return; }
  const top = band(png, 0, box.t), bottom = band(png, box.b, png.height);
  const pageTop = band(png, box.t + 1, box.t + 6), pageBottom = band(png, box.b - 6, box.b - 1), off = [];
  if (box.t < 40) off.push(["block", `the page starts ${box.t}px from the top of the screen, under the status bar`]);
  if (top && top.marks < 0.002) off.push(["block", `the status bar's icons cannot be seen (bar ${top.bg.join(",")})`]);
  if (top && pageTop && dist(top.bg, pageTop.bg) > 24) off.push(["warn", `the status bar (${top.bg.join(",")}) does not match the top of the page (${pageTop.bg.join(",")})${dark ? " in dark" : ""}`]);
  if (bottom && png.height - box.b > 8 && pageBottom && dist(bottom.bg, pageBottom.bg) > 24) off.push(["warn", `the navigation bar (${bottom.bg.join(",")}) does not match the bottom of the page (${pageBottom.bg.join(",")})${dark ? " in dark" : ""}`]);
  if (first && off.length) return "again";
  for (const [sev, msg] of off) add(sev, "bars", run, step, msg);
}
// a screenshot judged and kept: a first look that finds something off is taken again 1.5 s later, and only that one counts
async function look(run, step, dark, name) {
  clearDialogs();
  let png = screencap();
  if (judgeBars(run, step, png, webViewBox(), dark, true) === "again") { await sleep(1500); png = screencap(); judgeBars(run, step, png, freshBox() || webViewBox(), dark); }   // the second look reads the WebView's place again, not the kept one
  saveShot(png, name);
}

// ---- Back as a finger gives it: when the keyboard is open the first press only closes it (every Android app), then the screen goes back.
// The system says whether the keyboard is open: the page shrinks only once the keyboard is drawn, which the emulator can do a second late
// (27.10, API 35, 360-f130: the compare sheet's search field had called it up, the page had not shrunk yet, and the one press closed only
// the keyboard). So a text field with the focus gets two seconds to call it up, and the screen is given time to answer the press
const kbOpen = async (p, c) => { const h = await p.evaluate(() => innerHeight).catch(() => 0); return !!(c && c.fullH && h && h < c.fullH - 120); };
const imeShown = () => (/mInputShown=(\w+)/.exec(sh("dumpsys input_method")) || [])[1] === "true";
const typing = (p) => p.evaluate(() => { const e = document.activeElement; return !!e && (e.tagName === "TEXTAREA" || e.tagName === "INPUT" && !/^(button|checkbox|radio|submit|reset|range|color|file|image|hidden)$/.test(e.type)); }).catch(() => false);
const realBack = async (p, c) => {
  clearDialogs();
  let kb = await kbOpen(p, c);
  const field = !kb && await typing(p);
  for (let t = 0; field && !kb && t < 8; t++) { kb = imeShown() || await kbOpen(p, c); if (!kb) await sleep(250); }
  if (kb) { sh("input keyevent 4"); for (let t = 0; t < 8 && imeShown(); t++) await sleep(250); await sleep(400); }
  const before = JSON.stringify(await screenOf(p).catch(() => null));
  sh("input keyevent 4");
  for (let t = 0; t < 10; t++) { await sleep(t ? 250 : 700); if (JSON.stringify(await screenOf(p).catch(() => null)) !== before) break; }
};

// ---- one journey of ui-flows on the phone
const shotOnce = new Set();
async function journey(page, sc, state, J, theme) {
  const run = `${J.name}/${state}/${sc.id}/${theme}`, tj = Date.now();
  cur.run = run; cur.step = "load";
  // the app's page closed under the journey (the system stopped the app after an ANR, or the WebView went away): every later step would
  // only meet the closed page, so the journey ends here and the main loop runs it again on a fresh start
  const closed = (e) => page.isClosed() || /has been closed/.test(String(e && e.message));
  try { await prepare(page, state, theme); } catch (e) { if (closed(e)) { disturbed.add("closed"); crashes(run, "load", true); return page; } add("block", "logic", run, "load", "could not load the state: " + e.message.split("\n")[0].slice(0, 120)); return; }
  const c = { dev: { id: sc.id, w: sc.dp, h: 860 }, theme, state, app: true, ctx: null, net, page, plate: state === "many" ? "7654321" : "1234567", back: realBack, reopen };
  [c.fullW, c.fullH] = await page.evaluate(() => [innerWidth, innerHeight]).catch(() => [0, 0]);
  const ui0 = sysUiPid(), seen = []; let prev = null;
  for (const [name, act, expect] of J.steps) {
    cur.step = name;
    // a step that opens the app again (reopen) hands over the new page
    if (act) { try { const r = await act(page, c); if (r && typeof r.evaluate === "function") page = c.page = r; } catch (e) { if (closed(e)) { disturbed.add("closed"); break; } add("block", "logic", run, name, "could not act: " + e.message.split("\n")[0].slice(0, 120)); } }
    await sleep(500);
    let m; try { m = await UF.measure(page); } catch (e) { mustLive(); if (closed(e)) { disturbed.add("closed"); break; } add("block", "error", run, name, "measure failed: " + e.message.slice(0, 100)); continue; }
    // the window grew or shrank under the journey with no keyboard and no turn: the system's bars went away or came back (26.10, API 31,
    // a minute after boot: home drawn with no bars at all, then the status bar without its icons and three buttons at the bottom)
    if (c.fullH && m.vw === c.fullW && Math.abs(m.vh - c.fullH) >= 16 && m.vh > c.fullH - 120) disturbed.add("resized");
    let ok = expect ? await expect(m, c) : true;
    if (ok && ok.warn) { add("warn", "logic", run, name, ok.warn); ok = true; }
    if (ok !== true) add("block", "logic", run, name, ok);
    UF.judgeStep(run, name, m, { app: true, barMax: Math.round(80 * Math.max(1, sc.font)), large: sc.font >= 1.75 });
    if (ok === true && act === UF.back && prev && ["screen", "sheet", "url", "carPlate", "msg", "tab"].every((k) => prev[k] === m[k]) && !(m.screen === "home" && m.home)) add("block", "logic", run, name, `Back did nothing on ${m.screen} (a dead press)`);
    prev = m;
    seen.push({ step: name, screen: m.screen, sheet: m.sheet, nav: m.nav, col: m.col, title: m.title, y: m.y, vw: m.vw });
    // each screen once per phone setting: a screenshot, and the bars checked against the page (not with the keyboard up)
    const key = `${sc.id}/${theme}/${m.screen}/${m.sheet || ""}`;
    if (!shotOnce.has(key) && !(await kbOpen(page, c))) {
      shotOnce.add(key);
      await look(run, name, theme === "dark", `${sc.id}__${theme}__${m.screen}${m.sheet ? "-" + m.sheet : ""}__${J.name}-${name}`);
    }
  }
  UF.judgeRun(run, seen, sc.dp);
  crashes(run, cur.step, true);
  if (sysUiPid() !== ui0) disturbed.add("systemui");
  log(`${run}: ${seen.length} steps, ${((Date.now() - tj) / 1000).toFixed(0)} s${disturbed.size ? ` (disturbed: ${disturbedSay()})` : ""}`);
  return page;
}
// the app opened again as a person does it after closing it: Home (the app goes to the background and the page is told it is hidden),
// then the app is stopped as a swipe in the recent apps stops it, and started again; nothing it had in memory survives, only what it stored
async function reopen() {
  sh("input keyevent 3"); await sleep(1500);
  const page = await launch();
  await page.addStyleTag({ content: "*{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}" });
  return page;
}

// ---- the text zoom the phone's font size gives the page (a 16px line measured)
const zoomOf = (page) => page.evaluate(() => { const s = document.createElement("span"); s.style.cssText = "font:16px/1 sans-serif;position:absolute;visibility:hidden"; s.textContent = "אבג"; document.body.appendChild(s); const h = s.getBoundingClientRect().height; s.remove(); return Math.round((h / 16) * 100) / 100; });

// ---- the ways in from outside the page, with the app already open (warm) and from a cold start
const screenOf = (page) => page.evaluate(() => ({ screen: document.body.dataset.screen, sheet: [...document.querySelectorAll(".sheet:not([hidden]), #compareSheet:not([hidden])")].map((e) => e.id || e.className).join(","), car: ((document.querySelector("#chead .mini-plate") || {}).textContent || "").replace(/\D/g, ""), tab: typeof currentTab !== "undefined" ? currentTab : null, url: location.search + location.hash, msg: [...document.querySelectorAll("#out .msg")].map((m) => m.textContent).join(" | ").slice(0, 80) }));
async function waitFor(page, ok, ms = 12000) { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await screenOf(page).catch(() => null); if (s && ok(s)) return s; await sleep(400); } return s; }
const said = (s) => (s ? `${s.screen}${s.sheet ? " " + s.sheet : ""}, car ${s.car || "-"}, tab ${s.tab}${s.msg ? `, "${s.msg}"` : ""}` : "no page");
// in the owner's state: 1234567 is the user's own car (saved, with its file and an open recall), 7654321 a car seen in an ad
async function entries(page, sc) {
  const run = `entries/owner/${sc.id}/light`; cur.run = run;
  await prepare(page, "owner", "light");
  const home = async () => { await page.evaluate(() => { for (let i = 0; i < 6 && window.appBack && window.appBack(); i++); }).catch(() => {}); await page.click('#bnav [data-nav="search"]').catch(() => {}); await sleep(400); };
  const warm = async (name, extra, ok, want) => {
    cur.step = name;
    sh(`am start -n ${ACT} ${extra}`);
    const s = await waitFor(page, ok);
    if (!s || !ok(s)) add("block", "entry", run, name, `${want}; got ${said(s)}`);
    saveShot(screencap(), `${sc.id}__entry__${name}`);
    await home();
  };
  const flags = "-f 0x24000000";   // CLEAR_TOP | SINGLE_TOP, as the alert's own intent
  await warm("shortcut-saved", "-a android.intent.action.VIEW -d luchit://saved", (s) => s.screen === "cars", "the launcher shortcut הרכבים שלי should open הרכבים שלי");
  await warm("shortcut-compare", "-a android.intent.action.VIEW -d luchit://compare", (s) => /compare/i.test(s.sheet) || s.screen === "sub", "the launcher shortcut השוואה should open the comparison");
  await warm("alert-recall", `${flags} -d luchit://plate/1234567 --es plate 1234567 --es nkind recall`, (s) => s.screen === "car" && s.car === "1234567" && s.tab === "recalls", "a tapped recall alert should open the car on its recalls tab");
  await warm("alert-test", `${flags} -d luchit://plate/1234567 --es plate 1234567 --es nkind test`, (s) => s.screen === "car" && s.car === "1234567" && s.tab === "file", "a tapped test alert should open the user's own car in its file");
  await warm("alert-owner", `${flags} -d luchit://plate/1234567 --es plate 1234567 --es nkind owner`, (s) => s.screen === "car" && s.car === "1234567" && s.tab === "overview", "a tapped owner alert should open the car on its overview");
  await warm("share-text", `-a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT 'למכירה טויוטה קורולה 2021 טלפון 050-0000000 מספר רכב 12-345-67'`, (s) => s.screen === "car" && s.car === "1234567", "an ad shared into the app should check its plate (not the phone number)");
  await warm("app-link", `-a android.intent.action.VIEW -d 'https://luchit.app/?plate=7654321&s=wa'`, (s) => s.screen === "car" && s.car === "7654321", "a luchit.app link with a plate should open that car");
  await warm("compare-link", `-a android.intent.action.VIEW -d 'https://luchit.app/?compare=1234567,7654321'`, (s) => /compare/i.test(s.sheet) || s.screen === "sub", "a luchit.app comparison link should open the comparison");
  // a campaign link with the app open brings it to the front where it was (the page counts the visit; nothing else should move)
  cur.step = "campaign-link";
  sh(`am start -n ${ACT} -a android.intent.action.VIEW -d 'https://luchit.app/?utm_source=facebook&utm_campaign=market'`); await sleep(1500);
  if (!front()) add("block", "entry", run, "campaign-link", "a campaign link should bring the app to the front");
  if (await page.evaluate(() => document.querySelectorAll("#out .msg.err").length).catch(() => 0)) add("block", "entry", run, "campaign-link", "a campaign link left an error message on the screen");
  // cold, with the network off: the app must load index.html?nk=recall#1234567 (its part), and the page must open the saved copy of
  // the car on its recalls tab (its part). The page starts before its requests can be mocked, so nothing may leave the emulator
  cur.step = "alert-cold";
  sh(`am force-stop ${PKG}`);
  network(false);
  try {
    sh(`am start -W -n ${ACT} ${flags} -d luchit://plate/1234567 --es plate 1234567 --es nkind recall`);
    const p2 = await attach();
    const s = await waitFor(p2, (s) => s.screen === "car" && s.car === "1234567", 15000);
    const loaded = await p2.evaluate(() => (performance.getEntriesByType("navigation")[0] || {}).name || "").catch(() => "");
    if (!/[?&]nk=recall\b/.test(loaded) || !/#1234567$/.test(loaded)) add("block", "entry", run, "alert-cold", `a recall alert tapped with the app closed should load index.html?nk=recall#1234567; the app loaded ${loaded.replace(/^https:\/\/[^/]+/, "") || "nothing"}`);
    if (!s || s.screen !== "car" || s.tab !== "recalls") add("block", "entry", run, "alert-cold", `a recall alert tapped with the app closed and no network should open the saved copy of the car on its recalls tab; got ${said(s)}`);
    saveShot(screencap(), `${sc.id}__entry__alert-cold-offline`);
    page = p2;
  } finally { network(true); }
  crashes(run, "entries");
  return page;
}

// ---- the keyboard, Back at home, a turn on its side
async function phoneChecks(page, sc) {
  const run = `phone/one/${sc.id}/light`; cur.run = run;
  await prepare(page, "one", "light");
  // the keyboard: tap the plate field like a finger; the field and its button must stay above the keyboard, the bottom bar out of the way
  cur.step = "keyboard";
  sh("settings put secure show_ime_with_hard_keyboard 1");
  const box = webViewBox(), r = await page.evaluate(() => { const e = document.getElementById("plate").getBoundingClientRect(); return { x: e.left + e.width / 2, y: e.top + e.height / 2, h: innerHeight, dpr: devicePixelRatio }; });
  clearDialogs();
  if (box) { sh(`input tap ${Math.round(box.l + r.x * r.dpr)} ${Math.round(box.t + r.y * r.dpr)}`); await sleep(1500); }
  const kb = () => page.evaluate(() => { const v = (id) => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; }; const nav = document.getElementById("bnav"), on = nav && getComputedStyle(nav).display !== "none", mq = (q) => matchMedia(q).matches; return { h: innerHeight, plate: v("plate"), go: v("go"), focus: document.activeElement && document.activeElement.id, nav: on ? Math.round(nav.getBoundingClientRect().top) : null, kbClass: document.body.classList.contains("kb"), pointer: { coarse: mq("(pointer: coarse)"), anyCoarse: mq("(any-pointer: coarse)"), hoverNone: mq("(hover: none)"), touchPoints: navigator.maxTouchPoints } }; });
  const k = await kb();
  const kbUp = k.h < r.h - 100;
  if (!kbUp) add("warn", "keyboard", run, "keyboard", `the keyboard did not open over the plate field (page height ${r.h} → ${k.h}, focus ${k.focus})`);
  else {
    if (!k.plate || k.plate.bottom > k.h) add("block", "keyboard", run, "keyboard", `the plate field is under the keyboard (field bottom ${k.plate && k.plate.bottom}, visible height ${k.h})`);
    if (!k.go || k.go.bottom > k.h) add("block", "keyboard", run, "keyboard", `the check button is under the keyboard (button bottom ${k.go && k.go.bottom}, visible height ${k.h})`);
    if (k.nav !== null) add("block", "keyboard", run, "keyboard", k.go && k.nav < k.go.bottom ? `the bottom bar rides up over the plate field with the keyboard open (bar top ${k.nav}, button bottom ${k.go.bottom})` : `the bottom bar rides on top of the keyboard instead of stepping aside while typing (bar top ${k.nav}, visible height ${k.h})`);
  }
  saveShot(screencap(), `${sc.id}__keyboard`);
  meta.keyboard = { before: r.h, after: k.h, kbClass: k.kbClass, pointer: k.pointer };
  // Back closes only the keyboard; the field may keep its caret, but the bottom bar must come back with the full screen
  clearDialogs(); sh("input keyevent 4"); await sleep(900);
  const k2 = await kb();
  if (kbUp && k2.h >= r.h - 20 && k2.nav === null) add("warn", "keyboard", run, "keyboard-back", "after Back closed the keyboard the bottom bar stays hidden until the plate field loses its focus");
  // Back at home: the app goes to the background (as Android 12 and later do with every app), it is not finished
  cur.step = "back-home";
  await page.click('#bnav [data-nav="search"]').catch(() => {});
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur()).catch(() => {});
  await page.evaluate(() => { window.__warm = 1; });
  clearDialogs(); sh("input keyevent 4"); await sleep(1500);
  meta.backAtHome = sh(`dumpsys activity activities | grep -E "ActivityRecord.*${PKG}"`) ? "kept" : "finished";
  if (meta.backAtHome === "finished") add("warn", "back", run, "back-home", "Back on the home screen closes the app: the next open starts from scratch (Android 12 and later leave an app in the background)");
  sh(`am start -n ${ACT}`); await sleep(1500);
  let p2 = await attach();
  if (meta.backAtHome === "kept" && !(await p2.evaluate(() => window.__warm === 1).catch(() => false))) add("warn", "back", run, "back-home", "the app came back from the background with its page loaded again (the screen it was on is lost)");
  // turned on its side
  cur.step = "landscape";
  setPhone({ dp: sc.dp, font: sc.font, night: false, land: true }); await sleep(2000);
  p2 = await attach().catch(() => p2);
  await p2.waitForSelector(READY, { state: "attached", timeout: 15000 }).catch(() => {});
  try { const m = await UF.measure(p2); UF.judgeStep(run, "landscape", m, { app: true, barMax: 80 }); } catch (e) { add("warn", "logic", run, "landscape", "could not measure on its side: " + e.message.slice(0, 80)); }
  saveShot(screencap(), `${sc.id}__landscape`);
  setPhone({ dp: sc.dp, font: sc.font, night: false, land: false }); await sleep(1500);
  crashes(run, "phone");
  return attach().catch(() => p2);
}

// ---- a dark phone: the theme "לפי המכשיר" follows it, and the app does not flash white while it opens
const themeOf = (page) => page.evaluate(() => ({ mq: matchMedia("(prefers-color-scheme: dark)").matches, bg: getComputedStyle(document.body).backgroundColor }));
const isDarkBg = (bg) => { const m = (bg || "").match(/\d+/g) || [255, 255, 255]; return lum(m.slice(0, 3).map(Number)) < 0.4; };
async function darkChecks(sc) {
  const run = `dark/one/${sc.id}/auto`; cur.run = run;
  for (const night of [false, true]) {
    cur.step = night ? "auto-dark" : "auto-light";
    setPhone({ dp: sc.dp, font: 1, night });
    const page = await launch();
    await prepare(page, "one", "auto");
    const d = await themeOf(page);
    // what counts is the page's own look: an older WebView keeps prefers-color-scheme light on a dark phone (WebView 91 on Android 12),
    // and the app tells the page itself (AndroidApp.systemDark); the media query is only recorded
    (meta.autoTheme = meta.autoTheme || []).push({ phone: night ? "dark" : "light", page: isDarkBg(d.bg) ? "dark" : "light", mq: d.mq ? "dark" : "light" });
    if (isDarkBg(d.bg) !== night) add("block", "theme", run, cur.step, `with "לפי המכשיר" and the phone ${night ? "dark" : "light"}, the page is ${isDarkBg(d.bg) ? "dark" : "light"} (prefers-color-scheme: ${d.mq ? "dark" : "light"})`);
    await look(run, cur.step, night, `${sc.id}__auto-${night ? "dark" : "light"}`);
    // the phone turns dark with the app open: the page follows without a restart
    if (!night) {
      cur.step = "auto-live";
      sh("cmd uimode night yes"); await sleep(2500);
      const l = await themeOf(page).catch(() => null);
      if (!l || !isDarkBg(l.bg)) add("warn", "theme", run, "auto-live", `with "לפי המכשיר", the page stays light when the phone turns dark while the app is open (background ${l && l.bg})`);
      else await look(run, "auto-live", true, `${sc.id}__auto-live-dark`);
      sh("cmd uimode night no"); await sleep(1500);
    }
  }
  // the opening frames of a dark phone with the dark theme chosen
  cur.step = "launch-dark";
  setPhone({ dp: sc.dp, font: 1, night: true });
  const page = await launch();
  await prepare(page, "one", "dark");
  sh(`am force-stop ${PKG}`);
  spawnSync("adb", ["shell", `am start -n ${ACT}`]);
  const frames = [];
  for (let i = 0; i < 6; i++) { const png = screencap(); if (png) { const b = band(png, png.height * 0.3 | 0, png.height * 0.7 | 0); frames.push(b ? Math.round(lum(b.bg) * 100) / 100 : null); if (i === 1) saveShot(png, `${sc.id}__launch-dark-early`); } }
  meta.launchDark = frames;
  const firstDark = frames.findIndex((l) => l !== null && l <= 0.8), own = +meta.sdk >= 33 ? frames : frames.slice(firstDark < 0 ? -1 : firstDark);
  if (own.some((l) => l !== null && l > 0.8)) add("warn", "flash", run, "launch-dark", `a dark phone sees a white screen while the app opens (brightness of the frames: ${frames.join(", ")}${+meta.sdk >= 33 ? "" : "; before Android 13 the system's splash is light whatever the app chose, so only the frames after it count"})`);
  setPhone({ dp: sc.dp, font: 1, night: false });
  crashes(run, "dark");
}

// ---- the phone settings: each one is its own run on a fresh emulator in app-guardian.yml (--scenario), all of them without it
const SCENARIOS = [
  { id: "411-f100", dp: 411, font: 1, runs: [["tour", "empty", "light"], ["tour", "many", "light"], ["check", "one", "light"], ["plus", "one", "light"], ["plus-undo", "one", "light"], ["file-door", "one", "light"], ["saved", "many", "light"], ["compare", "one", "light"], ["tools", "one", "light"], ["owner", "owner", "light"], ["check", "many", "dark"], ["keeps", "one", "light"]] },
  { id: "411-extra", dp: 411, font: 1, runs: [], extra: true },
  { id: "360-f130", dp: 360, font: 1.3, runs: [["tour", "many", "light"], ["check", "many", "light"], ["saved", "many", "light"], ["compare", "one", "light"]] },
  { id: "320-f130", dp: 320, font: 1.3, runs: [["tour", "one", "dark"], ["check", "one", "dark"], ["saved", "many", "dark"]] },
  { id: "411-f200", dp: 411, font: 2, runs: [["tour", "one", "light"], ["check", "one", "light"]] },
].filter((s) => !ONLY || s.id === ONLY).map((s) => (QUICK ? { ...s, runs: s.runs.slice(0, 2) } : s));

// the findings and the summary, written however the run ends
function finish(line, code) {
  if (line) console.log(line);
  try { if (alive()) crashes(cur.run, cur.step); } catch {}
  fs.writeFileSync(path.join(OUT, "findings.json"), JSON.stringify(findings, null, 1));
  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify(meta, null, 1));
  // for the workflow: exit (0 clean, 1 blocking findings, 2 not run to the end), and gone when the emulator stopped (it tries once more)
  fs.writeFileSync(path.join(OUT, "exit"), String(code));
  if (meta.gone) fs.writeFileSync(path.join(OUT, "gone"), meta.gone + "\n");
  process.exit(code);
}

(async () => {
  const t0 = Date.now();
  if (!SCENARIOS.length) throw new Error(`no phone setting called ${ONLY}`);
  meta.sdk = sh("getprop ro.build.version.sdk");
  if (APK) { const r = spawnSync("adb", ["install", "-r", "-g", APK], { encoding: "utf8" }); log("install:", (r.stdout || r.stderr || "").trim().split("\n").pop()); }
  sh("logcat -b crash -b events -c");
  sh("settings put global hide_error_dialogs 1");   // an ANR dialog would cover every later step (the ANR itself is still logged)
  sh("settings put system font_scale 1.05");   // Android reads that setting again only when the configuration changes: the font size set next does it
  await connect();
  meta.model = device.model();
  meta.webview = sh("dumpsys webviewupdate | grep -m1 'Current WebView package'");
  log(`${meta.model}, API ${meta.sdk}, ${meta.webview}`);
  sh("settings put global window_animation_scale 0"); sh("settings put global transition_animation_scale 0"); sh("settings put global animator_duration_scale 0");
  for (const sc of SCENARIOS) {
    const ts = Date.now();
    log(`--- ${sc.id}: ${sc.dp} dp wide, font ${Math.round(sc.font * 100)}%`);
    setPhone({ dp: sc.dp, font: sc.font });
    // the first start of a phone setting gets a second try: a newly booted emulator can starve the app's first frame (26.10, API 35: the
    // system at 100% CPU a minute after boot, an ANR outside the app's code, its page closed). A crash of the app or an ANR in its own code
    // still blocks; two failed starts without either are the emulator (Gone: the workflow runs the phone setting on a new emulator)
    let page;
    for (let tri = 1; !page; tri++) {
      try { page = await launch({ clear: true }); }
      catch (e) {
        if (e instanceof Gone) throw e;
        const mark = findings.length, why = e.message.split("\n")[0].slice(0, 160);
        crashes(`launch/-/${sc.id}/-`, "launch");
        if (findings.slice(mark).some((f) => f.sev === "block")) { add("block", "launch", `launch/-/${sc.id}/-`, "launch", why); break; }
        if (tri === 2) throw new Gone(`the app's page did not open on two fresh starts of ${sc.id}, with no crash and no ANR in the app's code (${why})`);
        log(`${sc.id}: the first start failed (${why}), so the app starts once more`);
        await sleep(5000);
      }
    }
    if (!page) continue;
    const z = await zoomOf(page).catch(() => null), ua = await page.evaluate(() => navigator.userAgent).catch(() => "");
    log(`${sc.id}: text zoom ${z}, ${ua.match(/Chrome\/[\d.]+/) || ua}`);
    for (const [name, state, theme] of sc.runs) {
      const J = UF.JOURNEYS.find((j) => j.name === name), run = `${name}/${state}/${sc.id}/${theme}`;
      for (let tri = 1; tri <= 2; tri++) {
        const mark = findings.length, shots = [...shotOnce];
        disturbed.clear(); lastAnr = null;
        try { page = (await journey(page, sc, state, J, theme)) || page; }
        catch (e) { if (e instanceof Gone) throw e; add("block", "error", run, cur.step, "run crashed: " + e.message.split("\n")[0].slice(0, 160)); crashes(run, cur.step, true); page = await launch().catch(() => page); }
        if (!disturbed.size) break;
        const why = disturbedSay();
        if (tri === 1) {
          // of the first try only what is the app's own in any case stays: a crash, and an ANR (a warning until it comes again)
          const first = findings.splice(mark), kept = first.filter((f) => f.kind === "crash" || f.kind === "anr");
          findings.push(...kept);
          (meta.retried = meta.retried || []).push({ run, why, dropped: first.filter((f) => !kept.includes(f)).map((f) => `${f.sev} ${f.kind} ${f.step}: ${f.msg}`.slice(0, 200)) });
          shotOnce.clear(); for (const k of shots) shotOnce.add(k);   // the screens of the first try are photographed again
          log(`${run}: disturbed (${why}), so it runs once more on a fresh start and only that try counts (${first.length - kept.length} findings of the first try are in meta.json)`);
          boxCache = null;   // the system may have moved its bars meanwhile: the WebView's place is read again
          try { page = await launch(); }
          catch (e) { if (e instanceof Gone) throw e; throw new Gone(`the app did not start again after ${run} was disturbed (${why}): ${e.message.split("\n")[0].slice(0, 120)}`); }
          continue;
        }
        // disturbed in both tries: an ANR in the app's own code, or one without a stack to tell, is the app's; a page that closed, another
        // app's dialog or the system's bars starting again, without a crash of the app, is the emulator (exit 2: the workflow runs the phone
        // setting on a new emulator); an ANR with the main thread idle or in the WebView's drawing, after which the journey still ran to its
        // end, stays a warning; a window that changed height again while the system's bars held is the app's, and what that try found stands
        if (disturbed.has("anr") && lastAnr && (lastAnr.ours || !lastAnr.stack)) add("block", "anr", run, cur.step, `the app stopped responding (ANR) in both tries of this journey, the second time ${lastAnr.ours ? "in the app's own code" : "without a stack to tell where"} (${lastAnr.file})`);
        else if ([...disturbed].some((w) => w !== "anr" && w !== "resized") && !findings.slice(mark).some((f) => f.kind === "crash" && f.sev === "block")) throw new Gone(`the phone disturbed ${run} in both tries (${why})`);
      }
    }
    if (sc.extra) {
      try { page = await entries(page, sc); } catch (e) { if (e instanceof Gone) throw e; add("block", "error", cur.run, cur.step, "crashed: " + e.message.split("\n")[0].slice(0, 160)); page = await launch().catch(() => page); }
      try { page = await phoneChecks(page, sc); } catch (e) { if (e instanceof Gone) throw e; add("block", "error", cur.run, cur.step, "crashed: " + e.message.split("\n")[0].slice(0, 160)); }
      try { await darkChecks(sc); } catch (e) { if (e instanceof Gone) throw e; add("block", "error", cur.run, cur.step, "crashed: " + e.message.split("\n")[0].slice(0, 160)); }
    }
    meta.scenarios.push({ id: sc.id, zoom: z, webview: (ua.match(/Chrome\/[\d.]+/) || [""])[0], seconds: Math.round((Date.now() - ts) / 1000) });
  }
  setPhone({ dp: 411, font: 1 });
  await device.close().catch(() => {});
  crashes(cur.run, cur.step);
  const groups = {};
  for (const f of findings) { const k = f.sev + "|" + f.kind + "|" + f.step + "|" + f.msg.replace(/\d+px|\d+\.\d+|[\d,]{6,}/g, "#"); (groups[k] = groups[k] || { ...f, n: 0, runs: [] }).n++; groups[k].runs.push(f.run); }
  const list = Object.values(groups).sort((a, b) => (a.sev === b.sev ? b.n - a.n : a.sev === "block" ? -1 : 1));
  for (const g of list) console.log(`${g.sev === "block" ? "::error::" : "::warning::"}(real app, API ${meta.sdk}) [${g.kind}] ${g.step}: ${g.msg} (${g.n}x, e.g. ${g.runs[0]})`);
  const blocks = findings.filter((f) => f.sev === "block").length;
  log(`real app on API ${meta.sdk}: ${SCENARIOS.reduce((n, s) => n + s.runs.length, 0)} journeys in ${Math.round((Date.now() - t0) / 1000)} s, ${blocks} blocking, ${findings.length - blocks} warnings, ${list.length} distinct`);
  finish("", blocks ? 1 : 0);
})().catch((e) => {
  if (e instanceof Gone) { meta.gone = e.message; finish(`::error::(real app, API ${meta.sdk}) ${e.message}: the rest of this phone setting did not run (not a finding about the app; ${findings.length} findings until then are in findings.json)`, 2); }
  finish(`::error::(real app) the run crashed: ${e.message}`, 2);
});
