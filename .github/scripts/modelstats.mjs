// Builds modelstats.json: per model (tozeret_cd|kinuy_mishari) and production year, from the Ministry of Transport open datasets:
// active cars, cars taken off the road, typical km at the last test, ownership records per car, open recalls.
// Runs on a GitHub runner (data.gov.il blocks other networks). Writes out/modelstats.json.
import fs from "node:fs";
const API = "https://data.gov.il/api/3/action/datastore_search";
const ID = {
  active: "053cea08-09bc-40ec-8f7a-156f0677aff3", cancel: ["851ecab1-0622-4dbe-a6c7-f950cf82abf9", "4e6b9724-4c1e-43f0-909a-154d4cc4e046", "ec8cbc34-72e1-4b69-9c48-22821ba0bd6c"],
  tech: "56063a99-8a3e-4ff4-912e-5966c0279bad", owners: "bb2355dc-9ec7-4f06-9c3f-3344672171da", recall: "36bf1404-0be4-49d2-82dc-2f1ead4a8b93",
};
const PAGE = 30000, T0 = Date.now();
const log = m => console.log(`[${Math.round((Date.now() - T0) / 1000)}s] ${m}`);
async function call(params, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(API + "?" + new URLSearchParams(params), {signal: AbortSignal.timeout(120000)});
      const j = await r.json(); if (j.success) return j.result;
    } catch {}
    await new Promise(r => setTimeout(r, 3000 * (i + 1)));
  }
  throw new Error("failed " + JSON.stringify(params).slice(0, 120));
}
async function scan(id, fields, onRows) {
  let total = 0;
  for (let off = 0; ; off += PAGE) {
    const r = await call({resource_id: id, limit: String(PAGE), offset: String(off), fields});
    if (!r.records.length) break;
    onRows(r.records); total += r.records.length;
    if (r.records.length < PAGE) break;
  }
  return total;
}
const norm = s => String(s || "").trim().toUpperCase();
const cohortIds = new Map(), cohorts = [];   // "cd|model|year" -> id
const idOf = (cd, model, y) => { const k = cd + "|" + model + "|" + y; let i = cohortIds.get(k); if (i === undefined) { i = cohorts.length; cohortIds.set(k, i); cohorts.push({cd, model, y, n: 0, c: 0, kmSum: 0, kmN: 0, own: 0, ownN: 0, rec: 0, name: ""}); } return i; };

// 1. active cars: plate -> cohort
const plate = new Map();
log("active: " + await scan(ID.active, "mispar_rechev,tozeret_cd,kinuy_mishari,shnat_yitzur,tozeret_nm", rows => {
  for (const r of rows) {
    const y = Number(r.shnat_yitzur), m = norm(r.kinuy_mishari); if (!y || !m || !r.tozeret_cd) continue;
    const i = idOf(r.tozeret_cd, m, y); cohorts[i].n++; if (!cohorts[i].name) cohorts[i].name = String(r.tozeret_nm || "").trim();
    plate.set(r.mispar_rechev, i);
  }
}));
// 2. cars taken off the road (final cancellation)
for (const id of ID.cancel) log("cancel: " + await scan(id, "tozeret_cd,kinuy_mishari,shnat_yitzur", rows => {
  for (const r of rows) {
    const y = Number(r.shnat_yitzur), m = norm(r.kinuy_mishari); if (!y || !m || !r.tozeret_cd) continue;
    cohorts[idOf(r.tozeret_cd, m, y)].c++;
  }
}));
// 3. km at the last test (active cars only)
log("tech: " + await scan(ID.tech, "mispar_rechev,kilometer_test_aharon", rows => {
  for (const r of rows) {
    const i = plate.get(r.mispar_rechev), km = Number(r.kilometer_test_aharon); if (i === undefined || !(km > 0) || km > 999999) continue;
    cohorts[i].kmSum += km; cohorts[i].kmN++;
  }
}));
// 4. ownership records per car (log starts 2017: a floor, but comparable between models)
const seen = new Map();
log("owners: " + await scan(ID.owners, "mispar_rechev", rows => { for (const r of rows) seen.set(r.mispar_rechev, (seen.get(r.mispar_rechev) || 0) + 1); }));
for (const [p, n] of seen) { const i = plate.get(p); if (i !== undefined) { cohorts[i].own += n; cohorts[i].ownN++; } }
// 5. open recalls (cars with at least one)
const rc = new Set();
log("recall: " + await scan(ID.recall, "MISPAR_RECHEV", rows => { for (const r of rows) rc.add(r.MISPAR_RECHEV); }));
for (const p of rc) { const i = plate.get(p); if (i !== undefined) cohorts[i].rec++; }

// output: models with >= 500 active cars, cohorts with >= 100
const models = {};
for (const c of cohorts) { const k = c.cd + "|" + c.model, m = (models[k] ||= {name: c.name, total: 0, y: {}}); m.total += c.n; if (c.n >= 100 || c.c >= 100) m.y[c.y] = [c.n, c.c, c.kmN >= 30 ? Math.round(c.kmSum / c.kmN / 100) * 100 : null, c.ownN >= 30 ? +(c.own / c.ownN).toFixed(2) : null, c.n ? +(c.rec / c.n * 1000).toFixed(1) : 0]; }
const keep = Object.fromEntries(Object.entries(models).filter(([, m]) => m.total >= 500 && Object.keys(m.y).length));
const res = {updated: new Date().toISOString().slice(0, 10), cols: ["active", "offRoad", "kmAvg", "ownRecords", "recallsPer1000"], m: keep};
fs.mkdirSync("out", {recursive: true});
fs.writeFileSync("out/modelstats.json", JSON.stringify(res));
log(`models kept ${Object.keys(keep).length}, size ${(JSON.stringify(res).length / 1024).toFixed(0)} KB, cohorts ${cohorts.length}`);
const ex = keep["413|COROLLA"]; if (ex) console.log("Corolla sample", JSON.stringify(ex).slice(0, 700));
