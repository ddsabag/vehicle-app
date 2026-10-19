// Ground truth for the model recall history: which register models the ministry's own per-car list of open recalls (36bf1404)
// holds for each recall. Every plate in that list is looked up in the active register and in the public-transport register
// (taxis are ordinary models) and counted by maker code | maker | commercial name | model name | year | private/commercial.
// No plate is written anywhere: the run log and out/ are public. Runs on GitHub (data.gov.il blocks other networks).
//   out/recall-truth.json {u, open: {rows, plates, ids, maxId}, sets: {active, public}, rec: {RECALL_ID: {n: plates in the list, f: found in a register, m: {key: cars}}}}
import fs from "node:fs";
const API = "https://data.gov.il/api/3/action/datastore_search";
const ID = {open: "36bf1404-0be4-49d2-82dc-2f1ead4a8b93", active: "053cea08-09bc-40ec-8f7a-156f0677aff3", public: "cf29862d-ca25-4691-84f6-1be60dcb4a1e"};
const PAGE = 30000, T0 = Date.now();
const log = m => console.log(`[${Math.round((Date.now() - T0) / 1000)}s] ${m}`);
async function call(params, tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(API + "?" + new URLSearchParams(params), {signal: AbortSignal.timeout(120000), headers: {Accept: "application/json"}});
      const j = await r.json(); if (j.success) return j.result; last = new Error("CKAN " + JSON.stringify(j.error || "").slice(0, 100));
    } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 4000 * (i + 1)));
  }
  throw new Error("failed " + JSON.stringify(params).slice(0, 120) + ": " + (last && last.message));
}
// the whole dataset page by page; a read that ends short is an error (understated truth would read as matcher misses)
async function scan(id, fields, onRows) {
  let total = 0, all = null;
  for (let off = 0, empty = 0; ; off += PAGE) {
    const r = await call(fields ? {resource_id: id, limit: String(PAGE), offset: String(off), fields} : {resource_id: id, limit: String(PAGE), offset: String(off)});
    if (!off && !r.records.length && empty++ < 2) { await new Promise(s => setTimeout(s, 20000)); off -= PAGE; continue; }
    if (!r.records.length) break;
    if (all === null) all = r.total;
    onRows(r.records); total += r.records.length;
    if (r.records.length < PAGE) break;
  }
  if (!total) throw new Error(`${id}: no rows`);
  if (all && total < all * 0.995) throw new Error(`${id}: read ${total} of ${all}`);
  return total;
}
const s = v => v === null || v === undefined ? "" : String(v).trim();
const plateOf = v => Number(s(v).replace(/\D/g, "")) || 0;

// 1. the per-car list of open recalls: plate -> recall ids
const open = new Map();
let rows = 0, plateF = null, idF = null;
log("open list: " + await scan(ID.open, null, recs => {
  if (!plateF) {
    const f = Object.keys(recs[0]);
    plateF = f.find(k => /MISPAR.?RECHEV/i.test(k)); idF = f.find(k => /recall/i.test(k) && /id/i.test(k));
    log("open list fields: " + f.join(",") + " -> plate " + plateF + ", recall " + idF);
    if (!plateF || !idF) throw new Error("open list: no plate or recall field");
  }
  for (const r of recs) {
    rows++; const p = plateOf(r[plateF]), id = Number(r[idF]); if (!p || !id) continue;
    let set = open.get(p); if (!set) open.set(p, set = new Set()); set.add(id);
  }
}) + " rows");
const perId = new Map();
for (const ids of open.values()) for (const id of ids) perId.set(id, (perId.get(id) || 0) + 1);
log(`open list: ${open.size} plates, ${perId.size} recalls, newest RECALL_ID ${Math.max(...perId.keys())}`);

// 2. the registers: plate -> model, counted per recall
const truth = new Map(), foundPer = new Map(), found = new Set(), sets = {};
const FIELDS = "mispar_rechev,tozeret_cd,tozeret_nm,degem_cd,degem_nm,kinuy_mishari,shnat_yitzur,sug_degem";
for (const set of ["active", "public"]) {
  let hit = 0, shown = false;
  try {
    log(set + ": " + await scan(ID[set], set === "active" ? FIELDS : null, recs => {
      if (!shown) { shown = true; log(set + " fields: " + Object.keys(recs[0]).join(",")); }
      for (const r of recs) {
        const p = plateOf(r.mispar_rechev), ids = open.get(p); if (!ids || found.has(p)) continue;
        found.add(p); hit++;
        const key = [r.tozeret_cd, r.tozeret_nm, r.kinuy_mishari, r.degem_nm, r.shnat_yitzur, r.sug_degem].map(s).join("|");
        for (const id of ids) {
          let m = truth.get(id); if (!m) truth.set(id, m = new Map());
          m.set(key, (m.get(key) || 0) + 1); foundPer.set(id, (foundPer.get(id) || 0) + 1);
        }
      }
    }) + ` rows, ${hit} plates of the open list`);
  } catch (e) { log(set + " FAILED " + e.message); if (set === "active") process.exit(1); }
  sets[set] = hit;
}
log(`found ${found.size} of ${open.size} plates (the rest are in registers the catalogue does not cover: trucks, motorcycles, personal import, off the road)`);

// 3. publish counts only
const rec = {};
for (const [id, n] of [...perId.entries()].sort((a, b) => a[0] - b[0])) rec[id] = {n, f: foundPer.get(id) || 0, m: Object.fromEntries([...(truth.get(id) || new Map()).entries()].sort((a, b) => b[1] - a[1]))};
fs.mkdirSync("out", {recursive: true});
fs.writeFileSync("out/recall-truth.json", JSON.stringify({u: new Date().toISOString(), open: {rows, plates: open.size, ids: perId.size, maxId: Math.max(...perId.keys())}, sets, rec}));
const makers = new Map();
for (const m of truth.values()) for (const [k, n] of m) { const mk = k.split("|").slice(0, 2).join(" "); makers.set(mk, (makers.get(mk) || 0) + n); }
console.log("\nplates x recalls per register maker (top 60):");
for (const [mk, n] of [...makers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)) console.log(`  ${n}\t${mk}`);
log("wrote out/recall-truth.json");
