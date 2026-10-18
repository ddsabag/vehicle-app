// Builds models.json: every maker + model name in the Ministry's model catalogue (WLTP + price list), so the app can match
// Hebrew free text ("צ'רי טיגו 7") to the catalogue spelling (CHERY TIGGO 7). Run on a GitHub runner.
// A skipped or short dataset, or a big drop against the published models.json, writes nothing and exits 1 (SKIP_GATE=1 writes anyway).
import fs from "node:fs";
const API = "https://data.gov.il/api/3/action/datastore_search";
const SETS = ["142afde2-6228-49f9-8a29-9b6c3a0cbe40", "39f455bf-6db0-4926-859d-017f34eacbcb"];
const PAGE = 30000;
async function call(params, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(API + "?" + new URLSearchParams(params), {signal: AbortSignal.timeout(90000)});
      const j = await r.json(); if (j.success) return j.result;
    } catch {}
    await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }
  throw new Error("failed " + JSON.stringify(params).slice(0, 120));
}
const COUNTRY = /\s+(יפן|בריטניה|אנגליה|צרפת|גרמניה|קוריאה|ספרד|צ'כיה|צכיה|טורקיה|סין|ארה"ב|ארהב|איטליה|תאילנד|הודו|מקסיקו|הונגריה|סלובקיה|פולין|רומניה|בלגיה|שבדיה|אוסטריה|פורטוגל|דרום אפריקה|ברזיל|קנדה|הולנד|סלובניה|רוסיה|מרוקו|אינדונזיה|מלזיה|טייוואן|ישראל)$/;
const NOISE = new Set(["HB", "H/B", "HATCHBACK", "SEDAN", "SDN", "SD", "SW", "S/W", "WAGON", "ESTATE", "STATION", "LIFTBACK", "TS", "TOURING", "SPORTS", "HSD", "HEV", "HYBRID", "HV", "PHEV", "PLUG-IN", "2D", "3D", "4D", "5D", "2DR", "3DR", "4DR", "5DR"]);
const norm = m => { const t = String(m || "").trim().toUpperCase().replace(/\s+/g, " ").split(" "); const k = t.filter(x => !NOISE.has(x)); return (k.length ? k : t).join(" "); };
const acc = new Map(), wmap = new Map(), prices = [], failed = [];
for (const id of SETS) {
  let read = 0, all = null, skipped = false;
  for (let off = 0; ; off += PAGE) {
    let r;
    try { r = await call({resource_id: id, limit: String(PAGE), offset: String(off), fields: "tozeret_cd,degem_cd,tozeret_nm,tozeret_eretz_nm,kinuy_mishari,degem_nm,shnat_yitzur,merkav,delek_nm,mehir"}, 2); }
    catch { try { r = await call({resource_id: id, limit: String(PAGE), offset: String(off)}); } catch (e) { console.log("skipped", id, String(e).slice(0, 100)); failed.push(`${id} skipped at row ${off}`); skipped = true; break; } }
    if (all === null) all = r.total;
    read += r.records.length;
    for (const x of r.records) {
      let mk = String(x.tozeret_nm || "").trim(); const c = String(x.tozeret_eretz_nm || "").trim();
      if (c && mk.endsWith(" " + c)) mk = mk.slice(0, -c.length - 1);
      mk = mk.replace(COUNTRY, "");
      const md = norm(x.kinuy_mishari || x.degem_nm); if (!mk || !md) continue;
      const y = Number(x.shnat_yitzur) || 0, k = mk + "|" + md, e = acc.get(k) || [mk, md, 9999, 0];
      if (y) { e[2] = Math.min(e[2], y); e[3] = Math.max(e[3], y); }
      acc.set(k, e);
      const cd = String(x.tozeret_cd), dg = String(x.degem_cd), mh = Number(x.mehir) || 0;
      if (id === SETS[0]) { const w = wmap.get(cd + "|" + dg); if (!w || y >= w.y) wmap.set(cd + "|" + dg, {y, bd: String(x.merkav || "").trim(), dl: String(x.delek_nm || "")}); }
      else if (mh > 0 && y) prices.push({k, cd, dg, y, mh});
    }
    if (r.records.length < PAGE) break;
  }
  if (!skipped && all && read < all * 0.995) failed.push(`${id}: read ${read} of ${all}`);
}
const fuelClass = dl => dl.includes("/") ? "h" : dl.includes("חשמל") ? "e" : dl.includes("דיזל") ? "d" : dl.includes("בנזין") ? "p" : "";
const per = new Map();
for (const r of prices) { const o = per.get(r.k) || {top: 0, list: []}; o.top = Math.max(o.top, r.y); o.list.push(r); per.set(r.k, o); }
for (const [k, o] of per) {
  const e = acc.get(k); if (!e) continue;
  let best = 0; const fp = {}, bodies = new Map();
  for (const r of o.list) {
    if (r.y < o.top - 1) continue;
    const m = Math.round(r.mh / 100) / 10; if (r.y === o.top) best = best ? Math.min(best, m) : m;
    const w = wmap.get(r.cd + "|" + r.dg); if (!w) continue;
    const c = fuelClass(w.dl); if (c) fp[c] = fp[c] ? Math.min(fp[c], m) : m;
    if (w.bd) bodies.set(w.bd, (bodies.get(w.bd) || 0) + 1);
  }
  const bd = [...bodies.entries()].sort((a, b) => b[1] - a[1])[0];
  e[4] = best; e[5] = bd ? bd[0] : ""; e[6] = Object.entries(fp).map(([c, m]) => c + m).join("|");
}
const rows = [...acc.values()].filter(e => e[3] > 0).sort((a, b) => a[0].localeCompare(b[0], "he") || a[1].localeCompare(b[1]));

// sanity gate, as catalog-build.mjs does: a skipped dataset leaves names without prices or body types (the budget finder and similar cars go empty).
// Thresholds are loose on purpose: the biggest change between published versions was -5.3% rows (6498 -> 6153 on 2026-10-17, a folding-rule
// change, reverted the same day); makers 203-205; priced, body and fuel shares moved under 1%.
const problems = [...failed];
const shape = list => ({rows: list.length, makers: new Set(list.map(r => r[0])).size, price: list.filter(r => r[4] > 0).length / (list.length || 1), body: list.filter(r => r[5]).length / (list.length || 1), fuel: list.filter(r => r[6]).length / (list.length || 1)});
let prev = null; try { prev = JSON.parse(fs.readFileSync("models.json", "utf8")); } catch {}
const cur = shape(rows);
if (!cur.rows) problems.push("no models");
if (prev && Array.isArray(prev.rows) && prev.rows.length) {
  const was = shape(prev.rows);
  if (cur.rows < 0.8 * was.rows) problems.push(`${cur.rows} models, ${was.rows} before`);
  if (cur.makers < 0.9 * was.makers) problems.push(`${cur.makers} makers, ${was.makers} before`);
  for (const [k, what] of [["price", "with a list price"], ["body", "with a body type"], ["fuel", "with a price per fuel"]])
    if (was[k] && cur[k] < 0.8 * was[k]) problems.push(`models ${what}: ${(cur[k] * 100).toFixed(1)}%, ${(was[k] * 100).toFixed(1)}% before`);
}
if (problems.length) {
  for (const p of problems) console.log(`::${process.env.SKIP_GATE === "1" ? "warning" : "error"}::models.json check: ${p}`);
  if (process.env.SKIP_GATE !== "1") { console.log("not written: the published models.json stays. If the change is real (e.g. a folding-rule change), re-run with skip_gate."); process.exit(1); }
}
fs.mkdirSync("out", {recursive: true});
fs.writeFileSync("out/models.json", JSON.stringify({updated: new Date().toISOString().slice(0, 10), rows}));
console.log("models", rows.length, "makers", new Set(rows.map(r => r[0])).size);
