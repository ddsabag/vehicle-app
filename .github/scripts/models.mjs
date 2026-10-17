// Builds models.json: every maker + model name in the Ministry's model catalogue (WLTP + price list), so the app can match
// Hebrew free text ("צ'רי טיגו 7") to the catalogue spelling (CHERY TIGGO 7). Run on a GitHub runner.
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
const NOISE = new Set(["HB", "H/B", "HATCHBACK", "SEDAN", "SDN", "SD", "SW", "S/W", "WAGON", "ESTATE", "STATION", "LIFTBACK", "TS", "TOURING", "SPORTS", "HSD", "HEV", "HYBRID", "HV", "PHEV", "PLUG-IN", "2D", "3D", "4D", "5D", "2DR", "3DR", "4DR", "5DR", "H", "4MATIC", "4MATI", "4MAT", "4M", "XDRIVE", "SDRIVE", "AWD", "4WD", "4X4", "2WD", "FWD", "RWD", "ALL4"]);
const HYBRID_RX = /^E?-?H[YI]B[A-Z]*$|^E?-?HY$/;   // as in index.html: the register's many spellings of hybrid
const PLUG_E = /^[A-Z]{1,3}\d{2,4}E$|^\d{3,4}E$/;   // C300E, GLC 350E: the plug-in version (a bare 530E / 500E keeps its name)
const isNoise = x => NOISE.has(x) || HYBRID_RX.test(x);
const norm = m => { const t = String(m || "").trim().toUpperCase().replace(/\s+/g, " ").split(" ").map(x => x.replace(/-([A-Z]+)$/, (w, sfx) => isNoise(sfx) ? "" : w)).map((x, i) => PLUG_E.test(x) && (i > 0 || /^[A-Z]/.test(x)) ? x.slice(0, -1) : x); const k = t.filter(x => !isNoise(x)); if (k.length > 1 && k[k.length - 1] === "E" && k[k.length - 2] !== "MACH") k.pop(); return (k.length ? k : t).join(" "); };
const acc = new Map(), wmap = new Map(), prices = [];
for (const id of SETS) {
  for (let off = 0; ; off += PAGE) {
    let r;
    try { r = await call({resource_id: id, limit: String(PAGE), offset: String(off), fields: "tozeret_cd,degem_cd,tozeret_nm,tozeret_eretz_nm,kinuy_mishari,degem_nm,shnat_yitzur,merkav,delek_nm,mehir"}, 2); }
    catch { try { r = await call({resource_id: id, limit: String(PAGE), offset: String(off)}); } catch (e) { console.log("skipped", id, String(e).slice(0, 100)); break; } }
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
fs.mkdirSync("out", {recursive: true});
fs.writeFileSync("out/models.json", JSON.stringify({updated: new Date().toISOString().slice(0, 10), rows}));
console.log("models", rows.length, "makers", new Set(rows.map(r => r[0])).size);
