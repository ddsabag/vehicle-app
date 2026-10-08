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
const NOISE = new Set(["HB", "H/B", "HATCHBACK", "SEDAN", "SDN", "SD", "SW", "S/W", "WAGON", "ESTATE", "STATION", "LIFTBACK", "TS", "TOURING", "SPORTS", "HSD", "HEV", "HYBRID", "HV", "PHEV", "PLUG-IN", "2D", "3D", "4D", "5D", "2DR", "3DR", "4DR", "5DR"]);
const norm = m => { const t = String(m || "").trim().toUpperCase().replace(/\s+/g, " ").split(" "); const k = t.filter(x => !NOISE.has(x)); return (k.length ? k : t).join(" "); };
const acc = new Map(), extra = new Map();
for (const id of SETS) {
  for (let off = 0; ; off += PAGE) {
    let r;
    try { r = await call({resource_id: id, limit: String(PAGE), offset: String(off), fields: "tozeret_nm,tozeret_eretz_nm,kinuy_mishari,degem_nm,shnat_yitzur,merkav,delek_nm,mehir"}, 2); }
    catch { try { r = await call({resource_id: id, limit: String(PAGE), offset: String(off)}); } catch (e) { console.log("skipped", id, String(e).slice(0, 100)); break; } }
    for (const x of r.records) {
      let mk = String(x.tozeret_nm || "").trim(); const c = String(x.tozeret_eretz_nm || "").trim();
      if (c && mk.endsWith(" " + c)) mk = mk.slice(0, -c.length - 1);
      mk = mk.replace(COUNTRY, "");
      const md = norm(x.kinuy_mishari || x.degem_nm); if (!mk || !md) continue;
      const y = Number(x.shnat_yitzur) || 0, k = mk + "|" + md, e = acc.get(k) || [mk, md, 9999, 0];
      if (y) { e[2] = Math.min(e[2], y); e[3] = Math.max(e[3], y); }
      acc.set(k, e);
      const x2 = extra.get(k) || {py: 0, pm: 0, body: new Map(), fuel: new Set()};
      const mh = Number(x.mehir) || 0;
      if (mh > 0 && y >= x2.py) { if (y > x2.py) { x2.py = y; x2.pm = mh; } else x2.pm = Math.min(x2.pm, mh); }
      if (y >= 2022) {
        const bd = String(x.merkav || "").trim(); if (bd) x2.body.set(bd, (x2.body.get(bd) || 0) + 1);
        const dl = String(x.delek_nm || ""); if (dl) x2.fuel.add(dl);
      }
      extra.set(k, x2);
    }
    if (r.records.length < PAGE) break;
  }
}
for (const [k, e] of acc) {
  const x2 = extra.get(k); if (!x2) continue;
  const body = [...x2.body.entries()].sort((a, b) => b[1] - a[1])[0];
  e[4] = x2.py && x2.pm ? Math.round(x2.pm / 100) / 10 : 0; e[5] = body ? body[0] : ""; e[6] = [...x2.fuel].join("|");
}
const rows = [...acc.values()].filter(e => e[3] > 0).sort((a, b) => a[0].localeCompare(b[0], "he") || a[1].localeCompare(b[1]));
fs.mkdirSync("out", {recursive: true});
fs.writeFileSync("out/models.json", JSON.stringify({updated: new Date().toISOString().slice(0, 10), rows}));
console.log("models", rows.length, "makers", new Set(rows.map(r => r[0])).size);
