// UI flows: walks the real page like a person does (home, a check, every tab, "הרכבים שלי", "התראות", settings, compare, the "+",
// Back, the top-bar search) and measures the layout after EVERY step, not only on a still screen. Phase C of the UI guardian.
//   blocking (exit 1): script errors, a step that lands on the wrong screen or state (journey rules below), the navigation bar moving or
//                      changing size between screens, horizontal overflow, an element pushed past the screen edge
//   warning:           layout shift (CLS) inside a step above 0.1, a short label that wraps onto a second line, two controls overlapping,
//                      text cut off, the bottom bar covering the end of the page, the content column changing width between screens
// Each run: device x theme x data state (no cars / one car / many cars with long names) x journey. Registry answers are mocked
// (no network); "offline" and "registry error" are journeys of their own.
// Usage: node .github/scripts/ui-flows.cjs [--quick] [--shots] [--filter <regex>] [--out <dir>]
const fs = require("node:fs"), http = require("node:http"), path = require("node:path");
const { chromium } = require("playwright");

const ROOT = process.cwd();
const args = process.argv.slice(2), arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const QUICK = args.includes("--quick") || !!process.env.UF_QUICK, SHOTS = args.includes("--shots");
const FILTER = arg("--filter") ? new RegExp(arg("--filter")) : null;
const OUT = path.resolve(arg("--out") || path.join(ROOT, "ui-flows"));
fs.mkdirSync(path.join(OUT, "shots"), { recursive: true });

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]); if (p.endsWith("/")) p += "index.html";
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
const S1 = { plate: "1234567", title: "טויוטה COROLLA", sub: "2021 · לבן", at: 1, reg: "active", tokef: day(400), mivchan: day(-330), recalls: 0, checked: 1, owners: 1, active: true, events: [], alerts: true, color: "לבן" };
const MANY = [
  { plate: "1234567", title: "טויוטה COROLLA", sub: "2021", nick: "רכב המשפחה", at: 1, reg: "active", tokef: day(25), mivchan: day(-340), recalls: 1, recIds: "16100", checked: 1, owners: 1, active: true, events: [], alerts: true, color: "כסף מטלי" },
  { plate: "7654321", title: "מרצדס בנץ GLE 450 4MATIC COUPE AMG LINE PREMIUM", sub: "2023", nick: "הרכב של העבודה עם שם ארוך מאוד שלא נגמר", at: 2, reg: "active", tokef: day(-12), mivchan: day(-377), recalls: 2, checked: 1, owners: 3, active: true, events: [], alerts: true, color: "אפור כהה מטלי פנינה" },
  ...[["1112223", "מאזדה CX-5", "אדום"], ["3334445", "סקודה OCTAVIA", "שחור"], ["5556667", "יונדאי IONIQ 5", "לבן"], ["8889990", "קיה SPORTAGE", "כחול"], ["2223334", "פולקסווגן GOLF", "אפור"], ["4445556", "הונדה CIVIC", "כסף"]]
    .map(([plate, title, color], i) => ({ plate, title, sub: String(2016 + i), at: 3 + i, reg: "active", tokef: day(60 + 40 * i), mivchan: day(-300 + 20 * i), recalls: 0, checked: 1, owners: 1 + (i % 3), active: true, events: [], alerts: true, color })),
];
const OWNER = { mine: '{"1234567":1}', svc: JSON.stringify({ 1234567: { log: [{ id: 1, d: day(-140), km: 63900, type: "טיפול תקופתי", cost: 1250, note: "" }, { id: 2, d: day(-20), km: 66100, type: "קריאת ק״מ", cost: 0, note: "" }], meta: null } }) };
const STATES = {
  empty: {},
  owner: { savedVehicles: JSON.stringify([S1]), recentPlates: '["1234567"]', ...OWNER },
  one: { savedVehicles: JSON.stringify([S1]), recentPlates: '["1234567"]' },
  many: { savedVehicles: JSON.stringify(MANY), recentPlates: JSON.stringify(["7654321", "1234567", "1112223", "3334445", "5556667", "8889990"]) },
};

const UA = {
  app: "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36",
  phone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  tablet: "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  desk: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
};
const DEVICES = QUICK
  ? [{ id: "app-360", ua: "app", w: 360, h: 780 }, { id: "web-390", ua: "phone", w: 390, h: 760 }, { id: "web-1280", ua: "desk", w: 1280, h: 860 }]
  : [{ id: "app-320", ua: "app", w: 320, h: 640 }, { id: "app-360", ua: "app", w: 360, h: 780 }, { id: "app-412", ua: "app", w: 412, h: 860 },
     { id: "web-320", ua: "phone", w: 320, h: 568 }, { id: "web-390", ua: "phone", w: 390, h: 760 }, { id: "android-360", ua: "android", w: 360, h: 760 },
     { id: "web-768", ua: "tablet", w: 768, h: 1024 }, { id: "web-1024", ua: "desk", w: 1024, h: 768 }, { id: "web-1280", ua: "desk", w: 1280, h: 860 }, { id: "web-1440", ua: "desk", w: 1440, h: 900 }];
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
    const navBox = nav && vis(nav) ? { bar: R(nav), inner: navIn ? R(navIn) : null, items: [...nav.querySelectorAll("[data-nav], .bn-brand, .bn-f")].filter(vis).map((e) => (e.dataset.nav || e.className) + ":" + R(e).join(",")) } : null;
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
    const bleed = W >= 700 && colBox && !sheet ? [...out.querySelectorAll("*")].filter((e) => vis(e) && !e.closest("svg")).filter((e) => { const b = e.getBoundingClientRect(); return b.width > 20 && (b.left < colBox.left + padL - 2 || b.right > colBox.right - padR + 2) && !e.closest(".cfab,.toast") && !layer(e); }).filter((e, i, a) => !a.some((x) => x !== e && x.contains(e))).map((e) => label(e) + ` (${Math.round(e.getBoundingClientRect().left - colBox.left - padL)}/${Math.round(colBox.right - padR - e.getBoundingClientRect().right)}px)`) : [];
    let covered = null; if (navBox && getComputedStyle(nav).position === "fixed" && nav.getBoundingClientRect().top > innerHeight / 2 && !sheet) {
      const y0 = scrollY; scrollTo(0, document.documentElement.scrollHeight); const top = nav.getBoundingClientRect().top;
      const last = [...document.querySelectorAll("#out *, body > footer *")].filter((e) => vis(e) && e.children.length === 0 && e.textContent.trim()).pop();
      if (last && last.getBoundingClientRect().bottom > top + 1) covered = label(last); scrollTo(0, y0);
    }
    const plate = document.getElementById("plate"), mp = document.querySelector("#chead .mini-plate");
    return {
      starOn: (document.querySelector("#chead [data-act=save]") || { getAttribute: () => "" }).getAttribute("aria-pressed") === "true",
      listed: [...document.querySelectorAll("#out [data-open]")].map((e) => e.dataset.open),
      screen: document.body.dataset.screen, tab: typeof currentTab !== "undefined" ? currentTab : null, carOn: !!mp, carPlate: mp ? mp.textContent.replace(/\D/g, "") : "",
      home: !!document.getElementById("homeMark"), sheet: sheet ? (sheet.id || sheet.className) : null, url: location.pathname + location.search + location.hash, hist: history.length,
      focus: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null, plateVal: plate ? plate.value : null,
      navCur: (document.querySelector("#bnav [aria-current=page]") || { dataset: {} }).dataset.nav || null,
      nav: navBox, col, over: document.documentElement.scrollWidth - W, outside: [...new Set(outside)].slice(0, 8), wraps: [...new Set(wraps)].slice(0, 8), ragged: [...new Set(ragged)],
      overlaps: [...new Set(overlaps)].slice(0, 8), orphans: [...new Set(orphans)].slice(0, 4), bleed: [...new Set(bleed)].slice(0, 4), clipped: [...new Set(clipped)].slice(0, 8), covered, msg: [...document.querySelectorAll("#out .msg")].filter(vis).map((m) => m.textContent).join(" | "),
      loading: !!document.querySelector("#out .skl, #out [aria-busy=true]") || (document.getElementById("go") || {}).disabled === true,
      cls: window.__cls ? window.__cls.v : 0,
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
const back = async (p, c) => { if (c.app) await p.evaluate(() => window.appBack()); else await p.goBack({ waitUntil: "commit" }).catch(() => {}); };
const tap = (sel) => async (p) => p.locator(sel).filter({ visible: true }).first().click({ timeout: 4000 });
const tapIf = (sel) => async (p) => { const l = p.locator(sel).filter({ visible: true }).first(); if (await l.count()) await l.click({ timeout: 4000 }); };
const isCar = (plate) => (m, c) => m.screen === "car" && m.carPlate === (plate || c.plate) || `expected the car ${plate || c.plate}, got screen ${m.screen} ${m.carPlate} ${m.msg.slice(0, 50)}`;
const JOURNEYS = [
  { name: "tour", steps: [
    ["home", null, (m) => m.screen === "home" && m.home || "home did not draw"],
    ["cars", nav("cars"), (m) => m.screen === "cars" || `cars tab: screen ${m.screen}`],
    ["alerts", nav("alerts"), (m) => m.screen === "alerts" || `alerts tab: screen ${m.screen}`],
    ["search", nav("search"), (m) => m.screen === "home" && m.home || `search tab: screen ${m.screen}`],
    ["settings", tap("#openSettings"), (m) => m.sheet === "settings" || "settings did not open"],
    ["settings-alerts", tap("#toAlerts"), (m) => m.screen === "alerts" && !m.sheet || `"על אילו רכבים" should open התראות, got ${m.screen} ${m.sheet}`],
    ["settings-2", async (p) => { await p.click('#bnav [data-nav="search"]'); await p.click("#openSettings"); }, (m) => m.sheet === "settings" || "settings"],
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
  { name: "saved", when: (c) => c.state !== "empty", steps: [
    ["cars", nav("cars"), (m) => m.screen === "cars" || "cars"],
    ["open", tap("#out [data-open]"), (m) => m.screen === "car" || `opening a saved car: ${m.screen} ${m.msg.slice(0, 40)}`],
    ["arrow-back", tap("#chead [data-act=back]"), (m) => m.screen === "cars" || `the arrow from a car opened in "הרכבים שלי" should return there, got ${m.screen}`],
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
  { name: "tools", steps: [
    ["models", tap("#out [data-act=compareHome]"), (m) => /compare/i.test(m.sheet || "") || m.screen === "sub" || `חיפוש דגמים: ${m.screen} ${m.sheet}`],
    ["models-back", back, (m) => m.screen === "home" && !m.sheet || `Back from חיפוש דגמים: ${m.screen} ${m.sheet || ""}`],
    ["market", tap("#out [data-act=market]"), (m) => m.screen === "sub" || `שוק הרכב: ${m.screen}`],
    ["market-back", tap("#chead [data-act=toolBack]"), (m) => m.screen === "home" || `back from שוק הרכב: ${m.screen}`],
    ["bulk", tap("#out [data-act=bulk]"), (m) => m.screen === "sub" || `בדיקת כמה רכבים: ${m.screen}`],
    ["bulk-cars", nav("cars"), (m) => m.screen === "cars" || `cars from a tool: ${m.screen}`],
    ["bulk-search", nav("search"), (m) => m.screen === "home" || m.screen === "sub" || `search from cars after a tool: ${m.screen}`],
  ] },
  { name: "owner", when: (c) => c.state === "owner", steps: [
    ["check", check(), isCar()],
    ["file", async (p) => { const b = p.locator(".tabs [data-tab=file]"); if (await b.count()) await b.click(); }, (m) => m.screen === "car" || "file tab"],
    ["docs", tapIf("#chead [data-cf=road]"), (m) => m.screen === "car" || "documents"],
    ["docs-back", back, (m) => m.screen === "car" && !m.sheet || `Back should close the documents sheet first, got ${m.screen} ${m.sheet || ""}`],
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
  // a tablet turned on its side (and back) while on a car page
  { name: "rotate", when: (c) => c.dev.w >= 600 && c.dev.w < 1100, steps: [
    ["check", check(), isCar()],
    ["turn", async (p, c) => { await p.setViewportSize({ width: c.dev.h, height: c.dev.w }); }, (m) => m.screen === "car" || "rotate"],
    ["cars", nav("cars"), (m) => m.screen === "cars" || "cars"],
    ["turn-back", async (p, c) => { await p.setViewportSize({ width: c.dev.w, height: c.dev.h }); }, (m) => m.screen === "cars" || "rotate back"],
  ] },
];

async function runJourney(browser, dev, theme, stateName, J) {
  const app = dev.ua === "app", run = `${J.name}/${stateName}/${dev.id}/${theme}`;
  const ctx = await browser.newContext({ viewport: { width: dev.w, height: dev.h }, deviceScaleFactor: 1, isMobile: dev.w < 900, hasTouch: dev.w < 900, colorScheme: theme, locale: "he-IL", userAgent: UA[dev.ua] });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
  const net = { offline: false };   // a mocked answer would still arrive with the context offline, so the mock stops answering too
  await ctx.route(/data\.gov\.il/, (r) => {
    const u = r.request().url();
    if (net.offline) return r.abort("internetdisconnected");
    if (J.gov === "500") return r.fulfill({ status: 500, body: "" });
    if (J.gov === "abort") return r.abort("internetdisconnected");
    if (J.gov === "slow") return new Promise((ok) => setTimeout(ok, 25000)).then(() => r.abort()).catch(() => {});
    if (/[?&]limit=0\b/.test(u)) return r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ success: true, result: { records: [], total: 120000 } }) });
    const m = decodeURIComponent(u).match(/(\d{7,8})/), rec = u.includes("053cea08") && m && RECS[+m[1]];
    const recs = rec ? [rec] : [];
    r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ success: true, result: { records: recs, total: recs.length } }) });
  });
  await ctx.addInitScript(({ ls, app }) => {
    try { localStorage.setItem("analyticsOff", "1"); for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v); } catch {}
    if (app) window.AndroidApp = { alertsState: () => "on", setAlerts() {}, askReview() {}, checkUpdate() {}, logEvent() {}, setAnalytics() {}, setLandscape() {}, syncSaved() {} };
    window.__cls = { v: 0, src: [] };
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__cls.v += e.value; window.__cls.src.push((e.sources || []).map((s) => s.node && (s.node.id || s.node.className || s.node.nodeName)).join("|").slice(0, 80)); } }).observe({ type: "layout-shift", buffered: true }); } catch {}
  }, { ls: { theme, ...STATES[stateName] }, app });
  const page = await ctx.newPage();
  let step = "load";
  page.on("pageerror", (e) => add("block", "error", run, step, "page error: " + e.message.slice(0, 160)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector("#homeMark", { state: "attached", timeout: 15000 }).catch(() => add("block", "logic", run, step, "home did not render"));
  await page.addStyleTag({ content: "*{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}" });
  const c = { dev, theme, state: stateName, app, ctx, net, plate: stateName === "many" ? "7654321" : "1234567" };
  const seen = [];   // per step: {step, screen, nav, col, vw}
  let prev = null;
  for (const [name, act, expect] of J.steps) {
    step = name;
    await page.evaluate(() => { window.__cls.v = 0; window.__cls.src = []; });
    if (act) { try { await act(page, c); } catch (e) { add("block", "logic", run, step, "could not act: " + e.message.split("\n")[0].slice(0, 120)); } }
    await page.waitForTimeout(450);
    let m; try { m = await measure(page); } catch (e) { add("block", "error", run, step, "measure failed: " + e.message.slice(0, 100)); continue; }
    let ok = expect ? expect(m, c) : true;
    if (ok && ok.warn) { add("warn", "logic", run, step, ok.warn); ok = true; }
    if (ok !== true) add("block", "logic", run, step, ok);
    if (m.over > 0) add("block", "overflow", run, step, `page scrolls sideways by ${m.over}px on ${m.screen}`);
    if (m.outside.length) add("block", "outside", run, step, `past the screen edge on ${m.screen}: ${m.outside.join(" · ")}`);
    if (m.cls > 0.1) add("warn", "cls", run, step, `layout shift ${m.cls.toFixed(2)} on ${m.screen}: ${(await page.evaluate(() => window.__cls.src.slice(0, 4).join(" ; ")))}`);
    if (m.wraps.length) add("warn", "wrap", run, step, `label on two lines on ${m.screen}: ${m.wraps.join(" · ")}`);
    if (m.overlaps.length) add("warn", "overlap", run, step, `controls overlap on ${m.screen}: ${m.overlaps.join(" · ")}`);
    if (m.clipped.length) add("warn", "clip", run, step, `text cut off on ${m.screen}: ${m.clipped.join(" · ")}`);
    if (m.orphans.length) add("warn", "orphan", run, step, `a control dropped to a line of its own on ${m.screen}: ${m.orphans.join(" · ")}`);
    if (m.bleed.length) add("warn", "bleed", run, step, `wider than the content column on ${m.screen}: ${m.bleed.join(" · ")}`);
    if (m.ragged.length) add("warn", "ragged", run, step, `one row, different heights on ${m.screen}: ${m.ragged.join(" · ")}`);
    if (m.covered) add("warn", "covered", run, step, `the bottom bar covers "${m.covered}" at the end of ${m.screen}`);
    if (!m.sheet && m.nav && ({ home: "search", cars: "cars", alerts: "alerts" })[m.screen] && m.navCur !== ({ home: "search", cars: "cars", alerts: "alerts" })[m.screen]) add("block", "logic", run, step, `the bar highlights "${m.navCur}" on the ${m.screen} screen`);
    if (ok === true && act === back && prev && ["screen", "sheet", "url", "carPlate", "msg", "tab"].every((k) => prev[k] === m[k]) && !(m.screen === "home" && m.home)) add("block", "logic", run, step, `Back did nothing on ${m.screen} (a dead press)`);
    prev = m;
    seen.push({ step: name, screen: m.screen, sheet: m.sheet, nav: m.nav, col: m.col, vw: await page.evaluate(() => innerWidth) });
    if (SHOTS) await page.screenshot({ path: path.join(OUT, "shots", `${run.replace(/\//g, "__")}__${name}.png`) }).catch(() => {});
  }
  // the navigation bar is the frame of every screen: same place, same size, same items, whatever screen is drawn
  for (const vw of new Set(seen.map((s) => s.vw))) {
    const withNav = seen.filter((s) => s.nav && !s.sheet && s.vw === vw);
    if (withNav.length < 2) continue;
    const ref = withNav[0];
    for (const s of withNav.slice(1)) {
      const k = (n) => JSON.stringify([n.bar, n.inner, n.items]);
      if (k(s.nav) !== k(ref.nav)) {
        const diff = s.nav.items.filter((x) => !ref.nav.items.includes(x)).concat(JSON.stringify(s.nav.inner) !== JSON.stringify(ref.nav.inner) ? [`frame ${ref.nav.inner} → ${s.nav.inner}`] : []);
        add("block", "nav-moved", run, s.step, `the navigation bar moved between ${ref.screen} (${ref.step}) and ${s.screen}: ${diff.slice(0, 3).join(" · ")}`);
      }
    }
  }
  // the content column: a screen that is narrower or wider than the others reads as a jump (warning; the nav check above is the hard one)
  const cols = {}; for (const s of seen) if (s.col && !s.sheet && s.vw === dev.w) cols[s.screen] = cols[s.screen] || s.col;
  const ws = Object.entries(cols).map(([k, v]) => [k, v[0], v[2]]);
  if (dev.w >= 768 && ws.length > 1 && new Set(ws.map((x) => x[1] + "," + x[2])).size > 1) add("warn", "column", run, "-", `content column differs by screen: ${ws.map((x) => `${x[0]} x=${x[1]} w=${x[2]}`).join(" · ")}`);
  await ctx.close();
}

(async () => {
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const browser = await chromium.launch();
  const jobs = [];
  for (const dev of DEVICES) for (const th of THEMES) for (const st of Object.keys(STATES)) for (const J of JOURNEYS) {
    if (J.when && !J.when({ state: st, dev })) continue;
    if (J.once && st !== "one") continue;                // error paths once per device and theme
    if (J.web && dev.ua === "app") continue;
    if (J.name === "owner" ? st !== "owner" : st === "owner" && J.name !== "tour") continue;
    if (th === "dark" && !/^(tour|check|saved|owner)$/.test(J.name)) continue;   // dark: the screens themselves, not every path again
    const key = `${J.name}/${st}/${dev.id}/${th}`; if (FILTER && !FILTER.test(key)) continue;
    jobs.push([dev, th, st, J]);
  }
  console.log(`ui-flows: ${jobs.length} journeys`);
  let i = 0; const t0 = Date.now();
  const worker = async () => { while (i < jobs.length) { const j = jobs[i++]; try { await runJourney(browser, ...j); } catch (e) { add("block", "error", `${j[3].name}/${j[2]}/${j[0].id}/${j[1]}`, "-", "run crashed: " + e.message.slice(0, 160)); } } };
  await Promise.all(Array.from({ length: Math.min(4, require("node:os").cpus().length) }, worker));
  await browser.close(); server.close();
  fs.writeFileSync(path.join(OUT, "findings.json"), JSON.stringify(findings, null, 1));
  // one line per distinct problem, with how many runs hit it and one example run
  const groups = {};
  for (const f of findings) { const k = f.sev + "|" + f.kind + "|" + f.step + "|" + f.msg.replace(/\d+px|\d+\.\d+|x=\d+|w=\d+|\[[\d,]+\]|[\d,]{6,}/g, "#"); (groups[k] = groups[k] || { ...f, n: 0, runs: [] }).n++; groups[k].runs.push(f.run); }
  const list = Object.values(groups).sort((a, b) => (a.sev === b.sev ? b.n - a.n : a.sev === "block" ? -1 : 1));
  for (const g of list) console.log(`${g.sev === "block" ? "::error::" : "::warning::"}[${g.kind}] ${g.step}: ${g.msg} (${g.n}x, e.g. ${g.runs[0]})`);
  const blocks = findings.filter((f) => f.sev === "block").length;
  console.log(`ui-flows: ${jobs.length} journeys in ${Math.round((Date.now() - t0) / 1000)} s, ${blocks} blocking, ${findings.length - blocks} warnings, ${list.length} distinct`);
  process.exit(blocks ? 1 : 0);
})();
