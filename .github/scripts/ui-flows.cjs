// UI flows: walks the real page like a person does (home, a check, every tab, "הרכבים שלי", "התראות", settings, compare, the "+",
// Back, the top-bar search) and measures the layout after EVERY step, not only on a still screen. Phase C of the UI guardian.
//   blocking (exit 1): script errors, a step that lands on the wrong screen or state (journey rules below), the navigation bar moving or
//                      changing size between screens, horizontal overflow, an element pushed past the screen edge, the website's frame
//                      (a footer under every screen; on a wide screen no floating button, share and save with their words), a phone's
//                      bottom bar growing past one row
//   warning:           layout shift (CLS) inside a step above 0.1, a short label that wraps onto a second line, two controls overlapping,
//                      text cut off, the bottom bar covering the end of the page, the content column changing width between screens,
//                      a control dropped to a line of its own, content wider than its column, the same car offered twice on one screen
// Each run: device x theme x data state (no cars / one car / many cars with long names) x journey. Registry answers are mocked
// (no network); "offline" and "registry error" are journeys of their own. "keeps" fills in what a person keeps (a nickname, the file's
// service, km, a policy and its expiry, the look, the fuel price, the alerts), opens the page again and finds each in its place.
// Then the sweep: every control of every screen pressed one at a time; one that changes nothing is a dead control (see SWEEP below).
// --no-fonts serves no font files: a first visit to the site on a slow line draws in the phone's own font (font-display:optional),
// which is wider than Assistant, so a label that fits in Assistant can wrap there.
// --engine webkit walks the journeys in Safari's engine instead of Chromium: nearly every phone that opens the website is an iPhone,
// and every browser on an iPhone draws with WebKit. Each run there gets a browser profile on disk, as Safari has: a test context that
// keeps nothing (like a private window) refuses to store a file in the page's database. The car file keeps a document's bytes there
// since 27.10, and docs-private.cjs checks that case on its own.
// Every run starts as a person who has seen the iPhone sheet "לוחית במסך הבית" (shown once, after the first car saved on an iPhone):
// it covers the page 0.9 s after that save, so it would block whatever the journey does next. "home-sheet" checks the sheet itself.
// Usage: node .github/scripts/ui-flows.cjs [--quick] [--shots] [--no-sweep] [--no-fonts] [--engine chromium|webkit] [--filter <regex>] [--out <dir>]
// The real app on an Android emulator (app-real.cjs) loads this file for the same fixtures, journeys and rules: run on its own, it tests
// in the browser; required, it only hands them over.
const fs = require("node:fs"), http = require("node:http"), path = require("node:path");

const ROOT = process.cwd();
const args = process.argv.slice(2), arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const QUICK = args.includes("--quick") || !!process.env.UF_QUICK, SHOTS = args.includes("--shots"), NO_SWEEP = args.includes("--no-sweep"), NO_FONTS = args.includes("--no-fonts");
const FILTER = arg("--filter") ? new RegExp(arg("--filter")) : null, ENGINE = arg("--engine") || "chromium";
const OUT = path.resolve(arg("--out") || path.join(ROOT, "ui-flows"));

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]); if (p.endsWith("/")) p += "index.html";
  if (NO_FONTS && p.startsWith("/lib/fonts/")) { res.writeHead(404); res.end(); return; }
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
});

// ---- fixtures (example plates only)
const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) + "T00:00:00"; };
const day = (n) => iso(n).slice(0, 10);
const CAR = { _id: 1, mispar_rechev: 1234567, tozeret_nm: "טויוטה יפן", kinuy_mishari: "COROLLA", degem_nm: "ZRE172", shnat_yitzur: 2021, tzeva_rechev: "לבן", sug_delek_nm: "בנזין", tokef_dt: iso(400), mivchan_acharon_dt: iso(-330), moed_aliya_lakvish: "2021-5", tozeret_cd: 1, degem_cd: 1, nefach_manoa: 1798, baalut: "פרטי" };
const CAR2 = { ...CAR, _id: 2, mispar_rechev: 7654321, tozeret_nm: "מרצדס בנץ גרמניה", kinuy_mishari: "GLE 450 4MATIC COUPE AMG LINE PREMIUM PLUS", degem_nm: "GLE450-4MATIC-COUPE-X", tzeva_rechev: "אפור כהה מטלי פנינה", tozeret_cd: 9, shnat_yitzur: 2023 };
const RECS = { 1234567: CAR, 7654321: CAR2 };
// the ministry's per-car list of unfixed recalls: 1234567 has one open (16100, as the many-cars fixture keeps it), so its recalls tab is
// walked and a tapped recall alert has a tab to open
const OPEN_RECALLS = { 1234567: [{ _id: 1, MISPAR_RECHEV: 1234567, RECALL_ID: 16100, SUG_RECALL: "רגיל", TAARICH_PTICHA: iso(-200) }] };
const S1 = { plate: "1234567", title: "טויוטה COROLLA", sub: "2021 · לבן", at: 1, reg: "active", tokef: day(400), mivchan: day(-330), recalls: 0, checked: 1, owners: 1, active: true, events: [], alerts: true, color: "לבן" };
const MANY = [
  { plate: "1234567", title: "טויוטה COROLLA", sub: "2021", nick: "רכב המשפחה", at: 1, reg: "active", tokef: day(25), mivchan: day(-340), recalls: 1, recIds: "16100", checked: 1, owners: 1, active: true, events: [], alerts: true, color: "כסף מטלי" },
  { plate: "7654321", title: "מרצדס בנץ GLE 450 4MATIC COUPE AMG LINE PREMIUM", sub: "2023", nick: "הרכב של העבודה עם שם ארוך מאוד שלא נגמר", at: 2, reg: "active", tokef: day(-12), mivchan: day(-377), recalls: 2, checked: 1, owners: 3, active: true, events: [], alerts: true, color: "אפור כהה מטלי פנינה" },
  // made-up plates in the pattern the still-screen guardian uses (ui-guardian.cjs), never a real car's
  ...[["11122233", "מאזדה CX-5", "אדום"], ["33344455", "סקודה OCTAVIA", "שחור"], ["55566677", "יונדאי IONIQ 5", "לבן"], ["88899900", "קיה SPORTAGE", "כחול"], ["22233344", "פולקסווגן GOLF", "אפור"], ["44455566", "הונדה CIVIC", "כסף"]]
    .map(([plate, title, color], i) => ({ plate, title, sub: String(2016 + i), at: 3 + i, reg: "active", tokef: day(60 + 40 * i), mivchan: day(-300 + 20 * i), recalls: 0, checked: 1, owners: 1 + (i % 3), active: true, events: [], alerts: true, color })),
];
const OWNER = { mine: '{"1234567":1}', svc: JSON.stringify({ 1234567: { log: [{ id: 1, d: day(-140), km: 63900, type: "טיפול תקופתי", cost: 1250, note: "" }, { id: 2, d: day(-20), km: 66100, type: "קריאת ק״מ", cost: 0, note: "" }], meta: null } }) };
// every saved car of the fixtures answers from the registry mock too (its maker and model from the saved title)
for (const it of MANY) if (!RECS[+it.plate]) { const [mk, ...md] = it.title.split(" "); RECS[+it.plate] = { ...CAR, _id: +it.plate, mispar_rechev: +it.plate, tozeret_nm: mk, kinuy_mishari: md.join(" "), shnat_yitzur: +it.sub, tzeva_rechev: it.color }; }
// the registry (data.gov.il) as the journeys see it: the fixture cars, an empty answer for everything else; gov = "500", "abort" or
// "slow" for the error journeys
const govRoute = (r, gov) => {
  const u = r.request().url(), json = (body) => r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  if (gov === "500") return r.fulfill({ status: 500, headers: { "access-control-allow-origin": "*" }, body: "" });   // an error the page can read, as the registry sends it
  if (gov === "abort") return r.abort("internetdisconnected");
  if (gov === "slow") return new Promise((ok) => setTimeout(ok, 25000)).then(() => r.abort()).catch(() => {});
  if (/[?&]limit=0\b/.test(u)) return json({ success: true, result: { records: [], total: 120000 } });
  const m = decodeURIComponent(u).match(/(\d{7,8})/), rec = u.includes("053cea08") && m && RECS[+m[1]];
  const recs = rec ? [rec] : u.includes("36bf1404") && m && OPEN_RECALLS[+m[1]] || [];
  return json({ success: true, result: { records: recs, total: recs.length } });
};
const STATES = {
  empty: {},
  owner: { savedVehicles: JSON.stringify([S1]), recentPlates: '["1234567"]', ...OWNER },
  one: { savedVehicles: JSON.stringify([S1]), recentPlates: '["1234567"]' },
  many: { savedVehicles: JSON.stringify(MANY), recentPlates: JSON.stringify(["7654321", "1234567", "11122233", "33344455", "55566677", "88899900"]) },
};

// the app's bridge as MainActivity defines it, so the app runs here call what the phone has (a share, the calendar, the voice search)
// and nothing the phone lacks; the presses that reach outside the page count as an effect for the sweep, the bookkeeping ones do not
const BRIDGE = (() => { try { const j = fs.readFileSync(path.join(ROOT, "android/app/src/main/java/com/ddsabag/pratirechev/MainActivity.java"), "utf8"); return [...j.matchAll(/@JavascriptInterface\s+public\s+[\w<>[\]]+\s+(\w+)\s*\(/g)].map((m) => m[1]); } catch { return ["alertsState", "setAlerts", "askReview", "checkUpdate", "logEvent", "setAnalytics", "setLandscape", "syncSaved"]; } })();
// the bookkeeping calls: the page reports, or asks the phone, without a press doing anything (setBars follows every change of screen)
const QUIET_BRIDGE = ["logEvent", "logError", "setAnalytics", "syncSaved", "checkUpdate", "setTheme", "setBars", "systemDark", "billingInit", "alertsState"];
const UA = {
  app: "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36",
  phone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  tablet: "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  desk: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
};
// two devices for one journey each: a phone whose main pointer reads as fine (some Android 12 WebViews, a stylus, a mouse plugged in), whose
// keyboard must still move the bottom bar aside, and an iPad on its side (the website's bar at the top, a touch screen)
const PEN = { id: "app-360-pen", ua: "app", w: 360, h: 780, touch: false, only: ["keyboard"] };
const DEVICES = QUICK
  ? [{ id: "app-360", ua: "app", w: 360, h: 780 }, { id: "web-390", ua: "phone", w: 390, h: 760 }, { id: "web-1280", ua: "desk", w: 1280, h: 860 }, PEN]
  : [{ id: "app-320", ua: "app", w: 320, h: 640 }, { id: "app-360", ua: "app", w: 360, h: 780 }, { id: "app-412", ua: "app", w: 412, h: 860 },
     { id: "web-320", ua: "phone", w: 320, h: 568 }, { id: "web-390", ua: "phone", w: 390, h: 760 }, { id: "android-360", ua: "android", w: 360, h: 760 },
     { id: "web-768", ua: "tablet", w: 768, h: 1024 }, { id: "web-1024", ua: "desk", w: 1024, h: 768 }, { id: "web-1280", ua: "desk", w: 1280, h: 860 }, { id: "web-1440", ua: "desk", w: 1440, h: 900 },
     PEN, { id: "web-1180-touch", ua: "tablet", w: 1180, h: 820, mobile: false, touch: true, only: ["bar-field"] }];
const THEMES = QUICK ? ["light"] : ["light", "dark"];

// ---- findings
const findings = [];   // {sev: "block"|"warn", kind, run, step, msg}
const add = (sev, kind, run, step, msg) => { findings.push({ sev, kind, run, step, msg }); };

// ---- what is measured after every step
async function measure(page) {
  return page.evaluate(() => {
    // inside a closed <details> (outside its summary) nothing is drawn, though Chromium still gives the boxes a size
    const shut = (e) => { for (let d = e.parentElement && e.parentElement.closest("details:not([open])"); d; d = d.parentElement && d.parentElement.closest("details:not([open])")) { const s = d.querySelector(":scope > summary"); if (!s || !s.contains(e)) return true; } return false; };
    const vis = (e) => { if (!e) return false; const b = e.getBoundingClientRect(), cs = getComputedStyle(e); return b.width > 0 && b.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0" && !shut(e) && !e.closest("[hidden]"); };
    const R = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
    const label = (e) => (e.getAttribute("aria-label") || e.textContent || e.className || e.tagName).replace(/\s+/g, " ").trim().slice(0, 40);
    const W = innerWidth, sheet = [...document.querySelectorAll(".sheet:not([hidden]), .doc-view, #roadSheet")].filter(vis).pop();
    const nav = document.getElementById("bnav"), navIn = nav && nav.querySelector(".bnav-in");
    const navBox = nav && vis(nav) ? { bar: R(nav), inner: navIn ? R(navIn) : null, items: [...nav.querySelectorAll("[data-nav], .bn-brand")].filter(vis).map((e) => (e.dataset.nav || e.className) + ":" + R(e).join(",")) } : null;
    const out = document.getElementById("out"), col = out && vis(out) ? R(out) : null;
    const scope = [...document.querySelectorAll("body *")].filter((e) => !e.closest("#sprite,svg,script,style,noscript,.sr-only") && (!sheet || sheet.contains(e)) && vis(e));
    const scroller = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return true; } return false; };
    const outside = scope.filter((e) => { const b = e.getBoundingClientRect(); return (b.right > W + 1 || b.left < -1) && getComputedStyle(e).position !== "fixed" && !scroller(e) && b.width < W * 3; }).map(label);
    const ctrls = scope.filter((e) => e.matches("button,a[href],[role=tab],[role=button],summary,select,input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]),.chip,.rc"));
    // lines of text inside an element (text nodes only: an icon beside the words is not a second line)
    const lines = (e) => { const rs = []; const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); for (let n; (n = w.nextNode());) { if (!n.textContent.trim() || !vis(n.parentElement)) continue; const r = document.createRange(); r.selectNodeContents(n); for (const x of r.getClientRects()) if (x.width > 1) rs.push(x); }
      rs.sort((a, b) => a.top - b.top); let n = 0, bottom = -1e9; for (const x of rs) if (x.top >= bottom - 2) { n++; bottom = x.bottom; } else bottom = Math.max(bottom, x.bottom); return n; };
    // a short label that runs onto a second line ("השוואה" under the facts, a chip broken in two)
    const wraps = ctrls.filter((e) => { if (!e.matches("button,a,[role=tab],.chip,.rc")) return false; const t = e.textContent.replace(/\s+/g, " ").trim(); if (!t || t.length > 26 || e.querySelector("small,br,.t,b + span") || getComputedStyle(e).flexDirection === "column") return false; return lines(e) > 1; }).map(label);
    // two controls on top of each other: compared only inside the same layer (the page, or one fixed / sticky bar), boxes per line for inline links
    const layer = (e) => { for (let p = e; p && p !== document.body; p = p.parentElement) { const ps = getComputedStyle(p).position; if (ps === "fixed" || ps === "sticky") return p; } return null; };
    const boxes = ctrls.filter((e) => !e.matches(".note a, #mdlLink a")).map((e) => ({ e, L: layer(e), rs: getComputedStyle(e).display === "inline" ? [...e.getClientRects()] : [e.getBoundingClientRect()] })), overlaps = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], c = boxes[j]; if (a.L !== c.L || a.e.contains(c.e) || c.e.contains(a.e)) continue;
      if (a.rs.some((p) => c.rs.some((q) => Math.min(p.right, q.right) - Math.max(p.left, q.left) > 4 && Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top) > 4))) overlaps.push(label(a.e) + " ⟷ " + label(c.e));
    }
    const clipped = scope.filter((e) => { const cs = getComputedStyle(e); return e.children.length === 0 && e.textContent.trim().length > 2 && (cs.overflow.includes("hidden") || cs.overflowX === "clip") && cs.textOverflow !== "ellipsis" && e.scrollWidth > e.clientWidth + 2; }).map(label);
    // siblings of one row of chips / tabs / buttons at different heights (one of them wrapped or squeezed)
    const ragged = [];
    for (const row of document.querySelectorAll(".rc-row, .tabs, .in-alt, .vseg, .cmp-bar, .seg, .hr-p, .chips, .try")) {
      if (!vis(row) || (sheet && !sheet.contains(row))) continue;
      const kids = [...row.children].filter((k) => vis(k) && k.matches("button,a,.chip,.rc,[role=tab]"));
      const byTop = {}; for (const k of kids) { const b = k.getBoundingClientRect(); (byTop[Math.round(b.top / 4)] = byTop[Math.round(b.top / 4)] || []).push(Math.round(b.height)); }
      for (const hs of Object.values(byTop)) if (hs.length > 1 && Math.max(...hs) - Math.min(...hs) > 3) ragged.push(`${row.className.split(" ")[0]}: ${hs.join("/")}px`);
    }
    // a control that wrapped onto a line of its own at the end of a wrapping row of facts or chips (the compare button under the pills)
    const orphans = [];
    for (const row of scope.filter((e) => { const cs = getComputedStyle(e); return cs.display.includes("flex") && cs.flexWrap === "wrap" && cs.flexDirection.startsWith("row") && e.children.length > 1; })) {
      const kids = [...row.children].filter(vis); if (kids.length < 2) continue;
      const lines = []; for (const k of kids) { const b = k.getBoundingClientRect(), l = lines.find((x) => Math.abs(x.top - b.top) < b.height / 2); if (l) l.k.push(k); else lines.push({ top: b.top, k: [k] }); }
      if (lines.length < 2) continue; const last = lines[lines.length - 1].k;
      if (last.length === 1 && last[0].matches("button,a") && lines.slice(0, -1).some((l) => l.k.length > 1 && l.k.some((k) => !k.matches("button,a")))) orphans.push(`"${label(last[0])}" in .${(row.className || row.tagName).split(" ")[0]}`);
    }
    // content wider than its own column: past the edge of the main column on a wide screen, where nothing should bleed into the margin
    const colBox = out && out.getBoundingClientRect(), padL = out ? parseFloat(getComputedStyle(out).paddingLeft) : 0, padR = out ? parseFloat(getComputedStyle(out).paddingRight) : 0;
    // the part of a box that is drawn: cut by every parent that clips (a name ending in "…" inside its card is not past the column)
    const drawn = (e) => { const b = e.getBoundingClientRect(); let l = b.left, r = b.right; for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).overflowX !== "visible") { const q = p.getBoundingClientRect(); l = Math.max(l, q.left); r = Math.min(r, q.right); } return { left: l, right: r, width: r - l }; };
    const bleed = W >= 700 && colBox && !sheet ? [...out.querySelectorAll("*")].filter((e) => vis(e) && !e.closest("svg")).filter((e) => { const cs = getComputedStyle(e); return e.children.length === 0 || cs.backgroundColor !== "rgba(0, 0, 0, 0)" || parseFloat(cs.borderTopWidth) > 0 || cs.boxShadow !== "none"; }).filter((e) => { const b = drawn(e); return b.width > 20 && (b.left < colBox.left + padL - 2 || b.right > colBox.right - padR + 2) && !e.closest(".cfab,.toast") && !layer(e); }).filter((e, i, a) => !a.some((x) => x !== e && x.contains(e))).map((e) => label(e) + ` (${Math.round(drawn(e).left - colBox.left - padL)}/${Math.round(colBox.right - padR - drawn(e).right)}px)`) : [];
    // the same car offered twice on one screen (a rail and a row of recent checks listing the same plates). Not on התראות: that list has
    // one item per issue, so a car with a recall and a test due rightly shows up in both
    const opens = {}; if (document.body.dataset.screen !== "alerts") for (const e of document.querySelectorAll("#out [data-open]")) if (vis(e) && (!sheet || sheet.contains(e))) opens[e.dataset.open] = (opens[e.dataset.open] || 0) + 1;
    const twice = Object.entries(opens).filter(([, n]) => n > 1).map(([p]) => p);
    let covered = null; if (navBox && getComputedStyle(nav).position === "fixed" && nav.getBoundingClientRect().top > innerHeight / 2 && !sheet) {
      const y0 = scrollY; scrollTo(0, document.documentElement.scrollHeight); const top = nav.getBoundingClientRect().top;
      const last = [...document.querySelectorAll("#out *, body > footer *")].filter((e) => vis(e) && e.children.length === 0 && e.textContent.trim()).pop();
      if (last && last.getBoundingClientRect().bottom > top + 1) covered = label(last); scrollTo(0, y0);
    }
    const h = document.querySelector("#out .vh-t, #out > .vhead h2, #chead .ch-t b");
    // where the words themselves sit (a range over the text), not the heading's box
    const tr = h && (() => { const r = document.createRange(); r.selectNodeContents(h); const b = r.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; })();
    const title = h && vis(h) && !sheet ? { kind: h.matches("#chead *") ? "chead" : "vhead", r: tr, fs: getComputedStyle(h).fontSize } : null;
    const plate = document.getElementById("plate"), mp = document.querySelector("#chead .mini-plate");
    const one = (s) => [...document.querySelectorAll(s)].some(vis);
    return {
      // the website's frame: the footer on every screen, the first visit's example, compare as a floating button or in the title row,
      // the words beside share and save on the wide car header, the tab's own title
      vw: W, vh: innerHeight, footer: one("body > footer"), intro: one("#out .hero .try"), fab: one(".cfab"), tbCmp: one("#out .vh-cmp"), chLabels: [...document.querySelectorAll("#chead .ch-l")].filter(vis).length, docTitle: document.title,
      starOn: (document.querySelector("#chead [data-act=save]") || { getAttribute: () => "" }).getAttribute("aria-pressed") === "true",
      listed: [...document.querySelectorAll("#out [data-open]")].map((e) => e.dataset.open),
      screen: document.body.dataset.screen, tab: typeof currentTab !== "undefined" ? currentTab : null, carOn: !!mp, carPlate: mp ? mp.textContent.replace(/\D/g, "") : "",
      home: !!document.getElementById("homeMark"), fileDoor: !!document.querySelector("#out [data-act=fileHome]"), snack: (document.querySelector("#snack span") || {}).textContent || "", sheet: sheet ? (sheet.id || sheet.className) : null, url: location.pathname + location.search + location.hash, hist: history.length,
      focus: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null, plateVal: plate ? plate.value : null,
      navCur: (document.querySelector("#bnav [aria-current=page]") || { dataset: {} }).dataset.nav || null,
      nav: navBox, col, over: document.documentElement.scrollWidth - W, outside: [...new Set(outside)].slice(0, 8), wraps: [...new Set(wraps)].slice(0, 8), ragged: [...new Set(ragged)],
      overlaps: [...new Set(overlaps)].slice(0, 8), orphans: [...new Set(orphans)].slice(0, 4), twice, bleed: [...new Set(bleed)].slice(0, 4), clipped: [...new Set(clipped)].slice(0, 8), covered, msg: [...document.querySelectorAll("#out .msg")].filter(vis).map((m) => m.textContent).join(" | "),
      loading: !!document.querySelector("#out .skl, #out [aria-busy=true]") || (document.getElementById("go") || {}).disabled === true,
      cls: window.__cls ? window.__cls.v : 0, y: Math.round(scrollY), title,
    };
  });
}

// ---- journeys: each step acts, then says what must be true (true, or the problem in words; {warn} for a softer expectation).
// c: {dev, theme, state, app, plate}
const nav = (n) => async (p) => p.click(`#bnav [data-nav="${n}"]`);
const settle = (p) => p.waitForSelector("#chead .mini-plate, #out .msg:not([aria-busy])", { timeout: 15000 }).catch(() => {});
const check = (which) => async (p, c) => {
  const plate = which || c.plate;
  if (!c.app && c.dev.w >= 1000 && await p.locator("#bnPlate").isVisible()) { await p.fill("#bnPlate", plate); await p.press("#bnPlate", "Enter"); }
  else { if (!(await p.locator("#plate").isVisible())) await p.click('#bnav [data-nav="search"]'); if (!(await p.locator("#plate").isVisible())) await p.click('#bnav [data-nav="search"]'); await p.fill("#plate", plate); await p.press("#plate", "Enter"); }
  await settle(p);
};
// Back: the app's own handler in the browser, the browser's Back on the web, the phone's Back key on the emulator (c.back)
const back = async (p, c) => { if (c.back) await c.back(p, c); else if (c.app) await p.evaluate(() => window.appBack()); else await p.goBack({ waitUntil: "commit" }).catch(() => {}); };
const tap = (sel) => async (p) => p.locator(sel).filter({ visible: true }).first().click({ timeout: 4000 });
const tapIf = (sel) => async (p) => { const l = p.locator(sel).filter({ visible: true }).first(); if (await l.count()) await l.click({ timeout: 4000 }); };
const isCar = (plate) => (m, c) => m.screen === "car" && m.carPlate === (plate || c.plate) || `expected the car ${plate || c.plate}, got screen ${m.screen} ${m.carPlate} ${m.msg.slice(0, 50)}`;
// the "keeps" journey: what is filled in, a page that tells what it did (the toast), and the page opened again
const KEEP = { nick: "הרכב של אמא", svcKm: 70500, cost: 940, note: "רפידות קדמיות", km: 71200, ins: day(380), fuel: "7.45" };
const KEEPS_ON = ["app-360", "web-390", "web-1280"];
const PNG1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";   // a photo of the policy (one pixel)
// what the page told during the step: the toasts it showed (it clears one after 2.2 s, sooner than a slow step ends) and the one on screen
const told = (p) => p.evaluate(() => [...(window.__toasts || []), (document.getElementById("toast") || {}).textContent || ""].filter((t, i, a) => t && a.indexOf(t) === i).join(" | "));
// opened again as a person opens it after closing it: the address without the screen (a car, a tab) it was on, so home
const reopen = async (p, c) => {
  if (c.reopen) return c.reopen(p, c);
  const u = new URL(p.url()); await p.goto(u.origin + u.pathname);
  await p.waitForSelector("#homeMark, #chead .mini-plate, #carsHead, #alertsHead", { state: "attached", timeout: 15000 });
  await p.addStyleTag({ content: "*{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}" });
};
const JOURNEYS = [
  { name: "tour", steps: [
    ["home", null, (m, c) => m.screen === "home" && m.home && (c.state !== "empty" || m.intro) || (m.home ? "a first visit (no cars, no checks) should open with the example plate and how it works" : "home did not draw")],
    ["cars", nav("cars"), (m) => m.screen === "cars" || `cars tab: screen ${m.screen}`],
    ["alerts", nav("alerts"), (m) => m.screen === "alerts" || `alerts tab: screen ${m.screen}`],
    ["search", nav("search"), (m) => m.screen === "home" && m.home || `search tab: screen ${m.screen}`],
    ["settings", tap("#openSettings, #bnSet"), (m) => m.sheet === "settings" || "settings did not open"],
    ["settings-alerts", tap("#toAlerts"), (m) => m.screen === "alerts" && !m.sheet || `"על אילו רכבים" should open התראות, got ${m.screen} ${m.sheet}`],
    ["settings-2", async (p) => { await p.click('#bnav [data-nav="search"]'); await tap("#openSettings, #bnSet")(p); }, (m) => m.sheet === "settings" || "settings"],
    ["dark", tap('[data-theme-choice="dark"]'), (m) => m.sheet === "settings" || "theme"],
    ["settings-close", tap("#closeSettings"), (m) => !m.sheet && m.screen === "home" || "settings did not close back to home"],
    ["cars-dark", nav("cars"), (m) => m.screen === "cars" || "cars"],
  ] },
  { name: "check", steps: [
    ["check", check(), isCar()],
    ...["recalls", "buy", "file", "specs", "overview"].map((t) => [`tab-${t}`, async (p) => { const b = p.locator(`.tabs [data-tab=${t}]`); if (await b.count()) await b.click(); }, (m) => m.screen === "car" || "left the car on a tab"]),
    ["menu", tap("#chead [data-act=cmenu]"), (m) => m.screen === "car" || "menu"],
    ["menu-close", async (p) => p.keyboard.press("Escape"), (m) => m.screen === "car" || "menu close"],
    ["to-cars", nav("cars"), (m) => m.screen === "cars" || `cars: ${m.screen}`],
    ["back-to-car", back, isCar()],
    ["arrow", tap("#chead [data-act=back]"), (m) => m.screen === "home" && !m.carOn || `the car's back arrow should lead home, got ${m.screen}`],
  ] },
  // the "+" in "הרכבים שלי": a clean, focused plate field, never the last car
  { name: "plus", steps: [
    ["check", check(), isCar()],
    ["to-cars", nav("cars"), (m) => m.screen === "cars" || "cars"],
    ["plus", tap("#out [data-act=addCar]"), (m) => m.screen === "home" && !m.carOn && m.home && (m.plateVal || "") === "" && m.focus === "plate" || `"+" should open an empty, focused plate field; got screen ${m.screen}, car ${m.carPlate || "none"}, field "${m.plateVal}", focus ${m.focus}`],
    ["check-2", check("7654321"), (m) => m.screen === "car" && m.carPlate === "7654321" && m.starOn && m.navCur === "cars" || `a car checked after "+" should be in הרכבים שלי (star ${m.starOn}, tab ${m.navCur}, screen ${m.screen} ${m.carPlate})`],
    ["arrow", tap("#chead [data-act=back]"), (m) => m.screen === "cars" && m.listed.includes("7654321") || `the arrow after "+" should return to הרכבים שלי with the new car, got ${m.screen} [${m.listed.join(",")}]`],
  ] },
  // "ביטול" on the snack bar after "+": the car is not kept, and the list stays as it was
  { name: "plus-undo", once: true, steps: [
    ["to-cars", nav("cars"), (m) => m.screen === "cars" || "cars"],
    ["plus", tap("#out [data-act=addCar]"), (m) => m.screen === "home" && m.focus === "plate" || `"+": ${m.screen}, focus ${m.focus}`],
    ["check", check("7654321"), (m) => m.screen === "car" && m.starOn && /נוסף/.test(m.snack) || `after "+" the car is saved and the snack bar offers ביטול (star ${m.starOn}, snack "${m.snack}")`],
    ["undo", tap("#snack [data-s=go]"), (m) => m.screen === "car" && m.carPlate === "7654321" && !m.starOn && !m.snack || `ביטול should leave the car page with the car not saved (star ${m.starOn}, snack "${m.snack}", ${m.screen})`],
    ["arrow", tap("#chead [data-act=back]"), (m) => m.screen === "cars" && !m.listed.includes("7654321") || `after ביטול the list should not have the car: ${m.screen} [${m.listed.join(",")}]`],
  ] },
  // "ביטול" after "+" when the car's file was opened in those seconds: the file goes too (a file belongs to a saved car)
  { name: "plus-undo-file", once: true, web: true, steps: [
    ["to-cars", nav("cars"), (m) => m.screen === "cars" || "cars"],
    ["plus", tap("#out [data-act=addCar]"), (m) => m.screen === "home" && m.focus === "plate" || `"+": ${m.screen}, focus ${m.focus}`],
    ["check", check("7654321"), (m) => m.screen === "car" && m.starOn && /נוסף/.test(m.snack) || `after "+" the car is saved and the snack bar offers ביטול (star ${m.starOn}, snack "${m.snack}")`],
    ["file", tap("#out [data-cf=mine]"), (m) => m.screen === "car" && m.tab === "file" && /נוסף/.test(m.snack) || `the file opened while the snack bar is up (tab ${m.tab}, snack "${m.snack}")`],
    ["undo", tap("#snack [data-s=go]"), async (m, c) => { const mark = await c.page.evaluate(() => { try { return (JSON.parse(localStorage.getItem("mine") || "{}") || {})["7654321"]; } catch { return "?"; } });
      return m.screen === "car" && !m.starOn && m.tab === "overview" && mark === undefined || `ביטול should take back the file opened since "+" too (star ${m.starOn}, tab ${m.tab}, mark ${mark})`; }],
  ] },
  // the iPhone's website, the first car saved: the sheet on putting לוחית on the home screen opens once, a tap beside it closes it, and
  // the page goes on (the other journeys start as a person who has seen it)
  { name: "home-sheet", only: "one", web: true, when: (c) => c.dev.ua === "phone", ls: { homeSheet: null }, steps: [
    ["check", check("7654321"), isCar("7654321")],
    ["save", async (p) => { await tap("#chead [data-act=save]")(p); await p.waitForSelector("#homeSheet", { state: "visible", timeout: 3000 }).catch(() => {}); },
      (m) => m.sheet === "homeSheet" && m.starOn || `the first car saved on an iPhone should open "לוחית במסך הבית" (sheet ${m.sheet}, star ${m.starOn})`],
    ["beside", async (p) => p.locator("#homeSheet").click({ position: { x: 20, y: 20 }, timeout: 4000 }), (m) => !m.sheet && m.screen === "car" || `a tap beside the sheet should close it, got ${m.sheet || "no sheet"} on ${m.screen}`],
    ["cars", nav("cars"), (m) => m.screen === "cars" && m.listed.includes("7654321") || `after the sheet הרכבים שלי should list the saved car, got ${m.screen} [${m.listed.join(",")}]`],
    ["once", async (p) => { await tap('#out [data-open="7654321"]')(p); await settle(p); await tap("#chead [data-act=save]")(p); await tap("#chead [data-act=save]")(p); await p.waitForTimeout(1500); },
      (m) => !m.sheet && m.starOn && m.carPlate === "7654321" || `the sheet opens once: the car saved again got ${m.sheet || "no sheet"} (star ${m.starOn}, ${m.screen} ${m.carPlate})`],
  ] },
  // "יש לכם כבר רכב? פתחו לו תיק" on home: the car checked next opens straight in its file, saved, and the line is gone
  { name: "file-door", when: (c) => c.state === "one", steps: [
    ["door", tap("#out [data-act=fileHome]"), (m) => m.screen === "home" && m.focus === "plate" || `the home file line should lead to the plate field, got ${m.screen}, focus ${m.focus}`],
    ["check", check("7654321"), (m) => m.screen === "car" && m.carPlate === "7654321" && m.tab === "file" && m.starOn || `a car checked from "פתחו לו תיק" should open in its file, saved (tab ${m.tab}, star ${m.starOn}, ${m.screen} ${m.carPlate})`],
    ["home", nav("search"), (m) => m.screen === "home" && !m.fileDoor || `home after opening a file: ${m.screen}, the file line ${m.fileDoor ? "still there" : "gone"}`],
  ] },
  { name: "saved", when: (c) => c.state !== "empty", steps: [
    ["cars", nav("cars"), (m) => m.screen === "cars" || "cars"],
    ["scroll", async (p) => { await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await p.waitForTimeout(200); await p.evaluate(() => { window.__y = Math.round(scrollY); }); }, null],
    ["open", async (p) => { const l = p.locator("#out [data-open]").filter({ visible: true }); await l.nth((await l.count()) - 1).click({ timeout: 4000 }); }, (m) => m.screen === "car" || `opening a saved car: ${m.screen} ${m.msg.slice(0, 40)}`],
    ["arrow-back", tap("#chead [data-act=back]"), async (m, c) => { const y0 = await c.page.evaluate(() => window.__y); return m.screen === "cars" && Math.abs(m.y - y0) < 30 || `the arrow from a car opened in "הרכבים שלי" should return to the list where it was (y ${y0}), got ${m.screen} y ${m.y}`; }],
    ["alerts", nav("alerts"), (m) => m.screen === "alerts" || "alerts"],
    ["alerts-open", tapIf("#out [data-open]"), (m) => m.screen === "car" || m.screen === "alerts" || `a car in התראות: ${m.screen}`],
    ["home", nav("search"), (m) => m.screen === "home" || "home"],
    ["recent", tapIf("#out .rc, #out .hr-row"), (m) => m.screen === "car" || `a recent check / rail row should open the car, got ${m.screen}`],
    ["search-again", nav("search"), (m) => m.screen === "home" || `search tab from a car: ${m.screen}`],
  ] },
  { name: "compare", steps: [
    ["check", check(), isCar()],
    ["compare", tap("#out [data-act=compare]"), (m) => m.screen === "sub" || /compare/i.test(m.sheet || "") || `compare: ${m.screen} ${m.sheet}`],
    ["compare-back", back, (m, c) => m.screen === "car" && !m.sheet || `Back from compare should return to the car, got ${m.screen} ${m.sheet || ""}`],
  ] },
  // web: Escape on the compare picker does what its X does (back to the car, never a comparison of one car)
  { name: "compare-esc", web: true, steps: [
    ["check", check(), isCar()],
    ["compare", tap("#out [data-act=compare]"), (m) => /compare/i.test(m.sheet || "") || `compare: ${m.screen} ${m.sheet}`],
    ["escape", async (p) => p.keyboard.press("Escape"), (m, c) => m.screen === "car" && !m.sheet && m.carPlate === c.plate || `Escape on the compare picker should return to the car, got ${m.screen} ${m.sheet || ""}`],
  ] },
  { name: "tools", steps: [
    ["models", tap("#out [data-act=compareHome]"), (m) => /compare/i.test(m.sheet || "") || m.screen === "sub" || `חיפוש דגמים: ${m.screen} ${m.sheet}`],
    ["models-back", back, (m) => m.screen === "home" && !m.sheet || `Back from חיפוש דגמים: ${m.screen} ${m.sheet || ""}`],
    ["market", tap("#out [data-act=market]"), (m) => m.screen === "sub" || `שוק הרכב: ${m.screen}`],
    ["market-back", tap("#chead [data-act=toolBack]"), (m) => m.screen === "home" || `back from שוק הרכב: ${m.screen}`],
    ["bulk", tap("#out [data-act=bulk]"), (m) => m.screen === "sub" || `בדיקת כמה רכבים: ${m.screen}`],
    ["bulk-cars", nav("cars"), (m) => m.screen === "cars" || `cars from a tool: ${m.screen}`],
    ["bulk-search", nav("search"), (m) => m.screen === "home" || m.screen === "sub" || `search from cars after a tool: ${m.screen}`],
  ] },
  { name: "owner", only: "owner", steps: [
    ["check", check(), isCar()],
    ["file", async (p) => { const b = p.locator(".tabs [data-tab=file]"); if (await b.count()) await b.click(); }, (m) => m.screen === "car" || "file tab"],
    ["docs", tapIf("#chead [data-cf=road]"), (m) => m.screen === "car" || "documents"],
    ["docs-back", back, (m) => m.screen === "car" && !m.sheet || `Back should close the documents sheet first, got ${m.screen} ${m.sheet || ""}`],
  ] },
  // what a person fills in stays where they put it: a nickname, the car marked as theirs, a service, a km reading, an insurance policy
  // with its expiry, the look and the fuel settings, and in the app an alert kind and the car's alerts switched off. Then the page opens
  // again (reloaded here; on the emulator, c.reopen: the app goes to the background and is stopped, as a swipe in the recent apps does,
  // then started) and each of them must be back in its place, with nothing left loading
  { name: "keeps", only: "one", when: (c) => KEEPS_ON.includes(c.dev.id), steps: [
    ["check", check(), isCar()],
    ["nick", async (p) => { await p.click("#chead [data-act=cmenu]"); await p.click(".ch-menu [data-act=nickCar]"); await p.fill("#nickBar input", KEEP.nick); await p.press("#nickBar input", "Enter"); },
      async (m, c) => { const t = await told(c.page); return /הכינוי נשמר/.test(t) && m.screen === "car" || `a nickname typed and Enter should say it was saved, got "${t}" on ${m.screen}`; }],
    ["mine", async (p) => { await p.click("#chead [data-act=cmenu]"); await p.click(".ch-menu [data-act=mineMenu]"); }, (m) => m.screen === "car" && m.tab === "file" || `"זה הרכב שלי" should open the car's file, got tab ${m.tab} on ${m.screen}`],
    ["service", async (p) => { await p.click(".cf-quick [data-cf=svc]"); await p.selectOption("#svcType", "בלמים"); await p.fill("#svcKm", String(KEEP.svcKm)); await p.fill("#svcCost", String(KEEP.cost)); await p.fill("#svcNote", KEEP.note); await p.click("[data-svc=save]"); },
      async (m, c) => { const t = await told(c.page); return /הטיפול נשמר/.test(t) || `saving a service should say so, got "${t}"`; }],
    ["km", async (p) => { await p.click(".cf-quick [data-cf=km]"); await p.fill("#kmVal", String(KEEP.km)); await p.click("[data-svc=km]"); },
      async (m, c) => { const t = await told(c.page); return /הק״מ נשמר/.test(t) || `saving a km reading should say so, got "${t}"`; }],
    ["policy", async (p) => { await p.click(".cf-quick [data-cf=doc]"); await p.selectOption("#docCat", "ביטוח"); await p.setInputFiles("#docFile", { name: "policy.png", mimeType: "image/png", buffer: Buffer.from(PNG1, "base64") }); await p.waitForSelector("#docList [data-docexp]", { state: "attached", timeout: 8000 }); },
      async (m, c) => { const t = await told(c.page); return /המסמך נשמר/.test(t) || `adding a policy should say it was saved, got "${t}"`; }],
    ["policy-date", async (p) => { await p.locator("#docList [data-docexp]").first().fill(KEEP.ins); await p.waitForTimeout(300); },
      async (m, c) => { const t = await told(c.page); return /בתוקף עד/.test(t) || `a policy's expiry should say it was saved, got "${t}"`; }],
    ["look", async (p) => { await p.click("#bnav [data-nav=search]"); await tap("#openSettings, #bnSet")(p); await p.click('[data-theme-choice="dark"]'); await p.click('[data-unit="kml"]'); await p.fill("#fuelPrice", KEEP.fuel); await p.locator("#fuelPrice").blur(); await p.click("#closeSettings"); },
      (m) => !m.sheet || `settings should close, got ${m.sheet}`],
    ["alerts", async (p, c) => { await nav("alerts")(p); if (!c.app) return; await p.click("#out details.akinds > summary"); await p.locator('#out [data-kind="service"]').uncheck(); await p.click('#out [data-bell="1234567"]'); },
      (m) => m.screen === "alerts" || `alerts: ${m.screen}`],
    ["reopen", reopen, (m) => !m.loading || `the page opened again is still loading on ${m.screen}`],
    ["cars-kept", nav("cars"), async (m, c) => { const t = await c.page.evaluate(() => [...document.querySelectorAll('#out [data-open="1234567"]')].map((e) => e.textContent).join(" ")); return m.screen === "cars" && t.includes(KEEP.nick) || `after opening again, הרכבים שלי should call the car "${KEEP.nick}", got "${t.replace(/\s+/g, " ").trim().slice(0, 80)}"`; }],
    ["car-kept", tap('#out [data-open="1234567"]'), async (m, c) => {
      const k = await c.page.evaluate(() => ({ nick: (document.querySelector("#out .id-nick") || {}).textContent || "", file: !!document.querySelector(".tabs [data-tab=file]"), dark: document.documentElement.dataset.theme }));
      const miss = [k.nick.includes(KEEP.nick) ? "" : `the nickname on the car page ("${k.nick}")`, k.file ? "" : "the file tab (the car is the user's)", k.dark === "dark" ? "" : `the dark look (${k.dark})`].filter(Boolean);
      return m.screen === "car" && !m.loading && !miss.length || `after opening again the car page lost ${miss.join(", ") || `its place (${m.screen}, loading ${m.loading})`}`; }],
    ["file-kept", async (p) => { await p.click(".tabs [data-tab=file]"); await p.waitForSelector("#docList [data-docexp]", { state: "attached", timeout: 8000 }).catch(() => {}); await p.waitForTimeout(400); }, async (m, c) => {
      const k = await c.page.evaluate(() => ({ hist: (document.getElementById("cfHist") || {}).textContent || "", exp: (document.querySelector("#docList [data-docexp]") || {}).value || "", reading: /קוראים את התאריך/.test((document.getElementById("docList") || {}).textContent || "") }));
      const miss = [/בלמים/.test(k.hist) ? "" : "the service", k.hist.includes(KEEP.cost.toLocaleString("he-IL")) ? "" : "its cost", k.hist.includes(KEEP.km.toLocaleString("he-IL")) ? "" : "the km reading", k.exp === KEEP.ins ? "" : `the policy's expiry (${k.exp || "none"})`, k.reading ? "a date still being read" : ""].filter(Boolean);
      return !miss.length || `after opening again the file lost ${miss.join(", ")}`; }],
    ["settings-kept", async (p) => { await nav("search")(p); await tap("#openSettings, #bnSet")(p); }, async (m, c) => {
      const k = await c.page.evaluate(() => ({ dark: (document.querySelector('[data-theme-choice="dark"]') || { getAttribute: () => "" }).getAttribute("aria-pressed"), kml: (document.querySelector('[data-unit="kml"]') || { getAttribute: () => "" }).getAttribute("aria-pressed"), fuel: (document.getElementById("fuelPrice") || {}).value }));
      const miss = [k.dark === "true" ? "" : "the dark look", k.kml === "true" ? "" : "km per litre", k.fuel === KEEP.fuel ? "" : `the petrol price (${k.fuel || "empty"})`].filter(Boolean);
      return m.sheet === "settings" && !miss.length || `after opening again settings lost ${miss.join(", ") || "its sheet"}`; }],
    ["alerts-kept", async (p) => { await p.click("#closeSettings"); await nav("alerts")(p); }, async (m, c) => {
      if (!c.app) return m.screen === "alerts" || `alerts: ${m.screen}`;
      const k = await c.page.evaluate(() => ({ kind: (document.querySelector('#out [data-kind="service"]') || {}).checked, bell: (document.querySelector('#out [data-bell="1234567"]') || { getAttribute: () => "" }).getAttribute("aria-checked") }));
      const miss = [k.kind === false ? "" : "the service reminders switched off", k.bell === "false" ? "" : "the car's alerts switched off"].filter(Boolean);
      return m.screen === "alerts" && !miss.length || `after opening again התראות lost ${miss.join(", ") || "its screen"}`; }],
  ] },
  { name: "offline", once: true, steps: [
    ["go-offline", async (p, c) => { c.net.offline = true; await c.ctx.setOffline(true); }, null],
    // a car not looked up in this session (one checked earlier is kept in memory and is shown, rightly, without the network)
    ["check", check("7654321"), (m) => /אין חיבור לאינטרנט/.test(m.msg) && !m.loading || `offline check should say there is no connection, got "${m.msg.slice(0, 60)}" on ${m.screen}`],
    ["cars", nav("cars"), (m) => m.screen === "cars" || "cars"],
    ["search", nav("search"), (m) => m.screen === "home" && !/אין חיבור/.test(m.msg) || `search after an offline error: ${m.screen} "${m.msg.slice(0, 40)}"`],
    ["online", async (p, c) => { c.net.offline = false; await c.ctx.setOffline(false); }, null],
    ["check-again", check("7654321"), isCar("7654321")],
  ] },
  { name: "registry-500", once: true, gov: "500", steps: [
    ["check", check(), (m) => m.msg.length > 10 && !m.loading || `a registry error should show a message, got "${m.msg}" on ${m.screen}`],
    ["alerts", nav("alerts"), (m) => m.screen === "alerts" || "alerts"],
  ] },
  // a slow registry: the slow note shows, and leaving mid-check leaves nothing half-done behind
  { name: "slow-leave", once: true, gov: "slow", steps: [
    ["check", async (p, c) => { await p.click('#bnav [data-nav="search"]').catch(() => {}); await p.fill("#plate", c.plate); await p.press("#plate", "Enter"); await p.waitForTimeout(5600); }, (m) => m.loading || `a slow check should still show its progress, got ${m.screen} "${m.msg.slice(0, 40)}"`],
    ["cars", nav("cars"), (m) => m.screen === "cars" && !m.loading || `leaving a slow check for הרכבים שלי: ${m.screen}, loading ${m.loading}`],
    ["search", nav("search"), (m) => m.screen === "home" && !m.loading && m.home || `back to search after leaving a slow check: ${m.screen}, loading ${m.loading}`],
  ] },
  // web: the browser's Back walks back through the screens and never needs a dead press
  { name: "back-chain", web: true, steps: [
    ["check", check(), isCar()],
    ["specs", tap(".tabs [data-tab=specs]"), (m) => m.screen === "car" || "specs"],
    ["cars", nav("cars"), (m) => m.screen === "cars" || "cars"],
    ["back-1", back, (m) => m.screen === "car" || `Back from cars: ${m.screen}`],
    ["back-2", back, (m) => m.screen === "car" || m.screen === "home" || `Back from specs: ${m.screen}`],
    ["back-3", back, (m) => m.screen === "home" || m.screen === "car" || `Back: ${m.screen}`],
  ] },
  // web: "הרכבים שלי" and "התראות" have their own address and tab title, so a reload or a bookmark opens them again; Back still leads home
  { name: "reload", web: true, steps: [
    ["cars", nav("cars"), (m) => m.screen === "cars" && /#cars$/.test(m.url) && m.docTitle.startsWith("הרכבים שלי") || `הרכבים שלי should have its own address and title, got ${m.url} "${m.docTitle}"`],
    ["reload-cars", async (p) => { await p.reload(); await p.waitForSelector("#carsHead", { timeout: 8000 }); }, (m) => m.screen === "cars" || `a reload of הרכבים שלי should keep it, got ${m.screen}`],
    ["alerts", nav("alerts"), (m) => m.screen === "alerts" && /#alerts$/.test(m.url) && m.docTitle.startsWith("התראות") || `התראות should have its own address and title, got ${m.url} "${m.docTitle}"`],
    ["reload-alerts", async (p) => { await p.reload(); await p.waitForSelector("#alertsHead", { timeout: 8000 }); }, (m) => m.screen === "alerts" || `a reload of התראות should keep it, got ${m.screen}`],
    ["back", back, (m) => m.screen === "home" && m.home || `Back after a reload of התראות should lead home, got ${m.screen}`],
  ] },
  // a tablet turned on its side (and back) while on a car page
  { name: "rotate", when: (c) => c.dev.w >= 600 && c.dev.w < 1100, steps: [
    ["check", check(), isCar()],
    ["turn", async (p, c) => { await p.setViewportSize({ width: c.dev.h, height: c.dev.w }); }, (m) => m.screen === "car" || "rotate"],
    ["cars", nav("cars"), (m) => m.screen === "cars" || "cars"],
    ["turn-back", async (p, c) => { await p.setViewportSize({ width: c.dev.w, height: c.dev.h }); }, (m) => m.screen === "cars" || "rotate back"],
  ] },
  // app: the ways the app hands the page something (here the browser stands in for MainActivity; app-real.cjs sends the same through
  // Android on an emulator): a tapped alert opens its car on the tab its kind belongs to, the launcher shortcuts, an ad shared into the
  // app (its price, mileage and phone number are not the plate), the voice search, an update offer
  // (in the owner's state: 1234567 is the user's own car, with its file; 7654321 is someone else's car the user follows)
  { name: "from-app", app: true, only: "owner", steps: [
    ["alert-recall", async (p) => { await p.evaluate(() => window.openAlert("1234567", "recall")); await settle(p); }, (m) => m.screen === "car" && m.carPlate === "1234567" && m.tab === "recalls" || `a tapped recall alert should open 1234567 on its recalls tab, got ${m.screen} ${m.carPlate} tab ${m.tab}`],
    ["alert-test", async (p) => { await p.evaluate(() => window.openAlert("1234567", "test")); await settle(p); }, (m) => m.screen === "car" && m.carPlate === "1234567" && m.tab === "file" || `a tapped test alert should open the user's own car in its file, got ${m.screen} ${m.carPlate} tab ${m.tab}`],
    ["alert-test-other", async (p) => { await p.evaluate(() => window.openAlert("7654321", "test")); await settle(p); }, (m) => m.screen === "car" && m.carPlate === "7654321" && m.tab === "overview" || `a tapped test alert of a car without a file should open its overview, got ${m.screen} ${m.carPlate} tab ${m.tab}`],
    ["alert-owner", async (p) => { await p.evaluate(() => window.openAlert("1234567", "owner")); await settle(p); }, (m) => m.screen === "car" && m.carPlate === "1234567" && m.tab === "overview" || `a tapped owner alert should open 1234567 on its overview, got ${m.screen} ${m.carPlate} tab ${m.tab}`],
    ["shortcut-saved", (p) => p.evaluate(() => window.appAction("saved")), (m) => m.screen === "cars" && !m.sheet || `the shortcut הרכבים שלי should open הרכבים שלי, got ${m.screen} ${m.sheet || ""}`],
    ["shortcut-compare", (p) => p.evaluate(() => window.appAction("compare")), (m) => /compare/i.test(m.sheet || "") || m.screen === "sub" || `the shortcut השוואה should open the comparison, got ${m.screen} ${m.sheet || ""}`],
    ["compare-back", back, (m) => !/compare/i.test(m.sheet || "") && m.screen !== "sub" || `Back should close the comparison the shortcut opened, got ${m.screen} ${m.sheet || ""}`],
    ["compare-link", async (p) => { await p.evaluate(() => window.loadCompareLink("1234567,7654321")); await p.waitForTimeout(600); }, (m) => m.screen === "sub" || `a luchit.app comparison link should open the comparison of both cars, got ${m.screen} ${m.sheet || ""}`],
    ["compare-link-back", back, (m) => m.screen !== "sub" || `Back should leave the comparison a link opened, got ${m.screen}`],
    ["shared-ad", async (p) => { await p.evaluate(() => window.onSharedText('למכירה טויוטה קורולה 2021, 66,000 ק"מ, 89,000 ₪. טלפון 050-0000000. מספר רכב 12-345-67')); await settle(p); }, (m) => m.screen === "car" && m.carPlate === "1234567" || `an ad shared into the app should check its plate 12-345-67 (not the phone, the price or the mileage), got ${m.screen} ${m.carPlate}`],
    ["shared-none", (p) => p.evaluate(() => window.onSharedText("נתראה מחר בשמונה")), (m) => m.screen === "home" && !m.carOn || `a shared text without a plate should lead home with a note, got ${m.screen}`],
    ["voice", async (p) => { await p.evaluate(() => window.onVoiceResult("שבע שש חמש ארבע שלוש שתיים אחת")); await settle(p); }, (m) => m.screen === "car" && m.carPlate === "7654321" || `the voice search heard 7654321 and should check it, got ${m.screen} ${m.carPlate}`],
    ["update", (p) => p.evaluate(() => { try { localStorage.removeItem("updAsked"); } catch {} window.onUpdateState("available"); }), (m) => /גרסה חדשה/.test(m.snack) || `an available update should be offered on the snack bar, got "${m.snack}"`],
    ["home", nav("search"), (m) => m.screen === "home" && m.home || `home: ${m.screen}`],
  ] },
  // app: the keyboard (the app resizes the page above it, as adjustResize does): the plate field and its button stay in view, the
  // bottom bar steps aside, and the car is checked from the keyboard's own key. app-real.cjs opens the phone's real keyboard
  { name: "keyboard", app: true, once: true, steps: [
    ["open", async (p, c) => { await p.click("#plate"); await p.setViewportSize({ width: c.dev.w, height: c.dev.h - Math.round(c.dev.h * 0.42) }); await p.evaluate(() => { const a = document.activeElement; if (a && a.scrollIntoViewIfNeeded) a.scrollIntoViewIfNeeded(false); }); }, (m, c) => kbView(c)],
    ["type", async (p, c) => { await p.fill("#plate", c.plate); }, (m, c) => kbView(c)],
    // Back closes only the keyboard and the field keeps its focus: the bottom bar comes back with the full screen, and steps aside again
    // when the field is tapped and the keyboard opens once more
    ["kb-back", async (p, c) => { await p.setViewportSize({ width: c.dev.w, height: c.dev.h }); await p.waitForTimeout(150); }, (m) => !!m.nav && m.focus === "plate" || `after Back closed the keyboard (the field still focused: ${m.focus}) the bottom bar should be back, ${m.nav ? "it is" : "it is not"}`],
    ["kb-again", async (p, c) => { await p.click("#plate"); await p.setViewportSize({ width: c.dev.w, height: c.dev.h - Math.round(c.dev.h * 0.42) }); await p.waitForTimeout(150); }, (m, c) => kbView(c)],
    ["check", async (p, c) => { await p.press("#plate", "Enter"); await p.setViewportSize({ width: c.dev.w, height: c.dev.h }); await p.evaluate(() => document.activeElement && document.activeElement.blur()); await settle(p); }, isCar()],
    ["bar-back", null, (m) => !!m.nav || "the bottom bar did not come back after the keyboard closed"],
  ] },
  // the website on an iPad on its side: the bar is at the top and holds a plate field on a car; typing in it keeps the bar (and the field)
  // on screen, a touch screen or not
  { name: "bar-field", web: true, once: true, devOnly: true, steps: [
    ["check", check(), isCar()],
    ["bar-field", async (p) => { await p.click("#bnPlate"); await p.waitForTimeout(150); }, (m) => !!m.nav && m.focus === "bnPlate" || `typing in the top bar's plate field hides the bar with the field in it (bar ${m.nav ? "shown" : "hidden"}, focus ${m.focus})`],
    ["bar-check", async (p) => { await p.fill("#bnPlate", "7654321"); await p.press("#bnPlate", "Enter"); await settle(p); }, isCar("7654321")],
  ] },
];
// the keyboard is open: the field has the focus and is in view with its button, and the bottom bar is out of the way
const kbView = async (c) => {
  const k = await c.page.evaluate(() => { const r = (id) => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom)]; }; const n = document.getElementById("bnav"), on = n && getComputedStyle(n).display !== "none"; return { h: innerHeight, plate: r("plate"), go: r("go"), nav: on ? Math.round(n.getBoundingClientRect().top) : null, focus: document.activeElement && document.activeElement.id }; });
  if (k.focus !== "plate") return `the plate field lost the focus when the keyboard opened (focus ${k.focus})`;
  if (!k.plate || k.plate[0] < 0 || k.plate[1] > k.h) return `the plate field is not in view above the keyboard (field ${k.plate}, visible height ${k.h})`;
  if (!k.go || k.go[0] < 0 || k.go[1] > k.h) return `the check button is not in view above the keyboard (button ${k.go}, visible height ${k.h})`;
  if (k.nav !== null) return k.nav < k.go[1] ? `the bottom bar rides up over the plate field with the keyboard open (bar top ${k.nav}, button bottom ${k.go[1]})` : `the bottom bar rides on top of the keyboard instead of stepping aside while typing (bar top ${k.nav}, visible height ${k.h})`;
  return true;
};


// ---- the sweep: every control of a screen pressed one at a time, each in a fresh copy of the screen when the one before changed it.
// Something must happen: another screen, a sheet or menu, a toast, a section opening, the page changing, focus moving to something
// else, a stored setting, a share / copy / new window / call to the app, a question (confirm) or a download. A press that changes
// nothing is a dead control (warning); a page error is blocking; the layout is measured after every press and what the press itself
// broke is reported like a journey step. Links are not pressed: a link inside the site must lead to a file the site has.
const tabTo = (t) => async (p) => { const b = p.locator(`.tabs [data-tab=${t}]`); if (await b.count()) await b.click(); };
// every folded card and <details> of the screen opened, so the controls inside them are pressed too (the plain "car" keeps the screen as it opens)
const unfold = async (p) => { await p.evaluate(() => { for (const h of document.querySelectorAll("#out .head[data-fold][aria-expanded=false]")) h.click(); for (const d of document.querySelectorAll("#out details:not([open])")) d.open = true; }); await p.waitForTimeout(200); };
const SWEEP = [
  { name: "home", steps: [unfold] },
  { name: "car", steps: [check()] },
  ...["overview", "recalls", "buy", "file", "specs"].map((t) => ({ name: `car-${t}-open`, steps: [check(), tabTo(t), unfold] })),
  { name: "car-menu", steps: [check(), tap("#chead [data-act=cmenu]")] },
  { name: "cars", steps: [nav("cars"), unfold] },
  { name: "alerts", steps: [nav("alerts"), unfold] },
  { name: "settings", steps: [tap("#openSettings, #bnSet")] },
  // the frame: the plate field and its buttons (an empty field, paste, camera, voice), the bars and the footer
  { name: "frame", steps: [], roots: ".band, #savedBar, #bnav, body > footer" },
  { name: "frame-car", steps: [check()], roots: ".band, #bnav, body > footer" },
];
const SWEEP_RUNS = QUICK ? [["app-360", "one"], ["web-1280", "one"]]
  : [["app-360", "one"], ["app-360", "owner"], ["app-360", "empty"], ["web-390", "many"], ["web-1280", "one"], ["web-1280", "many"], ["web-1280", "owner"]];
// the controls of the screen, in the open sheet or menu when there is one; two of each kind (one car row of a list stands for all)
const controls = (page, sel) => page.evaluate((sel) => {
  const vis = (e) => { const b = e.getBoundingClientRect(), cs = getComputedStyle(e); return b.width > 0 && b.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0" && !e.closest("[hidden]") && !e.closest("details:not([open]) > :not(summary)"); };
  const pathOf = (e) => { const parts = []; for (let n = e; n && n !== document.body; n = n.parentElement) { if (n.id) { parts.unshift("#" + CSS.escape(n.id)); break; } const i = [...n.parentElement.children].filter((x) => x.tagName === n.tagName).indexOf(n) + 1; parts.unshift(`${n.tagName.toLowerCase()}:nth-of-type(${i})`); } return parts.join(" > "); };
  const label = (e) => (e.getAttribute("aria-label") || e.textContent || e.className || e.tagName).replace(/\s+/g, " ").trim().slice(0, 40);
  const pop = [...document.querySelectorAll(".sheet:not([hidden]), .doc-view, #roadSheet, .ch-menu")].filter(vis).pop();
  const roots = sel ? [...document.querySelectorAll(sel)] : pop ? [pop] : [document.getElementById("chead"), document.getElementById("out")].filter(Boolean);
  const kinds = {}, list = [], seen = new Set();
  for (const r of roots) for (const e of r.querySelectorAll("button, a[href], [role=tab], [role=button], summary, label:has(input[type=checkbox]), [data-act], [data-url], [data-open]")) {
    if (seen.has(e)) continue; seen.add(e);
    if (!vis(e) || e.disabled || e.getAttribute("aria-disabled") === "true" || e.getAttribute("aria-selected") === "true" || e.getAttribute("aria-current") || (e.getAttribute("aria-pressed") === "true" && e.closest(".seg, .vseg, [role=radiogroup]")) || e.closest(".sr-only")) continue;
    const kind = e.tagName + "." + [...e.classList].sort().join(".") + "[" + Object.keys(e.dataset).sort().join(",") + "]" + (e.dataset.act || e.dataset.tab || "");
    if ((kinds[kind] = (kinds[kind] || 0) + 1) > 2) continue;
    const href = e.tagName === "A" ? e.getAttribute("href") : null;
    list.push({ path: pathOf(e), label: label(e), href: href && !href.startsWith("#") ? href : null });
  }
  return list;
}, sel || null);
// what a press can change, in a few numbers
const signature = (page) => page.evaluate(() => {
  const h = (t) => { let x = 0; for (let i = 0; i < t.length; i++) x = (x * 31 + t.charCodeAt(i)) | 0; return x; };
  const vis = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const pathOf = (e) => { const parts = []; for (let n = e; n && n !== document.body; n = n.parentElement) { if (n.id) { parts.unshift("#" + CSS.escape(n.id)); break; } const i = [...n.parentElement.children].filter((x) => x.tagName === n.tagName).indexOf(n) + 1; parts.unshift(`${n.tagName.toLowerCase()}:nth-of-type(${i})`); } return parts.join(" > "); };
  let ls = ""; try { ls = JSON.stringify(Object.entries(localStorage).sort()); } catch {}
  const a = document.activeElement;
  return {
    screen: document.body.dataset.screen, url: location.href, pop: [...document.querySelectorAll(".sheet:not([hidden]), .doc-view, #roadSheet, .ch-menu, [role=dialog]:not([hidden])")].filter(vis).map((e) => e.id || e.className).join(","),
    page: h(((document.getElementById("out") || {}).innerHTML || "") + ((document.getElementById("chead") || {}).innerHTML || "")),
    open: document.querySelectorAll("details[open], [aria-expanded=true], [aria-pressed=true], [aria-checked=true], input:checked").length,
    toast: [...document.querySelectorAll(".toast, #snack")].filter(vis).map((e) => e.textContent).join("|"), fx: window.__fx || 0, ls: h(ls),
    said: h([...document.querySelectorAll("[role=status], [aria-live]")].map((e) => e.textContent).join("|")),   // a line like "אין מה להדביק" under the field
    y: Math.round(scrollY), theme: document.documentElement.className + "/" + (document.documentElement.dataset.theme || ""), focus: a && a !== document.body ? pathOf(a) : "",
  };
});

// Safari's engine reports a load it could not finish (the network switched off, a check left half way) as a page error whose text ends
// "due to access control checks": that is the network, not the page's code, and each journey's own rules judge what the person then
// sees. An exception the page throws still blocks
const pageErr = (run, at) => (e) => {
  if (ENGINE === "webkit" && /due to access control checks\.?$/.test(e.message)) { tally.cut++; return; }
  add("block", "error", run, at(), "page error: " + e.message.slice(0, 160));
};
// a browser context for one run: the network mocked (the registry answers from RECS), the data state in localStorage, the app's bridge
// in the app; window.__fx counts what a press can do outside the page (a share, a copy, a new window, a call to the app)
async function openCtx(browser, dev, theme, stateName, J) {
  const app = dev.ua === "app";
  // in Safari's engine a page the service worker controls sends its requests past Playwright's routes, so from the worker's first
  // claim the registry mock was gone and every lookup went to the real network (26.10, 3,135 findings): there the worker is left out
  const opts = { viewport: { width: dev.w, height: dev.h }, deviceScaleFactor: 1, isMobile: dev.mobile ?? dev.w < 900, hasTouch: dev.touch ?? dev.w < 900, colorScheme: theme, locale: "he-IL", userAgent: UA[dev.ua], ...(ENGINE === "webkit" ? { serviceWorkers: "block" } : {}) };
  let ctx;
  if (ENGINE === "webkit") {   // a profile on disk, as Safari has (see the top of this file), removed when the run closes it
    const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "uf-webkit-"));
    ctx = await require("playwright").webkit.launchPersistentContext(dir, opts);
    const close = ctx.close.bind(ctx); ctx.close = async () => { await close(); fs.rmSync(dir, { recursive: true, force: true }); };
  } else ctx = await browser.newContext(opts);
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
  const net = { offline: false };   // a mocked answer would still arrive with the context offline, so the mock stops answering too
  await ctx.route(/data\.gov\.il/, (r) => (net.offline ? r.abort("internetdisconnected") : govRoute(r, J && J.gov)));
  await ctx.addInitScript(({ ls, app, bridge, quiet }) => {
    // the data state is laid down on the context's first page only (a cookie marks it), so a reload keeps what a journey stored; null takes a key out
    try { if (!/(?:^|; )uf_seeded=1/.test(document.cookie)) { localStorage.setItem("analyticsOff", "1"); for (const [k, v] of Object.entries(ls)) v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); document.cookie = "uf_seeded=1; path=/"; } } catch {}
    // every toast the page shows, for told(): the page clears each one after 2.2 s
    window.__toasts = [];
    document.addEventListener("DOMContentLoaded", () => { const t = document.getElementById("toast"); if (t) new MutationObserver(() => { const s = t.textContent.trim(); if (s && window.__toasts[window.__toasts.length - 1] !== s) window.__toasts.push(s); }).observe(t, { childList: true, characterData: true, subtree: true }); });
    window.__fx = 0; const fx = () => { window.__fx++; };
    window.__calls = [];
    if (app) window.AndroidApp = Object.fromEntries(bridge.map((n) => [n, (...a) => { window.__calls.push(n); if (!quiet.includes(n)) fx(); return n === "alertsState" ? "on" : n === "readClipboard" ? "" : n === "systemDark" ? matchMedia("(prefers-color-scheme: dark)").matches : undefined; }]));
    try { window.open = () => { fx(); return null; }; window.print = fx; } catch {}
    try { if (navigator.clipboard) navigator.clipboard.writeText = async () => { fx(); }; } catch {}
    try { if (navigator.share) { navigator.share = async () => { fx(); }; } } catch {}
    window.__cls = { v: 0, src: [] };
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__cls.v += e.value; window.__cls.src.push((e.sources || []).map((s) => s.node && (s.node.id || s.node.className || s.node.nodeName)).join("|").slice(0, 80)); } }).observe({ type: "layout-shift", buffered: true }); } catch {}
  }, { ls: { theme, homeSheet: "1", ...STATES[stateName], ...((J && J.ls) || {}) }, app, bridge: BRIDGE, quiet: QUIET_BRIDGE });
  return { ctx, net, app };
}
// why a step could not act: what lay over the control (Playwright names it), an open sheet or menu, the bottom bar stepped aside for the keyboard
const underOf = (msg) => { const l = (String(msg).match(/<[^\n]*?> intercepts pointer events/) || [])[0]; if (!l) return ""; const t = (l.match(/^<([a-z0-9-]+)/i) || [])[1] || "", id = (l.match(/\sid="([^"]+)"/) || [])[1], cl = (l.match(/\sclass="([^"]+)"/) || [])[1]; return t + (id ? "#" + id : cl ? "." + cl.split(" ")[0] : ""); };
// Playwright's own last word on the control, from its call log: never on screen, not visible, not stable, outside the viewport
const lastWord = (msg) => {
  const lines = String(msg).replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((s) => s.trim().replace(/^-\s*/, "").replace(/^\d+ × /, ""));
  if (!lines.some((s) => s.startsWith("locator resolved to")) && lines.some((s) => s.startsWith("waiting for locator"))) return "no such control on the screen";
  return [...lines].reverse().find((s) => /^element is /.test(s)) || "";
};
const whyNot = async (page, e) => {
  const under = underOf(e.message), said = !under && lastWord(e.message), s = await page.evaluate(() => ({ open: [...document.querySelectorAll(".sheet:not([hidden]), .doc-view, .ch-menu")].filter((x) => x.getClientRects().length).map((x) => x.id ? "#" + x.id : "." + x.className.split(" ")[0]), kb: document.body.classList.contains("kb") })).catch(() => ({ open: [], kb: false }));
  return [under && `under ${under}`, said, s.open.length && `open: ${s.open.join(", ")}`, s.kb && "the bottom bar stepped aside for the keyboard"].filter(Boolean).join("; ");
};

async function runJourney(browser, dev, theme, stateName, J) {
  const run = `${J.name}/${stateName}/${dev.id}/${theme}`;
  const { ctx, net, app } = await openCtx(browser, dev, theme, stateName, J);
  const page = await ctx.newPage();
  let step = "load";
  page.on("pageerror", pageErr(run, () => step));
  // the page's console errors, told with a step that failed (a load the test network refused is not one)
  const said = []; page.on("console", (msg) => { if (msg.type() === "error" && !/Failed to load resource/.test(msg.text())) said.push(msg.text().replace(/\s+/g, " ").slice(0, 120)); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector("#homeMark", { state: "attached", timeout: 15000 }).catch(() => add("block", "logic", run, step, "home did not render"));
  await page.addStyleTag({ content: "*{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}" });
  const c = { dev, theme, state: stateName, app, ctx, net, page, plate: stateName === "many" ? "7654321" : "1234567" };
  const seen = [];   // per step: {step, screen, nav, col, vw}
  let prev = null;
  for (const [name, act, expect] of J.steps) {
    step = name;
    await page.evaluate(() => { window.__cls.v = 0; window.__cls.src = []; window.__toasts = []; });
    const said0 = said.length, also = () => (said.length > said0 ? ` (console: ${said.slice(said0, said0 + 2).join(" · ")})` : "");
    if (act) { try { await act(page, c); } catch (e) { const why = await whyNot(page, e); add("block", "logic", run, step, "could not act: " + e.message.split("\n")[0].slice(0, 120) + (why ? ` [${why}]` : "") + also()); } }
    // layout shift is counted from two frames after the step's own redraw: a new screen in place of the old one is not a shift, what moves after it is
    await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => { window.__cls.v = 0; window.__cls.src = []; ok(); })))).catch(() => {});
    await page.waitForTimeout(450);
    let m; try { m = await measure(page); } catch (e) { add("block", "error", run, step, "measure failed: " + e.message.slice(0, 100)); continue; }
    let ok = expect ? await expect(m, c) : true;
    if (ok && ok.warn) { add("warn", "logic", run, step, ok.warn); ok = true; }
    if (ok !== true) add("block", "logic", run, step, ok + also());
    if (m.cls > 0.1) add("warn", "cls", run, step, `layout shift ${m.cls.toFixed(2)} on ${m.screen}: ${(await page.evaluate(() => window.__cls.src.slice(0, 4).join(" ; ")))}`);
    judgeStep(run, step, m, { app });
    if (ok === true && act === back && prev && ["screen", "sheet", "url", "carPlate", "msg", "tab"].every((k) => prev[k] === m[k]) && !(m.screen === "home" && m.home)) add("block", "logic", run, step, `Back did nothing on ${m.screen} (a dead press)`);
    prev = m;
    seen.push({ step: name, screen: m.screen, sheet: m.sheet, nav: m.nav, col: m.col, title: m.title, y: m.y, vw: m.vw });
    if (SHOTS) await page.screenshot({ path: path.join(OUT, "shots", `${run.replace(/\//g, "__")}__${name}.png`) }).catch(() => {});
  }
  judgeRun(run, seen, dev.w);
  await ctx.close();
}

// what one measured step must hold, wherever it ran (o.app: the Android app, which has no website frame)
function judgeStep(run, step, m, o) {
  const app = o.app;
  // o.large: the phone's largest font sizes (app-real.cjs, 175% and up), where a label on two lines, a control on a row of its own and a
  // row of uneven heights are the layout making room for the text (WCAG 1.4.4), not faults; text cut off, overlaps and anything past
  // the screen edge still are
  const reflowOk = !!o.large;
  if (m.over > 0) add("block", "overflow", run, step, `page scrolls sideways by ${m.over}px on ${m.screen}`);
  if (m.outside.length) add("block", "outside", run, step, `past the screen edge on ${m.screen}: ${m.outside.join(" · ")}`);
  if (m.wraps.length && !reflowOk) add(o.wrapSev || "warn", "wrap", run, step, `label on two lines on ${m.screen}: ${m.wraps.join(" · ")}`);
  if (m.overlaps.length) add("warn", "overlap", run, step, `controls overlap on ${m.screen}: ${m.overlaps.join(" · ")}`);
  if (m.clipped.length) add("warn", "clip", run, step, `text cut off on ${m.screen}: ${m.clipped.join(" · ")}`);
  if (m.twice.length) add("warn", "twice", run, step, `the same car is offered twice on ${m.screen}: ${m.twice.length} plates`);
  if (m.orphans.length && !reflowOk) add("warn", "orphan", run, step, `a control dropped to a line of its own on ${m.screen}: ${m.orphans.join(" · ")}`);
  if (m.bleed.length) add("warn", "bleed", run, step, `wider than the content column on ${m.screen}: ${m.bleed.join(" · ")}`);
  if (m.ragged.length && !reflowOk) add("warn", "ragged", run, step, `one row, different heights on ${m.screen}: ${m.ragged.join(" · ")}`);
  if (m.covered) add("warn", "covered", run, step, `the bottom bar covers "${m.covered}" at the end of ${m.screen}`);
  if (!m.sheet && m.nav && ({ home: "search", cars: "cars", alerts: "alerts" })[m.screen] && m.navCur !== ({ home: "search", cars: "cars", alerts: "alerts" })[m.screen]) add("block", "logic", run, step, `the bar highlights "${m.navCur}" on the ${m.screen} screen`);
  // the website's frame (blocking): a footer under every screen; on a wide screen no button floats over the list (compare sits in the
  // title row) and share and save carry their words
  const vw = m.vw, innerH = m.vh;   // the viewport now, not the device's first one: "rotate" turns a 1024 tablet to 768 wide
  if (!app && !m.sheet && !m.loading && ["home", "car", "cars", "alerts", "sub"].includes(m.screen) && !m.footer) add("block", "frame", run, step, `the website's footer is missing on ${m.screen}`);
  if (!app && vw >= 1000 && m.screen === "cars" && m.fab) add("block", "frame", run, step, "a floating compare button over the list on a wide screen (it belongs in the title row)");
  // a phone's bottom bar is one row of three tabs: anything more (the wide bar's gear, its search) makes it grow over the page
  if (vw < 1000 && m.nav && m.nav.bar[1] > innerH / 2 && m.nav.bar[3] > (o.barMax || 80)) add("block", "frame", run, step, `the bottom bar grew to ${m.nav.bar[3]}px on ${m.screen} (one row of three tabs is about 66px)`);
  if (!app && vw >= 1000 && m.screen === "car" && m.carOn && !m.sheet && !m.chLabels) add("block", "frame", run, step, "the wide car header shows share and save as bare icons");
}

// what a whole journey must hold: seen = one entry per step {step, screen, sheet, nav, col, title, y, vw}; w = the device's own width
function judgeRun(run, seen, w) {
  // the navigation bar is the frame of every screen: same place, same size, same items, whatever screen is drawn
  for (const vw of new Set(seen.map((s) => s.vw))) {
    const withNav = seen.filter((s) => s.nav && !s.sheet && s.vw === vw);
    if (withNav.length < 2) continue;
    const ref = withNav[0];
    for (const s of withNav.slice(1)) {
      const k = (n) => JSON.stringify([n.bar, n.inner, n.items]);
      if (k(s.nav) !== k(ref.nav)) {
        // each moved item with its place on both screens (name:x,y,w,h), so the finding says where the bar was and where it went
        const was = (x) => (ref.nav.items.find((r) => r.split(":")[0] === x.split(":")[0]) || "-:none").split(":").slice(1).join(":");
        const diff = s.nav.items.filter((x) => !ref.nav.items.includes(x)).map((x) => `${x.split(":")[0]} ${was(x)} → ${x.split(":").slice(1).join(":")}`)
          .concat(JSON.stringify(s.nav.bar) !== JSON.stringify(ref.nav.bar) ? [`bar ${ref.nav.bar} → ${s.nav.bar}`] : [], JSON.stringify(s.nav.inner) !== JSON.stringify(ref.nav.inner) ? [`frame ${ref.nav.inner} → ${s.nav.inner}`] : []);
        add("block", "nav-moved", run, s.step, `the navigation bar moved between ${ref.screen} (${ref.step}) and ${s.screen}: ${diff.slice(0, 3).join(" · ")}`);
      }
    }
  }
  // the screen titles of the tabs ("הרכבים שלי", "התראות"): same place and size on both, like the bar
  for (const vw of new Set(seen.map((s) => s.vw))) {
    const ts = seen.filter((s) => s.vw === vw && s.title && s.title.kind === "vhead" && !s.sheet), ref = ts[0];
    for (const s of ts.slice(1)) if (s.screen !== ref.screen && (Math.abs(s.title.r[1] - ref.title.r[1]) > 2 || s.title.fs !== ref.title.fs || (w < 700 && Math.abs((s.title.r[0] + s.title.r[2]) - (ref.title.r[0] + ref.title.r[2])) > 2)))
      add("warn", "title-moved", run, s.step, `the screen title moves between ${ref.screen} and ${s.screen}: ${JSON.stringify(ref.title.r)} ${ref.title.fs} → ${JSON.stringify(s.title.r)} ${s.title.fs}`);
  }
  // the content column: 680px for one column and 1080px beside a list or a rail are the design, but every screen keeps one centre line
  const cols = {}; for (const s of seen) if (s.col && !s.sheet && s.vw === w) cols[s.screen] = cols[s.screen] || s.col;
  const ws = Object.entries(cols).map(([k, v]) => [k, v[0], v[2]]);
  if (w >= 768 && ws.length > 1 && Math.max(...ws.map((x) => x[1] + x[2] / 2)) - Math.min(...ws.map((x) => x[1] + x[2] / 2)) > 2) add("warn", "column", run, "-", `the content column is off the centre line on one screen: ${ws.map((x) => `${x[0]} x=${x[1]} w=${x[2]}`).join(" · ")}`);
}

const tally = { pressed: 0, links: 0, cut: 0 };   // for the closing line: how much the sweep pressed and checked, the loads Safari's engine saw cut
async function runSweep(browser, dev, stateName, S) {
  const run = `sweep:${S.name}/${stateName}/${dev.id}`;
  let ctx = null, page = null, step = "load", base = null, asked = 0, saved = 0, opened = 0;
  // a new context each time: what a press stored (a car saved, a file opened) must not change the next copy of the screen
  const fresh = async () => {
    if (ctx) await ctx.close().catch(() => {});
    const o = await openCtx(browser, dev, "light", stateName, S), { net, app } = o; ctx = o.ctx;
    page = await ctx.newPage();
    page.on("pageerror", pageErr(run, () => step));
    page.on("dialog", (d) => { asked++; d.dismiss().catch(() => {}); });
    page.on("download", () => { saved++; });
    page.on("popup", (p) => { opened++; p.close().catch(() => {}); });
    page.on("filechooser", () => { opened++; });   // "צילום לוחית", "הוספת מסמך": the phone's picker opens
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector("#homeMark", { state: "attached", timeout: 15000 });
    await page.addStyleTag({ content: "*{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}" });
    const c = { dev, theme: "light", state: stateName, app, ctx, net, page, plate: stateName === "many" ? "7654321" : "1234567" };
    for (const act of S.steps) await act(page, c);
    await page.waitForTimeout(300);
    base = await measure(page);
  };
  try { await fresh(); } catch (e) { add("block", "logic", run, step, "could not reach the screen: " + e.message.split("\n")[0].slice(0, 120)); if (ctx) await ctx.close(); return; }
  const list = await controls(page, S.roots);
  if (process.env.UF_DEBUG) console.log(`  ${run}: ${list.length} controls`);
  let dirty = false, n = 0;
  for (const ctl of list) {
    step = `press "${ctl.label}"`;
    if (ctl.href) {
      if (!/^[a-z][a-z0-9+.-]*:/i.test(ctl.href) || ctl.href.startsWith(`http://127.0.0.1:${server.address().port}`)) {
        const u = new URL(ctl.href, `http://127.0.0.1:${server.address().port}/`), f = path.join(ROOT, decodeURIComponent(u.pathname));
        tally.links++;
        if (u.pathname !== "/" && !fs.existsSync(f) && !fs.existsSync(f + ".html") && !fs.existsSync(path.join(f, "index.html"))) add("warn", "link", run, step, `a link on ${S.name} to a page the site does not have: ${ctl.href}`);
      }
      continue;
    }
    if (dirty) { try { await fresh(); } catch { continue; } dirty = false; }
    const loc = page.locator(ctl.path).first();
    if (!(await loc.count()) || !(await loc.isVisible().catch(() => false))) { if (process.env.UF_DEBUG) console.log(`  ${run} ${step}: not found on a fresh copy`); continue; }
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    const b = await signature(page); asked = 0; saved = 0; opened = 0;
    try { await loc.click({ timeout: 2500 }); }
    catch (e) { const m = /<([a-z]+)[^>]*?(?:class="([^"]*)"|id="([^"]*)")?[^>]*> intercepts pointer events/.exec(e.message); add("warn", "covered", run, step, `"${ctl.label}" on ${S.name} could not be pressed: ${m ? `under ${m[1]}${m[3] ? "#" + m[3] : m[2] ? "." + m[2].split(" ")[0] : ""}` : e.message.split("\n")[0].slice(0, 80)}`); dirty = true; continue; }
    n++; tally.pressed++;
    if (process.env.UF_DEBUG) console.log(`  ${run} ${step}`);
    await page.waitForTimeout(400);
    let a; try { a = await signature(page); } catch { dirty = true; continue; }   // the press left the page
    const moved = Object.keys(b).filter((k) => k !== "focus" && b[k] !== a[k]);
    if (!moved.length && !(a.focus !== b.focus && a.focus !== ctl.path) && !asked && !saved && !opened) add("warn", "dead", run, step, `pressing "${ctl.label}" on ${S.name} changes nothing`);
    // what the press itself broke (problems that were not on the screen before it)
    let m; try { m = await measure(page); } catch { dirty = true; continue; }
    const fresh1 = (k) => (m[k] || []).filter((x) => !(base[k] || []).includes(x));
    if (m.over > 0 && !(base.over > 0)) add("block", "overflow", run, step, `page scrolls sideways by ${m.over}px after pressing "${ctl.label}" on ${S.name}`);
    if (fresh1("outside").length) add("block", "outside", run, step, `past the screen edge after pressing "${ctl.label}" on ${S.name}: ${fresh1("outside").join(" · ")}`);
    for (const [k, word] of [["overlaps", "controls overlap"], ["wraps", "label on two lines"], ["clipped", "text cut off"], ["orphans", "a control on a line of its own"], ["bleed", "wider than the content column"]])
      if (fresh1(k).length) add("warn", { overlaps: "overlap", wraps: "wrap", clipped: "clip", orphans: "orphan", bleed: "bleed" }[k], run, step, `${word} after pressing "${ctl.label}" on ${S.name}: ${fresh1(k).join(" · ")}`);
    if (["screen", "url", "pop", "page", "ls", "theme"].some((k) => b[k] !== a[k]) || opened) dirty = true; else base = m;   // a problem is told once, by the press that made it
  }
  if (!n && list.some((x) => !x.href)) add("warn", "logic", run, "-", `no control on ${S.name} could be pressed`);
  await ctx.close();
}

module.exports = { findings, add, measure, judgeStep, judgeRun, govRoute, JOURNEYS, STATES, RECS, UA, BRIDGE, QUIET_BRIDGE, nav, tap, tapIf, check, settle, isCar, back };

if (require.main === module) (async () => {
  const engine = require("playwright")[ENGINE];
  if (!engine || !["chromium", "webkit"].includes(ENGINE)) { console.error(`ui-flows: --engine is chromium or webkit, not ${ENGINE}`); process.exit(2); }
  fs.mkdirSync(path.join(OUT, "shots"), { recursive: true });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const browser = await engine.launch();
  const jobs = [];
  for (const dev of DEVICES) for (const th of THEMES) for (const st of Object.keys(STATES)) for (const J of JOURNEYS) {
    if (J.when && !J.when({ state: st, dev })) continue;
    // a journey made for one state runs in it alone; error paths once per device and theme; the owner's state walks the tour
    if (J.only ? st !== J.only : (J.once && st !== "one") || (st === "owner" && J.name !== "tour")) continue;
    if (J.web && dev.ua === "app") continue;
    if (J.app && dev.ua !== "app") continue;
    if (dev.only ? !dev.only.includes(J.name) : J.devOnly) continue;   // a device for one journey, a journey for its own device
    if (th === "dark" && !/^(tour|check|saved|owner)$/.test(J.name)) continue;   // dark: the screens themselves, not every path again
    const key = `${J.name}/${st}/${dev.id}/${th}`; if (FILTER && !FILTER.test(key)) continue;
    jobs.push(() => runJourney(browser, dev, th, st, J).catch((e) => add("block", "error", key, "-", "run crashed: " + e.message.slice(0, 160))));
  }
  const nJ = jobs.length;
  if (!NO_SWEEP) for (const [id, st] of SWEEP_RUNS) for (const S of SWEEP) {
    const dev = DEVICES.find((d) => d.id === id), key = `sweep:${S.name}/${st}/${id}`;
    if (!dev || (FILTER && !FILTER.test(key))) continue;
    jobs.push(() => runSweep(browser, dev, st, S).catch((e) => add("block", "error", key, "-", "sweep crashed: " + e.message.slice(0, 160))));
  }
  console.log(`ui-flows: ${nJ} journeys, ${jobs.length - nJ} screens to sweep`);
  let i = 0; const t0 = Date.now();
  const worker = async () => { while (i < jobs.length) await jobs[i++](); };
  await Promise.all(Array.from({ length: Math.min(4, require("node:os").cpus().length) }, worker));
  await browser.close(); server.close();
  fs.writeFileSync(path.join(OUT, "findings.json"), JSON.stringify(findings, null, 1));
  // one line per distinct problem, with how many runs hit it and one example run
  const groups = {};
  for (const f of findings) { const k = f.sev + "|" + f.kind + "|" + f.step + "|" + f.msg.replace(/\d+px|\d+\.\d+|x=\d+|w=\d+|\[[\d,]+\]|[\d,]{6,}/g, "#"); (groups[k] = groups[k] || { ...f, n: 0, runs: [] }).n++; groups[k].runs.push(f.run); }
  const list = Object.values(groups).sort((a, b) => (a.sev === b.sev ? b.n - a.n : a.sev === "block" ? -1 : 1));
  for (const g of list) console.log(`${g.sev === "block" ? "::error::" : "::warning::"}${NO_FONTS ? "(fallback font) " : ""}${ENGINE === "webkit" ? "(Safari's engine) " : ""}[${g.kind}] ${g.step}: ${g.msg} (${g.n}x, e.g. ${g.runs[0]})`);
  const blocks = findings.filter((f) => f.sev === "block").length;
  console.log(`ui-flows${ENGINE === "webkit" ? " (Safari's engine)" : ""}: ${nJ} journeys and ${jobs.length - nJ} swept screens (${tally.pressed} presses, ${tally.links} links) in ${Math.round((Date.now() - t0) / 1000)} s, ${blocks} blocking, ${findings.length - blocks} warnings, ${list.length} distinct${ENGINE === "webkit" ? `, ${tally.cut} loads the network cut` : ""}`);
  process.exit(blocks ? 1 : 0);
})();
