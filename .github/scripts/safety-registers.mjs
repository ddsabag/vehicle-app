// One-off (probe-go branch, not for main), 20.10: does every register write the safety level like the active one (empty = level 0,
// otherwise the model-year-trim's level)? Samples cars built 2014-2026 in each register and compares the row's level with the WLTP
// row of its model, year, type and trim. Prints totals only, never a plate.
const API = "https://data.gov.il/api/3/action/datastore_search";
const T0 = Date.now(), log = m => console.log(`[${Math.round((Date.now() - T0) / 1000)}s] ${m}`);
async function call(params, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(API + "?" + new URLSearchParams(params), { signal: AbortSignal.timeout(120000) }); const j = await r.json(); if (j.success) return j.result; last = JSON.stringify(j.error || "").slice(0, 120); } catch (e) { last = e.message; }
    await new Promise(r => setTimeout(r, 4000 * (i + 1)));
  }
  throw new Error("failed " + last);
}
const html = await (await fetch("https://raw.githubusercontent.com/ddsabag/vehicle-app/main/index.html")).text();
const block = html.slice(html.indexOf("const PLATE_SETS"), html.indexOf("const MODEL_SETS"));
const SETS = [...block.matchAll(/\{key:"([^"]+)",\s*id:"([0-9a-f-]{36})"/g)].map(m => ({ key: m[1], id: m[2] }));
const WLTP = (html.slice(html.indexOf("const MODEL_SETS")).match(/wltp:\s*"([0-9a-f-]{36})"/) || [])[1];
log("registers: " + SETS.map(s => s.key).join(",") + " | wltp " + !!WLTP);

const norm = s => String(s ?? "").trim().toUpperCase();
const L = v => { const s = String(v ?? "").trim(); return s === "" ? "-" : /^\d+(\.0+)?$/.test(s) ? String(Number(s)) : "?" + s; };
const WL = new Map(), WY = new Map();
for (let off = 0; ; off += 32000) {
  const r = await call({ resource_id: WLTP, limit: "32000", offset: String(off), fields: "tozeret_cd,degem_cd,shnat_yitzur,sug_degem,ramat_gimur,ramat_eivzur_betihuty" });
  for (const x of r.records) {
    const k = [Number(x.tozeret_cd), Number(x.degem_cd), Number(x.shnat_yitzur), norm(x.sug_degem)].join("|"), l = L(x.ramat_eivzur_betihuty);
    WL.set(k + "|" + norm(x.ramat_gimur), l);
    if (!WY.has(k)) WY.set(k, new Set()); WY.get(k).add(l);
  }
  if (r.records.length < 32000) break;
}
log("wltp keys " + WL.size);
const modelLevel = x => {
  const k = [Number(x.tozeret_cd), Number(x.degem_cd), Number(x.shnat_yitzur), norm(x.sug_degem)].join("|");
  if (WL.has(k + "|" + norm(x.ramat_gimur))) return WL.get(k + "|" + norm(x.ramat_gimur));
  const s = WY.get(k); return s ? (s.size === 1 ? [...s][0] : "mixed") : "none";
};
const cls = l => l === "-" || l === "0" || l === "none" || l === "mixed" ? l : /^\?/.test(l) ? "odd" : "1-8";
for (const s of SETS) {
  let fields;
  try { fields = (await call({ resource_id: s.id, limit: "0" })).fields.map(f => f.id); } catch (e) { log(`${s.key}: ${e.message}`); continue; }
  const lv = fields.find(f => /^ramat_eivzur_betihuty$/i.test(f)), yr = fields.find(f => /^shnat_yitzur$/i.test(f));
  if (!lv || !yr) { console.log(`\n## ${s.key}: no level column (${fields.filter(f => /betih|shnat/i.test(f)).join(",") || "none"})`); continue; }
  const want = ["tozeret_cd", "degem_cd", "sug_degem", "ramat_gimur", yr, lv].filter(f => fields.includes(f));
  const pairs = {}, rowCls = {}; let n = 0, same = 0, comparable = 0;
  for (let y = 2014; y <= 2026; y++) {
    let r = null;
    for (const v of [y, String(y)]) { try { r = await call({ resource_id: s.id, limit: "800", filters: JSON.stringify({ [yr]: v }), fields: want.join(",") }, 2); if (r.records.length) break; } catch {} }
    for (const x0 of (r ? r.records : [])) {
      const x = { tozeret_cd: x0.tozeret_cd, degem_cd: x0.degem_cd, sug_degem: x0.sug_degem || "P", ramat_gimur: x0.ramat_gimur, shnat_yitzur: x0[yr] };
      const a = L(x0[lv]), m = modelLevel(x); n++;
      const key = `row ${cls(a)} / model ${cls(m)}`; pairs[key] = (pairs[key] || 0) + 1; rowCls[a] = (rowCls[a] || 0) + 1;
      if (cls(m) === "1-8" || m === "-") { comparable++; if (a === m || (a === "0" && m === "-")) same++; }
    }
  }
  console.log(`\n## ${s.key}: ${n} cars built 2014-2026 sampled | row values: ${JSON.stringify(rowCls)}`);
  for (const [k, v] of Object.entries(pairs).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  console.log(`  row = model level (empty or 0 = model empty): ${same} of ${comparable} comparable`);
}
log("done");
