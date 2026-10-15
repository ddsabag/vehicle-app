// Market-intelligence agent: turns the monthly market.json (new-car deliveries per model) and modelstats.json (cars on the road per model
// and production year, with the share held by leasing/rental companies) into short, hedged market tags per model: market-tags.json.
// The app shows them on the "קנייה" tab for PRO. No network: it only reads files the monthly workflows already produce.
// Usage: node market-intel.mjs [--selftest]   (inputs: market.json, modelstats.json, index.html in the working directory; output: market-tags.json)
import fs from "node:fs";

const RECENT = 3;                                // months in the comparison window (deliveries are seasonal, so each window is compared with the same months a year earlier)
const MIN_NOW = 450, MIN_PREV_UP = 150, MIN_PREV_DOWN = 600, UP = 1.5, DOWN = 0.5;
const MAX_UP = 4, MIN_DOWN = 0.1;   // beyond these the catalogue name most likely changed (new generation or a renamed variant), not the supply: no tag   // deliveries in the window, and the model-vs-market ratio that counts as a swing
const FLEET_MIN = 1000, FLEET_JUMP = 1.4, FLEET_SHARE = 25;                          // cars still in leasing/rental hands in the cohort that is about to leave a 3-year contract

// the app's own model-name folding, read from index.html so the two never drift apart
export function loadNormModel(html) {
  const a = html.indexOf("const NOISE_TOKENS"), b = html.indexOf("\n};", html.indexOf("const normModel")) + 3;
  if (a < 0 || b < 3) throw new Error("normModel not found in index.html");
  return new Function(html.slice(a, b) + "\nreturn normModel;")();
}
const firstWord = s => String(s || "").trim().split(/\s+/)[0];

export function build(market, stats, normModel, now = new Date()) {
  const key = (maker, model) => firstWord(maker) + "|" + normModel(model);
  const months = Object.keys(market.months || {}).sort();
  const win = months.slice(-RECENT), prevWin = win.map(m => String(Number(m.slice(0, 4)) - 1) + m.slice(4));
  const sum = (o, ms) => ms.reduce((t, m) => t + (o[m] || 0), 0);
  const mkNow = sum(market.months, win), mkPrev = sum(market.months, prevWin), mkRatio = mkPrev ? mkNow / mkPrev : 1;
  const tags = {}, add = (k, t) => (tags[k] ||= []).push(t);

  // 1. new-car deliveries: a model whose recent deliveries moved much more than the whole market, against the same months a year earlier
  const dl = {};
  for (const [k, v] of Object.entries(market.models || {})) {
    const i = k.indexOf("|"), kk = key(k.slice(0, i), k.slice(i + 1));
    const d = (dl[kk] ||= {now: 0, prev: 0, raw: k, top: 0}), c = sum(v, win); d.now += c; d.prev += sum(v, prevWin);
    if (c >= d.top) { d.top = c; d.raw = k; }   // the biggest catalogue entry names the model
  }
  for (const [k, d] of Object.entries(dl)) {
    const raw = d.raw;
    const rel = d.prev ? d.now / d.prev / mkRatio : Infinity;
    if (d.now >= MIN_NOW && d.prev >= MIN_PREV_UP && rel >= UP && d.now / d.prev <= MAX_UP * mkRatio)
      add(k, {m: raw, r: +rel.toFixed(2), v: d.now, k: "supply_up", t: "נמסרו יותר רכבים חדשים מהדגם", x: `ב-${RECENT} החודשים האחרונים נמסרו ${d.now.toLocaleString("en")} רכבים חדשים מהדגם, פי ${(d.now / d.prev).toFixed(1)} מאשר באותם חודשים אשתקד (השוק כולו: פי ${mkRatio.toFixed(1)}). ייתכן שההיצע הגדול יעלה את הלחץ על מחירי היד השנייה של הדגם.`});
    else if (d.prev >= MIN_PREV_DOWN && rel <= DOWN && d.now >= MIN_DOWN * d.prev)
      add(k, {m: raw, r: +rel.toFixed(2), v: d.now, k: "supply_down", t: "נמסרים פחות רכבים חדשים מהדגם", x: `ב-${RECENT} החודשים האחרונים נמסרו ${d.now.toLocaleString("en")} רכבים חדשים מהדגם, לעומת ${d.prev.toLocaleString("en")} באותם חודשים אשתקד. ייתכן שהיצע חדש נמוך יותר יתמוך במחירי היד השנייה, או שהדגם בדרך החוצה.`});
  }

  // 2. fleet wave: cars of the cohort that is about to finish a typical 3-year contract and are still held by leasing or rental companies,
  //    compared with the cohort a year older (current owner type, so cars already sold on to private owners are not counted)
  const y0 = now.getFullYear() - 3, byModel = {}, names = {};
  for (const [k, m] of Object.entries(stats.m || {})) {
    const mdl = k.slice(k.indexOf("|") + 1), kk = key(m.name, mdl), f = (byModel[kk] ||= {}); names[kk] ||= firstWord(m.name) + "|" + mdl;
    for (const y of [y0, y0 - 1]) { const r = m.y[y]; if (r && r[5] != null) { const o = (f[y] ||= {n: 0, fleet: 0}); o.n += r[0]; o.fleet += r[0] * r[5] / 100; } }
  }
  for (const [k, f] of Object.entries(byModel)) {
    const a = f[y0], b = f[y0 - 1]; if (!a || !b) continue;
    const share = a.n ? a.fleet / a.n * 100 : 0;
    if (a.fleet >= FLEET_MIN && b.fleet > 0 && a.fleet / b.fleet >= FLEET_JUMP && share >= FLEET_SHARE)
      add(k, {m: names[k], r: +(a.fleet / b.fleet).toFixed(2), v: Math.round(a.fleet), k: "fleet_wave", t: "גל רכבי ליסינג והשכרה לקראת השוק", x: `כ-${Math.round(a.fleet / 100) * 100} רכבים משנתון ${y0} עדיין רשומים על חברות ליסינג והשכרה (${Math.round(share)}% מהשנתון), פי ${(a.fleet / b.fleet).toFixed(1)} מהשנתון הקודם. בסוף חוזה של כ-3 שנים הם עוברים בדרך כלל למכירה, ולכן ייתכן שיעלה ההיצע של הדגם בשוק היד השנייה בחודשים הקרובים.`});
  }
  return {updated: now.toISOString().slice(0, 10), window: win, marketYoY: +mkRatio.toFixed(2), fleetYear: y0, tags};
}

function selftest(normModel) {
  const M = (a) => Object.fromEntries(a);
  const mk = (over) => { const o = {}; for (let y = 2025; y <= 2026; y++) for (let m = 1; m <= 12; m++) o[`${y}${String(m).padStart(2, "0")}`] = 0; return {...o, ...over}; };
  const months = M(Object.keys(mk({})).filter(k => k <= "202609").map(k => [k, 10000]));
  const surge = mk({}), flat = mk({}), drop = mk({});
  for (const k of Object.keys(months)) { surge[k] = k >= "202607" ? 400 : 100; flat[k] = 300; drop[k] = k >= "202607" ? 100 : 400; }
  const market = {months, models: {"קיה|SURGE X": surge, "טויוטה|FLAT": flat, "מאזדה|DROP": drop}};
  const stats = {m: {"1|SURGE X": {name: "קיה ד. קוריאה", y: {2023: [6000, 0, null, null, 0, 60], 2022: [5000, 0, null, null, 0, 20]}},
                      "2|FLAT": {name: "טויוטה יפן", y: {2023: [6000, 0, null, null, 0, 10], 2022: [6000, 0, null, null, 0, 10]}}}};
  const r = build(market, stats, normModel, new Date("2026-10-15"));
  const k = x => (r.tags[x] || []).map(t => t.k).sort().join(",");
  const ok = k("קיה|SURGE X") === "fleet_wave,supply_up" && k("מאזדה|DROP") === "supply_down" && !r.tags["טויוטה|FLAT"];
  console.log(ok ? "selftest ok" : "selftest FAILED " + JSON.stringify(r.tags)); if (!ok) process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith("market-intel.mjs")) {
  const norm = loadNormModel(fs.readFileSync("index.html", "utf8"));
  if (process.argv.includes("--selftest")) selftest(norm);
  else {
    const out = build(JSON.parse(fs.readFileSync("market.json", "utf8")), JSON.parse(fs.readFileSync("modelstats.json", "utf8")), norm);
    fs.writeFileSync("market-tags.json", JSON.stringify(out));
    const c = {}; for (const t of Object.values(out.tags).flat()) c[t.k] = (c[t.k] || 0) + 1;
    console.log("market-tags.json:", Object.keys(out.tags).length, "models", JSON.stringify(c), "window", out.window.join(","), "marketYoY", out.marketYoY);
  }
}
