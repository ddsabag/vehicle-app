// Analytics in motion: the journeys of ui-flows.cjs walked with analytics on, in the app and on the website, and every event followed to
// where it lands. In the app the page runs at its WebView address and window.AndroidApp.logEvent applies MainActivity.logEvent's own
// rules (8 parameters, names [a-z][a-z0-9_]{0,39}, no 5 digits or @ in a text, numbers under 10000, 60 characters); on the website it
// runs at https://luchit.app, and each sendBeacon("/api/e") is handed, with the browser's own headers, to worker/api's own code, whose
// request to GA4 is read. Two lenses: a person (nothing personal leaves the phone, the switch in settings silences everything) and the
// analyst (one event per action, every parameter arrives, the app and the website count the same thing the same way, what the dashboard
// reads is still sent).
// Blocking (exit 1):
//   - a plate, a nickname, an email or 5 digits in a text of an event, even one the filters stop (it left the page)
//   - an event or a parameter lost on the way without a word: an event worker/api does not forward, a name GA4 and Firebase keep for
//     themselves, a parameter past the app's 8th or the website's 10th entry (src and camp count), a name outside the rules, a number
//     from 10000, a text over 40 characters (the website cuts it at 40 and the app at 60: one value would reach GA4 as two)
//   - the same event with the same parameters twice in one step
//   - anything sent while analytics is off, or after the switch in settings is turned off
//   - an event the dashboard or a report reads that nothing sends any more (the reverse of ga4-admin.mjs's contract)
// Warnings: an event one platform sends for the same steps and the other does not (unless it belongs to one platform by nature), an
// event the dashboard reads that no journey produced, an address outside the site and the registry that the page called.
// Usage: node .github/scripts/analytics-flows.cjs [--out dir] [--filter regex]
const fs = require("node:fs"), path = require("node:path");
const UF = require("./ui-flows.cjs");
const { JOURNEYS, STATES, RECS, govRoute, UA, BRIDGE } = UF;

const args = process.argv.slice(2), arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const ROOT = process.cwd(), OUT = path.resolve(arg("--out") || path.join(ROOT, "analytics-flows")), FILTER = arg("--filter") ? new RegExp(arg("--filter")) : null;
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), "utf8"); } catch { return ""; } };
const findings = [];
const add = (sev, kind, run, step, msg) => { findings.push({ sev, kind, run, step, msg }); };

// ---- what may never leave the page: the fixtures' plates and nicknames, an email, 5 digits in a text
const saved = Object.values(STATES).flatMap((s) => { try { return JSON.parse(s.savedVehicles || "[]"); } catch { return []; } });
const PLATES = [...new Set([...Object.keys(RECS), ...saved.map((v) => v.plate)])], NICKS = [...new Set(saved.map((v) => v.nick).filter(Boolean))];
function personal(v) {
  const t = typeof v === "string" ? v : JSON.stringify(v), d = t.replace(/\D/g, "");
  if (t.includes("@")) return "an @ (an email)";
  if (PLATES.some((p) => d.includes(p))) return "a plate";
  const n = NICKS.find((x) => t.includes(x)); if (n) return `a car's nickname ("${n}")`;
  if (typeof v === "string" && d.length >= 5 && !/^\d+$/.test(t)) return "5 digits in a text (a plate or a phone)";
  return null;
}
// names GA4 and Firebase keep for themselves: an event or a parameter by such a name is thrown away
const RESERVED = new Set(["ad_activeview", "ad_click", "ad_exposure", "ad_impression", "ad_query", "ad_reward", "adunit_exposure", "app_background", "app_clear_data", "app_exception", "app_install", "app_remove", "app_store_refund", "app_store_subscription_cancel", "app_store_subscription_convert", "app_store_subscription_renew", "app_update", "app_upgrade", "dynamic_link_app_open", "dynamic_link_app_update", "dynamic_link_first_open", "error", "first_open", "first_visit", "in_app_purchase", "notification_dismiss", "notification_foreground", "notification_open", "notification_receive", "notification_send", "os_update", "session_start", "session_start_with_rollout", "user_engagement"]);
const reservedName = (n) => RESERVED.has(n) || /^(firebase_|google_|ga_)/.test(n);

// ---- the app: MainActivity.logEvent's rules, in its order (a skipped parameter still takes one of the 8 places)
function viaApp(name, json) {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(name)) return { kept: null, lost: [["(the event)", "a name outside [a-z][a-z0-9_]{0,39}"]] };
  let o; try { o = JSON.parse(json || "{}"); } catch { return { kept: null, lost: [["(the event)", "parameters that are not JSON"]] }; }
  const kept = {}, lost = [];
  Object.keys(o).forEach((k, i) => {
    const v = o[k];
    if (i >= 8) return lost.push([k, "past the app's 8th parameter"]);
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) return lost.push([k, "a name outside [a-z][a-z0-9_]{0,39}"]);
    if (typeof v === "number") return Math.abs(v) < 10000 ? (kept[k] = Math.trunc(v)) : lost.push([k, "a number from 10000"]);
    if (typeof v === "boolean") return (kept[k] = v ? 1 : 0);
    const sv = v === null ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (sv.replace(/[^0-9]/g, "").length >= 5 || sv.includes("@")) return lost.push([k, /^\d+$/.test(sv) ? "a number from 10000 (the app sends numbers as text, and 5 digits read as a plate)" : "5 digits or an @ in the text"]);
    kept[k] = sv.slice(0, 60);
    if (sv.length > 60) lost.push([k, "cut at 60 characters"]);
  });
  return { kept, lost };
}

// ---- the website: worker/api's own code, loaded as it is deployed; its request to GA4 is caught
const ga = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  if (String(u).startsWith("https://www.google-analytics.com/mp/collect")) { ga.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
  return realFetch(u, init);
};
let worker = null;
const ENV = { GA_MEASUREMENT_ID: "G-TEST000000", GA_API_SECRET: "test" };
const WEB_EVENTS = new Set([...(((read("worker/api/worker.js").match(/WEB_EVENTS = new Set\(\[([^\]]+)\]/) || [])[1]) || "").matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1]));
// why a raw web parameter did not reach GA4 (the worker decides; this only words its reason)
function webReason(k, v, i) {
  if (i >= 10) return "past the website's 10th entry (src and camp count)";
  if (!/^[a-z_]{1,24}$/.test(k)) return "a name outside [a-z_]{1,24}";
  if (typeof v === "number") return isFinite(v) ? "a number from 10000" : "not a finite number";
  if (typeof v === "string") return "5 digits or an @ in the text";
  return "a value that is not text, a number or true/false";
}
async function viaWeb(body, headers) {
  const n0 = ga.length;
  const res = await worker.fetch(new Request("https://luchit.app/api/e", { method: "POST", headers, body }), ENV, { waitUntil() {} });
  const out = ga.slice(n0).flatMap((g) => g.events || []);
  return { status: res.status, ev: out[0] || null };
}

// ---- the files of the site at its own address (the website, and what the app fetches from it); the app's page at its WebView address
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".txt": "text/plain", ".xml": "application/xml" };
function serve(r, u) {
  let p = decodeURIComponent(u.pathname);
  if (u.hostname === "appassets.androidplatform.net") p = p.replace(/^\/assets\//, "/");
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.fulfill({ status: 404, body: "" });
  return r.fulfill({ status: 200, contentType: MIME[path.extname(f)] || "application/octet-stream", body: fs.readFileSync(f) });
}
const OWN_HOSTS = /^(luchit\.app|appassets\.androidplatform\.net|data\.gov\.il)$/;
// the other addresses the page may call, and why: each one is a data flow the privacy policy and Play's Data safety form must cover, so a
// new one blocks until it is listed here with its reason (and the policy checked)
const KNOWN_HOSTS = {
  "raw.githubusercontent.com": "the repository's data branches: ownership history and cars back on the road by the plate's last 3 digits only, the model catalogue, the data status",
  "static.cloudflareinsights.com": "Cloudflare Web Analytics on the website, loaded only with analytics on (no cookies)",
  "cdn.jsdelivr.net": "the readers that run on the phone: the plate photo, a document's expiry date (tesseract.js, pdf.js) and the shared image; only the library files come down, nothing of the user's goes up (privacy.html: צילום לוחית, תיק הרכב, מידע נוסף שנטען)",
};

// ---- one journey with analytics on (or off): per step, every event that left the page and what reached Firebase or GA4
const APP_URL = "https://appassets.androidplatform.net/assets/index.html", WEB_URL = "https://luchit.app/";
async function walk(browser, dev, st, J, o = {}) {
  const run = `${J.name}/${st}/${dev.id}${o.off ? "/analytics-off" : ""}`, app = dev.ua === "app";
  const ctx = await browser.newContext({ viewport: { width: dev.w, height: dev.h }, deviceScaleFactor: 1, isMobile: dev.w < 900, hasTouch: dev.w < 900, locale: "he-IL", userAgent: UA[dev.ua], serviceWorkers: "block" });
  const cur = { step: "load" }, steps = [], net = { offline: false }, pending = new Set(), beacons = [], hosts = new Set();
  await ctx.route(/^https?:\/\//, (r) => {
    const u = new URL(r.request().url());
    if (net.offline) { if (u.pathname === "/api/e") beacons.push({ step: cur.step, body: r.request().postData() || "", out: { offline: true } }); return r.abort("internetdisconnected"); }
    if (/(^|\.)data\.gov\.il$/.test(u.hostname)) return govRoute(r, J.gov);
    if (u.hostname === "luchit.app" && u.pathname === "/api/e") {
      const req = r.request(), step = cur.step;
      const p = (async () => { const body = req.postData() || "", headers = await req.allHeaders(); beacons.push({ step, body, out: await viaWeb(body, headers) }); await r.fulfill({ status: 204, body: "" }); })().catch((e) => add("block", "error", run, step, "a beacon could not be followed: " + e.message.slice(0, 120)));
      pending.add(p); p.finally(() => pending.delete(p));
      return p;
    }
    if (u.hostname === "luchit.app" || u.hostname === "appassets.androidplatform.net") return serve(r, u);
    if (!OWN_HOSTS.test(u.hostname)) hosts.add(u.hostname);
    return r.abort();   // cut: on a real phone it would be reached
  });
  await ctx.addInitScript(({ ls, app, bridge, off }) => {
    try { Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false, configurable: true }); } catch {}   // a test browser is never counted; here it is a person
    // laid down on the first page only (a cookie marks it), so a reload keeps what the journey stored
    try { if (!/(?:^|; )af_seeded=1/.test(document.cookie)) { for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v); if (off) localStorage.setItem("analyticsOff", "1"); document.cookie = "af_seeded=1; path=/"; } } catch {}
    window.__ev = []; window.__calls = [];
    if (app) window.AndroidApp = Object.fromEntries(bridge.map((n) => [n, (...a) => { window.__calls.push(n); if (n === "logEvent") window.__ev.push(a); return n === "alertsState" ? "on" : n === "readClipboard" ? "" : n === "systemDark" ? false : undefined; }]));
    try { window.open = () => null; } catch {}
  }, { ls: STATES[st] || {}, app, bridge: BRIDGE, off: !!o.off });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => add("block", "error", run, cur.step, "page error: " + e.message.slice(0, 160)));
  const flush = async () => {
    await page.waitForTimeout(350);
    for (let i = 0; i < 20 && pending.size; i++) await Promise.race([Promise.allSettled([...pending]), page.waitForTimeout(500)]);
    const raw = app ? await page.evaluate(() => window.__ev.splice(0)).catch(() => []) : [];
    const ev = app ? raw.map(([name, json]) => ({ name, raw: (() => { try { return JSON.parse(json || "{}"); } catch { return {}; } })(), json, ...viaApp(name, json) }))
      : beacons.splice(0).map((b) => { let j = {}; try { j = JSON.parse(b.body); } catch {} return { name: j.n, raw: j.p || {}, json: JSON.stringify(j.p || {}), step: b.step, web: b.out }; });
    return ev;
  };
  let off = false;
  try {
    await page.goto((app ? APP_URL : WEB_URL) + (o.query || ""));
    // a link to a car or a comparison opens it, not home
    if (o.query) { await page.waitForFunction(() => document.body && document.body.dataset.screen, null, { timeout: 15000 }); await UF.settle(page); await page.waitForTimeout(800); }
    else await page.waitForSelector("#homeMark", { state: "attached", timeout: 15000 });
    await page.addStyleTag({ content: "*{animation:none!important;transition:none!important;scroll-behavior:auto!important}" });
    steps.push({ step: "load", ev: await flush() });
    const c = { dev, theme: "light", state: st, app, ctx, net, page, plate: st === "many" ? "7654321" : "1234567" };
    for (const [name, act, expect] of J.steps) {
      cur.step = name;
      if (act) { try { await act(page, c); } catch (e) { off = off || name; } }
      await page.waitForTimeout(450);
      if (expect && !off) { try { const m = await UF.measure(page), ok = await expect(m, c); if (ok !== true && !(ok && ok.warn)) off = name; } catch { off = name; } }
      steps.push({ step: name, ev: await flush() });
    }
  } catch (e) { add("block", "error", run, cur.step, "the journey crashed: " + e.message.split("\n")[0].slice(0, 160)); off = off || cur.step; }
  const calls = await page.evaluate(() => window.__calls).catch(() => []);
  await ctx.close();
  return { run, dev: dev.id, app, st, J: J.name, steps, off, hosts: [...hosts], calls };
}

// ---- the rules, per event
function judge(R) {
  for (const { step, ev } of R.steps) {
    const seen = new Map();
    for (const e of ev) {
      const where = R.app ? "the app" : "the website";
      if (!e.name) { add("block", "lost", R.run, step, `${where} sent an event without a name`); continue; }
      if (reservedName(e.name)) add("block", "lost", R.run, step, `${e.name}: a name GA4 and Firebase keep for themselves, so the event is thrown away`);
      for (const [k, v] of Object.entries(e.raw)) {
        const why = personal(v); if (why) add("block", "personal", R.run, step, `${e.name}.${k} carries ${why}; it must never leave the page, even when a filter on the way stops it`);
        if (/^(firebase_|google_|ga_)/.test(k)) add("block", "lost", R.run, step, `${e.name}.${k}: a parameter name GA4 and Firebase keep for themselves`);
        if (typeof v === "string" && v.length > 40) add("block", "lost", R.run, step, `${e.name}.${k} is ${v.length} characters: the website cuts it at 40 and the app at 60, so one value reaches GA4 as two (cut it to 40 in the page)`);
      }
      if (R.app) {
        for (const [k, why] of e.lost || []) if (!/^cut at/.test(why) && !personal(e.raw[k])) add("block", "lost", R.run, step, `the app drops ${e.name}.${k}: ${why}`);
      } else {
        if (e.web && e.web.offline) add("block", "lost", R.run, step, `the website sent ${e.name} with the network down: a beacon is lost then (the page should keep it until it is back online)`);
        else if (!WEB_EVENTS.has(e.name)) add("block", "lost", R.run, step, `${e.name} is not in WEB_EVENTS (worker/api): the website drops it without a word`);
        else if (!e.web || !e.web.ev) add("block", "lost", R.run, step, `worker/api did not pass ${e.name} on to GA4 (answer ${e.web && e.web.status}): check its origin, sec-fetch-site and user-agent rules against what the browser sends`);
        else {
          const fwd = e.web.ev.params || {};
          Object.entries(e.raw).forEach(([k, v], i) => { if (!(k in fwd) && !personal(v)) add("block", "lost", R.run, step, `the website drops ${e.name}.${k}: ${webReason(k, v, i)}`); });
        }
      }
      const key = e.name + " " + e.json;
      if (seen.has(key)) add("block", "twice", R.run, step, `${e.name} twice in one step with the same parameters (${e.json.slice(0, 120)}): one action, one event`);
      seen.set(key, 1);
    }
  }
  if (R.off) add("warn", "journey", R.run, R.off, "the journey went off its path here (ui-flows.cjs reports why); the events after it were not compared between the app and the website");
  for (const h of R.hosts) if (!KNOWN_HOSTS[h]) add("block", "hosts", R.run, "-", `the page called ${h}, a new address outside the site and the registry: list it in KNOWN_HOSTS with what it is for, and check that the privacy policy and Play's Data safety form say so`);
}

// ---- events that belong to one platform by nature, so the other does not send them for the same steps
const ONLY_WEB = { web_visit: "a visit to the website (the app counts first_open and app_return)", link_landing: "a visit that came by a link (the app: link_open from MainActivity)", home_open: "the website opened from the home screen", web_hint_click: "the website's hint to install the app", web_install_prompt: "the website's install prompt", web_install_click: "the website's install button" };
const ONLY_APP = { app_return: "the app opened again after a day", first_save: "the install cohort's first saved car", update_prompt: "the in-app update", update_start: "the in-app update", update_done: "the in-app update",
  alert_kind: "a kind of phone alert switched on or off (phone alerts are the app's)", alerts_toggle: "a car's phone alerts switched on or off (phone alerts are the app's)" };
ONLY_WEB.home_sheet = "on an iPhone, once after a car is saved: how to put the website on the home screen (no app for iPhone)";
// and impressions that depend on the platform's state or on what fits on the screen, so either side may send them at another step
const SOMETIMES = { calendar_reminder_shown: "the calendar button: always on the website, in the app only when the phone's own alert will not cover the test",
  file_cta_shown: "counted when 60% of the file's invitation is on the screen, which depends on the layout above it" };

// ---- what the dashboard and the reports read, and what sends it: the page, the app's own code, worker/api, or GA4 itself
function readers() {
  const live = read("worker/live/worker.js"), py = fs.readdirSync(path.join(ROOT, "analytics")).filter((f) => f.endsWith(".py")).map((f) => read("analytics/" + f)).join("\n");
  const names = new Set();
  for (const m of live.matchAll(/\b(?:only|web)\("([a-z_0-9]+)"\)/g)) names.add(m[1]);
  for (const m of live.matchAll(/\b(?:any\(|RT_KEYS\s*=\s*|fieldName:\s*"eventName",\s*inListFilter:\s*\{\s*values:\s*)\[([^\]]*)\]/g)) for (const x of m[1].matchAll(/"([a-z_0-9]+)"/g)) names.add(x[1]);
  for (const m of live.matchAll(/fieldName:\s*"eventName",\s*stringFilter:\s*\{\s*value:\s*"([a-z_0-9]+)"/g)) names.add(m[1]);
  for (const m of py.matchAll(/["']eventName["']\s*,\s*["']([a-z_0-9]+)["']/g)) names.add(m[1]);
  for (const m of py.matchAll(/\bevent\s*=\s*["']([a-z_0-9]+)["']/g)) names.add(m[1]);
  return names;
}
function senders() {
  const html = read("index.html"), javaDir = "android/app/src/main/java/com/ddsabag/pratirechev/";
  const java = (() => { try { return fs.readdirSync(path.join(ROOT, javaDir)).filter((f) => f.endsWith(".java")).map((f) => read(javaDir + f)).join("\n"); } catch { return ""; } })();
  const s = new Set([...html.matchAll(/\btrack\(([^,)]*)/g)].flatMap((m) => [...m[1].matchAll(/"([a-z_0-9]+)"/g)].map((x) => x[1])));
  for (const m of java.matchAll(/track\('([a-z_0-9]+)'/g)) s.add(m[1]);
  for (const m of java.matchAll(/logUsage\([^,()]+,\s*"([a-z_0-9]+)"/g)) s.add(m[1]);
  for (const m of read("worker/api/worker.js").matchAll(/\bname:\s*"([a-z_0-9]+)"/g)) s.add(m[1]);
  // GA4's own: collected by Firebase in the app and by GA4 itself, never sent by our code
  for (const e of ["first_open", "first_visit", "session_start", "user_engagement", "page_view", "screen_view", "app_remove", "app_update", "os_update", "app_clear_data", "in_app_purchase", "notification_open", "notification_receive", "notification_dismiss", "notification_foreground"]) s.add(e);
  return s;
}

// ---- the switch in settings: from the moment it is turned off, nothing leaves the page
const SWITCH_OFF = { name: "switch-off", steps: [
  ["settings", UF.tap("#openSettings, #bnSet"), null],
  ["off", async (p) => { await p.locator("#anaChk").uncheck(); }, null],
  ["close", UF.tap("#closeSettings"), null],
  ["check", UF.check(), null],
  ["tab", async (p) => { const b = p.locator(".tabs [data-tab=specs]"); if (await b.count()) await b.click(); }, null],
  ["cars", UF.nav("cars"), null],
] };

// arrivals on the website by a link: the visit is counted by how it came, and the plate in the address never goes with it
const ARRIVALS = [
  { query: "?plate=1234567", ev: "link_landing", has: { kind: "plate" } },
  { query: "?cmp=1234567,7654321", ev: "link_landing", has: { kind: "cmp" } },
  { query: "?utm_source=facebook&utm_medium=social&utm_campaign=market", ev: "link_landing", has: { kind: "campaign", via: "facebook" } },
  // a car checked on a campaign visit: car_lookup's fullest form on the website (src and camp before its 8), at the 10 the endpoint keeps
  { query: "?utm_source=facebook&utm_campaign=market", ev: "link_landing", has: { kind: "campaign" }, steps: [["check", UF.check(), UF.isCar()]] },
];

module.exports = { viaApp, personal, readers, senders };

if (require.main === module) (async () => {
  const { chromium } = require("playwright");
  fs.mkdirSync(OUT, { recursive: true });
  worker = (await import("data:text/javascript;base64," + Buffer.from(read("worker/api/worker.js")).toString("base64"))).default;
  const t0 = Date.now();

  // the reverse of ga4-admin's contract: whatever the dashboard and the reports read must still be sent by something
  const R = readers(), S = senders();
  for (const e of R) if (!S.has(e)) add("block", "unsent", "static", "-", `the dashboard or a report reads ${e}, and nothing sends it any more (the page, the app's code, worker/api or GA4 itself): a tile that will show 0 for ever`);

  const DEVS = [{ id: "app-360", ua: "app", w: 360, h: 780 }, { id: "web-390", ua: "phone", w: 390, h: 760 }, { id: "web-1280", ua: "desk", w: 1280, h: 860 }];
  const jobs = [];
  for (const dev of DEVS) for (const st of Object.keys(STATES)) for (const J of JOURNEYS) {
    const app = dev.ua === "app";
    if (J.when && !J.when({ state: st, dev })) continue;
    if (J.only ? st !== J.only : (J.once && st !== "one") || (st === "owner" && J.name !== "tour")) continue;
    if ((J.web && app) || (J.app && !app) || J.devOnly) continue;
    if (FILTER && !FILTER.test(`${J.name}/${st}/${dev.id}`)) continue;
    jobs.push([dev, st, J, {}]);
  }
  // analytics off: a first visit and a car checked send nothing at all; the switch in settings silences everything after it
  for (const dev of DEVS.slice(0, 2)) for (const name of ["tour", "check"]) if (!FILTER || FILTER.test(`${name}/one/${dev.id}/analytics-off`)) jobs.push([dev, "one", JOURNEYS.find((j) => j.name === name), { off: true }]);
  for (const dev of DEVS.slice(0, 2)) if (!FILTER || FILTER.test(`switch-off/one/${dev.id}`)) jobs.push([dev, "one", SWITCH_OFF, {}]);
  for (const a of ARRIVALS) if (!FILTER || FILTER.test(`arrive${a.query}/empty/web-390`)) jobs.push([DEVS[1], "empty", { name: "arrive" + a.query + (a.steps ? "+" + a.steps.map((x) => x[0]).join("+") : ""), steps: a.steps || [] }, { query: a.query, arrival: a }]);

  const browser = await chromium.launch();
  const results = []; let i = 0;
  const workerFn = async () => { while (i < jobs.length) { const [dev, st, J, o] = jobs[i++]; results.push({ ...(await walk(browser, dev, st, J, o)), o }); } };
  await Promise.all(Array.from({ length: Math.min(4, require("node:os").cpus().length) }, workerFn));
  await browser.close();

  for (const r of results) {
    if (r.o.off) {
      for (const s of r.steps) for (const e of s.ev) add("block", "off", r.run, s.step, `${e.name} was sent with analytics switched off`);
      for (const h of r.hosts) if (/cloudflareinsights/.test(h)) add("block", "off", r.run, "-", "Cloudflare's analytics script was loaded with analytics switched off");
      continue;
    }
    if (r.J === "switch-off") {
      let after = false;
      for (const s of r.steps) { if (after) for (const e of s.ev) add("block", "off", r.run, s.step, `${e.name} was sent after the switch in settings was turned off`); if (s.step === "off") after = true; }
      if (r.app && !r.calls.includes("setAnalytics")) add("block", "off", r.run, "off", "turning the switch off did not tell the app (AndroidApp.setAnalytics): Firebase would go on collecting on its own");
      continue;
    }
    judge(r);
    if (r.o.arrival) {
      const a = r.o.arrival, e = r.steps.flatMap((s) => s.ev).find((x) => x.name === a.ev);
      if (!e) add("block", "funnel", r.run, "load", `a visit by ${a.query} should count ${a.ev}, and nothing was sent`);
      else for (const [k, v] of Object.entries(a.has)) if (e.raw[k] !== v) add("block", "funnel", r.run, "load", `${a.ev} for ${a.query} should carry ${k}=${v}, it carries ${k}=${e.raw[k]}`);
    }
  }

  // the app and the website, the same journey on a phone: the same events at the same steps (until either went off its path)
  const by = (dev) => new Map(results.filter((r) => r.dev === dev && !r.o.off && r.J !== "switch-off").map((r) => [`${r.J}/${r.st}`, r]));
  const A = by("app-360"), W = by("web-390"), names = (ev, only) => ev.map((e) => e.name).filter((n) => !only[n] && !SOMETIMES[n]).sort().join(",");
  for (const [k, a] of A) {
    const w = W.get(k); if (!w) continue;
    // offline, the website keeps its events until the network is back and the app's Firebase keeps its own: the whole journey is compared
    if (k.startsWith("offline/")) { const an = names(a.steps.flatMap((s) => s.ev), ONLY_APP), wn = names(w.steps.flatMap((s) => s.ev), ONLY_WEB); if (an !== wn) add("warn", "parity", k, "-", `over the journey the app sends [${an}] and the website [${wn}]`); continue; }
    for (const s of a.steps) {
      if ((a.off && s.step === a.off) || (w.off && s.step === w.off)) break;
      const ws = w.steps.find((x) => x.step === s.step); if (!ws) continue;
      const an = names(s.ev, ONLY_APP), wn = names(ws.ev, ONLY_WEB);
      if (an !== wn) add("warn", "parity", `${k}`, s.step, `the app sends [${an || "nothing"}] and the website [${wn || "nothing"}] for the same step`);
    }
  }
  // coverage: what the dashboard reads that no journey produced (sent elsewhere: a purchase, a notification, an install)
  const produced = new Set(results.flatMap((r) => r.steps.flatMap((s) => s.ev.map((e) => e.name))));
  const notWalked = [...R].filter((e) => S.has(e) && !produced.has(e) && !/^(first_open|first_visit|session_start|user_engagement|page_view|screen_view|app_remove|app_update|os_update|app_clear_data|in_app_purchase|notification_\w+)$/.test(e));

  // the record: per run and step, each event, what left the page and what arrived
  fs.writeFileSync(path.join(OUT, "events.json"), JSON.stringify(results.map((r) => ({ run: r.run, off: r.off, steps: r.steps.map((s) => ({ step: s.step, ev: s.ev.map((e) => ({ name: e.name, sent: e.raw, arrived: r.app ? e.kept : e.web && e.web.ev ? e.web.ev.params : null })) })).filter((s) => s.ev.length) })), null, 1));
  fs.writeFileSync(path.join(OUT, "findings.json"), JSON.stringify(findings, null, 1));
  const groups = {};
  for (const f of findings) { const k = f.sev + "|" + f.kind + "|" + f.msg.replace(/\d+/g, "#"); (groups[k] = groups[k] || { ...f, n: 0, runs: [] }).n++; groups[k].runs.push(f.run + " " + f.step); }
  const list = Object.values(groups).sort((a, b) => (a.sev === b.sev ? b.n - a.n : a.sev === "block" ? -1 : 1));
  for (const g of list) console.log(`${g.sev === "block" ? "::error::" : "::warning::"}(analytics) [${g.kind}] ${g.msg} (${g.n}x, e.g. ${g.runs[0]})`);
  if (notWalked.length) console.log(`analytics-flows: read by the dashboard, sent by the code, not met on the journeys (purchases, alerts, installs...): ${notWalked.join(", ")}`);
  const nEv = results.reduce((n, r) => n + r.steps.reduce((m, s) => m + s.ev.length, 0), 0), blocks = findings.filter((f) => f.sev === "block").length;
  console.log(`analytics-flows: ${results.length} journeys, ${nEv} events followed (${produced.size} kinds), ${R.size} read by the dashboard, in ${Math.round((Date.now() - t0) / 1000)} s: ${blocks} blocking, ${findings.length - blocks} warnings, ${list.length} distinct`);
  process.exit(blocks ? 1 : 0);
})().catch((e) => { console.log("::error::(analytics) the run crashed: " + (e && e.stack || e)); process.exit(2); });
