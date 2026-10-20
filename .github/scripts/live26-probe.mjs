// One-off (probe-go branch, not for main), 20.10, before live-26 ships: (1) are GA4 realtime minute buckets ("minutesAgo") whole clock
// minutes? today's per-minute count relies on it; (2) live-26's rtToday() three times, with an in-memory stand-in for the Worker's cache:
// today's count must never drop; (3) collect() with the real keys and the page in Chrome. Prints aggregates only.
const say = (...a) => console.log(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
const env = { GA_SERVICE_ACCOUNT_JSON: process.env.GA_SERVICE_ACCOUNT_JSON, GA_PROPERTY_ID: "557990379", CF_API_TOKEN: process.env.CF_API_TOKEN, CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID, PLAY_REPORTS_BUCKET: "pubsite_prod_4688106336294834537" };
const store = new Map();
globalThis.caches = { default: { match: async k => store.has(String(k)) ? new Response(store.get(String(k))) : undefined, put: async (k, r) => { store.set(String(k), await r.text()); } } };
const m = await import("./live26.mjs");
const waitSec = s => new Promise(r => setTimeout(r, (s * 1000 - Date.now() % 60000 + 60000) % 60000));
say("at", new Date().toISOString());

// 1. bucket alignment: all events, every country (the most volume), at :46 and :54 of one minute, then :04 and :14 of the next
const buckets = async () => { const rows = await m.realtime(env, { dimensions: [{ name: "minutesAgo" }], metrics: [{ name: "eventCount" }], limit: 100 }); const a = Array(30).fill(0); for (const r of rows) a[Number(r.dimensionValues[0].value)] = Number(r.metricValues[0].value); return a; };
const q = [];
for (const s of [46, 54, 4, 14]) { await waitSec(s); q.push({ at: new Date().toISOString().slice(11, 19), b: await buckets() }); }
for (const x of q) say("buckets at", x.at, x.b.join(" "));
const diff = (a, b, sh) => { let d = 0, n = 0; for (let k = 1; k + sh < 30 && k < 29; k++) { n++; if (a[k] !== b[k + sh]) d++; } return d + "/" + n; };
say("same minute, :46 vs :54 (buckets 1-28 differ):", diff(q[0].b, q[1].b, 0), "| next minute :04 vs :14:", diff(q[2].b, q[3].b, 0));
say("across the minute, :54 bucket k vs :04 bucket k+1 (differ):", diff(q[1].b, q[2].b, 1), "| without the shift:", diff(q[1].b, q[2].b, 0));

// 2. rtToday three times, a minute apart: the totals must never drop, and must hold at least the last 30 minutes
const today = m.ilDay(Date.now()), RT = ["first_open", "car_lookup"];
const win = async () => { const rows = await m.realtime(env, { dimensions: [{ name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: { andGroup: { expressions: [m.REAL, { filter: { fieldName: "eventName", inListFilter: { values: RT } } }] } } }); const o = {}; for (const r of rows) o[r.dimensionValues[0].value] = Number(r.metricValues[0].value); return o; };
for (const s of [20, 25, 30]) { await waitSec(s); const t = await m.rtToday(env, today), w = await win(); const kept = JSON.parse(store.get("https://luchit.app/live/_rt/" + today) || "{}"); say("rtToday at", new Date().toISOString().slice(11, 19), t, "| last 30 minutes:", w, "| minutes kept:", Object.keys(kept).length); }

// 3. collect() and the page
const real = globalThis.fetch; let calls = 0;
globalThis.fetch = (u, o) => { calls++; return real(u, o); };
const d = await m.collect(env);
globalThis.fetch = real;
say("collect:", calls, "outside calls | build", d.build, "| rtToday", d.rtToday, "| realtime first_open (30 min):", (d.events || []).find(e => e[0] === "first_open") || null);
const errs = []; (function walk(o, p) { if (!o || typeof o !== "object") return; for (const [k, v] of Object.entries(o)) { if (k === "errors" && v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length) errs.push([p + k, v]); else walk(v, p + k + "."); } })(d, "");
say("source errors:", errs.length ? errs : "none", "| life today:", d.daily && d.daily.life ? d.daily.life[today] || null : null, "| play active:", d.stats ? [d.stats.active, d.stats.activeDay] : null);
const full = { ...JSON.parse(JSON.stringify(d)), flashes: (await m.getFlashes()).slice(0, 15), metrics: await m.getMetrics() };
const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
for (const [name, vp] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 900 }]]) {
  const page = await browser.newPage({ viewport: vp, locale: "he-IL", timezoneId: "Asia/Jerusalem" });
  const bad = [];
  page.on("pageerror", e => bad.push("pageerror: " + e.message));
  await page.route("**/*", r => { const u = new URL(r.request().url()); if (u.pathname === "/live/data") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(full) }); if (u.hostname === "luchit.app" && u.pathname === "/live") return r.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: m.PAGE }); return r.abort(); });
  await page.goto("https://luchit.app/live", { waitUntil: "load" });
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => {
    document.querySelectorAll("details").forEach(x => { x.open = true; });
    const t = document.body.innerText;
    return { hits: ["NaN", "undefined", "Infinity", "[object"].filter(w => t.includes(w)), inst: (t.match(/מותקנת עכשיו[^\n]*/) || [""])[0], how: (t.match(/[^\n]*מכשירים לפי Google Play[^\n]*/) || [""])[0], sofar: t.split("\n").filter(l => /עד כה|נקלט בזמן אמת/.test(l)).slice(0, 6), scrollW: document.documentElement.scrollWidth, innerW: innerWidth, build: (t.match(/live-\d+/) || [""])[0] };
  });
  say(`page ${name}:`, r, "| page errors:", bad.length ? bad : "none");
  await page.close();
}
await browser.close();
