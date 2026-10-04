// Builds market.json: car-market statistics from the Ministry of Transport open datasets.
// Run on a GitHub runner (data.gov.il blocks some other networks). Writes out/market.json and prints a short summary.
import fs from "node:fs";
const API = "https://data.gov.il/api/3/action/datastore_search";
const DELIV = "602ac32d-19c0-4b41-88e0-e3ce8a7e80b7", COUNTS = "5e87a7a1-2f6f-41c1-8aec-7216d52a6cf6", ACTIVE = "053cea08-09bc-40ec-8f7a-156f0677aff3";
const IMPORT = "03adc637-b6fe-402b-9937-7c3d3afc9140", EVAREA = "07421a4e-5b12-4444-9173-5ca297b31f79";
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
// pages through a resource; onRows may return false to stop early
async function scan(id, extra, onRows) {
  for (let off = 0; ; off += PAGE) {
    const r = await call({resource_id: id, limit: String(PAGE), offset: String(off), ...extra});
    if (!r.records.length) break;
    if (onRows(r.records) === false || r.records.length < PAGE) break;
  }
}
const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const out = {updated: new Date().toISOString().slice(0, 10), notes: {}};

// maker (brand) per factory code
const brand = {};
await scan(COUNTS, {fields: "tozeret_cd,tozar"}, rows => { for (const r of rows) if (r.tozar) brand[r.tozeret_cd] = String(r.tozar).trim(); });
console.log("brands", Object.keys(brand).length);

// 1. deliveries of new private cars per month, 2022 on
const months = {}, makers = {}, models = {};
await scan(DELIV, {sort: "sgira_month desc", filters: JSON.stringify({sug_degem: "P"}), fields: "sgira_month,tozeret_cd,tozeret_nm,kinuy_mishari,car_num"}, rows => {
  let go = true;
  for (const r of rows) {
    if (r.sgira_month < 202201) { go = false; continue; }
    const m = String(r.sgira_month), y = m.slice(0, 4), n = Number(r.car_num) || 0;
    const mk = brand[r.tozeret_cd] || String(r.tozeret_nm).split(" ")[0];
    inc(months, m, n);
    (makers[mk] ||= {})[m] = (makers[mk][m] || 0) + n;
    const key = mk + "|" + String(r.kinuy_mishari || "").trim();
    (models[key] ||= {})[m] = (models[key][m] || 0) + n;
  }
  return go;
});
out.months = months; out.makers = makers;
// keep the 150 biggest models
out.models = Object.fromEntries(Object.entries(models).sort((a, b) => Object.values(b[1]).reduce((s, x) => s + x, 0) - Object.values(a[1]).reduce((s, x) => s + x, 0)).slice(0, 150));
console.log("months", Object.keys(months).length, "makers", Object.keys(makers).length, "models", Object.keys(models).length);

// 2. ownership and fuel of cars by production year (current registered owner type, a proxy for who bought)
out.ownership = {}; out.fuel = {}; out.ownershipMakers = {};
for (const y of [2022, 2023, 2024, 2025, 2026]) {
  const own = {}, fuel = {}, om = {}; let n = 0;
  try {
    await scan(ACTIVE, {filters: JSON.stringify({shnat_yitzur: y}), fields: "baalut,sug_delek_nm,tozeret_cd,tozeret_nm"}, rows => {
      for (const r of rows) {
        n++; const b = r.baalut || "אחר"; inc(own, b); inc(fuel, r.sug_delek_nm || "אחר");
        const mk = brand[r.tozeret_cd] || String(r.tozeret_nm || "").split(" ")[0]; (om[mk] ||= {}); inc(om[mk], b);
      }
    });
  } catch (e) { console.log("active", y, e.message); }
  out.ownership[y] = own; out.fuel[y] = fuel;
  out.ownershipMakers[y] = Object.fromEntries(Object.entries(om).sort((a, b) => Object.values(b[1]).reduce((s, x) => s + x, 0) - Object.values(a[1]).reduce((s, x) => s + x, 0)).slice(0, 25));
  console.log("year", y, n, JSON.stringify(own));
}

// 3. personal import
const imp = {}; let impFields = null;
try {
  await scan(IMPORT, {}, rows => { for (const r of rows) { inc(imp, r.sug_yevu || "יבוא אישי"); } });
  const f = await call({resource_id: IMPORT, limit: "2"}); impFields = f.fields.map(x => x.id); out.importSample = f.records;
} catch (e) { console.log("import", e.message); }
out.import = imp; console.log("import", JSON.stringify(imp), impFields);

// 4. EVs by area
try { const r = await call({resource_id: EVAREA, limit: "200"}); out.evArea = r.records.map(x => ({own: x.baalut, district: x.mahoz_nm, area: x.nafa_nm, n: x.car_num})); } catch (e) { console.log("ev", e.message); }

fs.mkdirSync("out", {recursive: true});
fs.writeFileSync("out/market.json", JSON.stringify(out));
const ms = Object.keys(months).sort();
console.log("size", JSON.stringify(out).length, "range", ms[0], ms[ms.length - 1]);
console.log("last 6 months", ms.slice(-6).map(m => m + ":" + months[m]).join(" "));
const top = Object.entries(makers).map(([k, v]) => [k, Object.entries(v).filter(([m]) => m.startsWith("2025")).reduce((s, [, x]) => s + x, 0)]).sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log("top makers 2025", JSON.stringify(top));
