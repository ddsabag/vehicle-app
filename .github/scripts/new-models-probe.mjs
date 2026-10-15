// One-off probe for the "new models by quarter" magazine idea: reads the full deliveries register (no 150-model cap) and prints,
// per calendar quarter, the models whose first delivery fell in it. Prints only; changes nothing.
const API = "https://data.gov.il/api/3/action/datastore_search";
const DELIV = "602ac32d-19c0-4b41-88e0-e3ce8a7e80b7", COUNTS = "5e87a7a1-2f6f-41c1-8aec-7216d52a6cf6", PAGE = 30000;
async function call(params, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(API + "?" + new URLSearchParams(params), { signal: AbortSignal.timeout(90000) }); const j = await r.json(); if (j.success) return j.result; } catch {}
    await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }
  throw new Error("failed " + JSON.stringify(params).slice(0, 120));
}
async function scan(id, extra, onRows) {
  for (let off = 0; ; off += PAGE) {
    const r = await call({ resource_id: id, limit: String(PAGE), offset: String(off), ...extra });
    if (!r.records.length) break;
    if (onRows(r.records) === false || r.records.length < PAGE) break;
  }
}
const brand = {};
await scan(COUNTS, { fields: "tozeret_cd,tozar" }, rows => { for (const r of rows) if (r.tozar) brand[r.tozeret_cd] = String(r.tozar).trim(); });
const models = {}; let rowsSeen = 0, maxMonth = 0;
await scan(DELIV, { sort: "sgira_month desc", filters: JSON.stringify({ sug_degem: "P" }), fields: "sgira_month,tozeret_cd,tozeret_nm,kinuy_mishari,car_num" }, rows => {
  let go = true;
  for (const r of rows) {
    rowsSeen++; if (r.sgira_month < 202201) { go = false; continue; }
    maxMonth = Math.max(maxMonth, r.sgira_month);
    const k = (brand[r.tozeret_cd] || String(r.tozeret_nm).split(" ")[0]) + "|" + String(r.kinuy_mishari || "").trim();
    const m = String(r.sgira_month); (models[k] ||= {})[m] = (models[k][m] || 0) + (Number(r.car_num) || 0);
  }
  return go;
});
console.log("rows", rowsSeen, "models", Object.keys(models).length, "latest month", maxMonth);
const q = m => m.slice(0, 4) + " Q" + Math.ceil(+m.slice(4) / 3), by = {};
for (const [k, v] of Object.entries(models)) {
  const ms = Object.keys(v).filter(m => v[m] > 0).sort(); if (!ms.length || ms[0] < "202507") continue;
  const Q = q(ms[0]), inQ = ms.filter(m => q(m) === Q).reduce((t, m) => t + v[m], 0), tot = ms.reduce((t, m) => t + v[m], 0);
  (by[Q] ||= []).push({ k, first: ms[0], inQ, tot });
}
for (const Q of Object.keys(by).sort()) {
  console.log("\n== " + Q);
  for (const x of by[Q].sort((a, b) => b.inQ - a.inQ)) console.log(`${x.inQ >= 100 ? "*" : " "} ${x.k.padEnd(40)} first ${x.first}  quarter ${x.inQ}  total ${x.tot}`);
}
