import { createHash } from "node:crypto";
// One-off (probe-go branch, not for main), 20.10: the ownership log vs the register's current owner type.
// 1. the car Dudu reported (plate given to this script only, never printed): its log rows in the order the API returns them, and the register's type
// 2. every active car: the log's last month (the records in that month, in API order) against the register's current type (baalut),
//    under the app's rule today (stable sort by month: the last record in API order is "now") and under candidate rules.
// Prints totals only, never a plate.
const API = "https://data.gov.il/api/3/action/";
const ID = { active: "053cea08-09bc-40ec-8f7a-156f0677aff3", owners: "bb2355dc-9ec7-4f06-9c3f-3344672171da" };
const T0 = Date.now(), log = m => console.log(`[${Math.round((Date.now() - T0) / 1000)}s] ${m}`);
async function call(act, params, tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(API + act + "?" + new URLSearchParams(params), { signal: AbortSignal.timeout(180000) }); const j = await r.json(); if (j.success) return j.result; last = JSON.stringify(j.error || "").slice(0, 120); } catch (e) { last = e.message; }
    await new Promise(r => setTimeout(r, 4000 * (i + 1)));
  }
  throw new Error("failed " + last);
}
const PAGE = 32000;
async function scan(id, fields, onRows) {
  let total = 0, all = null;
  for (let off = 0; ; off += PAGE) {
    const r = await call("datastore_search", { resource_id: id, limit: String(PAGE), offset: String(off), fields, sort: "_id" });
    if (all === null) all = r.total;
    onRows(r.records); total += r.records.length;
    if (r.records.length < PAGE) break;
  }
  if (total < all * 0.995) throw new Error(`${id}: read ${total} of ${all}`);
  return total;
}
for (const [k, id] of Object.entries(ID)) { try { const r = await call("resource_show", { id }); log(`${k}: last_modified ${r.last_modified || r.metadata_modified} | name ${r.name}`); } catch (e) { log(`${k}: ${e.message}`); } }

// 1. the reported car: found by its model, year and dates, and matched by the hash of its plate (the plate is never written here)
const HASH = "b963c629a856e795e7c4caa4519e5428c7d08bf39033da273b62ee7e7e41251d", sha = s => createHash("sha256").update(String(s)).digest("hex");
let P = 0;
{ const r = await call("datastore_search", { resource_id: ID.active, q: "SPORTAGE", filters: JSON.stringify({ shnat_yitzur: 2024 }), limit: "32000", fields: "mispar_rechev" });
  const hit = r.records.find(x => sha(Number(x.mispar_rechev)) === HASH); P = hit ? Number(hit.mispar_rechev) : 0; log(`reported car found: ${!!P} (of ${r.records.length} SPORTAGE 2024 rows)`); }
if (P) {
  const o = await call("datastore_search", { resource_id: ID.owners, filters: JSON.stringify({ mispar_rechev: P }), limit: "50" });
  console.log("\n== the reported car: log rows as the API returns them (no sort given)");
  for (const r of o.records) console.log(`  _id ${r._id} | ${r.baalut_dt} | ${r.baalut}`);
  const a = await call("datastore_search", { resource_id: ID.active, filters: JSON.stringify({ mispar_rechev: P }), limit: "5" });
  for (const r of a.records) console.log(`  register: baalut "${r.baalut}" | on road ${r.moed_aliya_lakvish} | last test ${r.mivchan_acharon_dt} | model ${r.kinuy_mishari} ${r.shnat_yitzur}`);
}

// 2. every active car
const TYPES = ["פרטי", "חברה", "סוחר", "החכר"], code = t => { const i = TYPES.indexOf(String(t || "").trim()); return i < 0 ? 9 : i; };
const REG = new Map();
log("active rows: " + await scan(ID.active, "mispar_rechev,baalut", rows => { for (const r of rows) REG.set(Number(r.mispar_rechev), code(r.baalut)); }));
const OWN = new Map(); let outOfOrder = 0, rowsN = 0;
log("owners rows: " + await scan(ID.owners, "_id,mispar_rechev,baalut_dt,baalut", rows => {
  for (const r of rows) {
    rowsN++;
    const p = Number(r.mispar_rechev), ym = Number(r.baalut_dt), c = code(r.baalut);
    let o = OWN.get(p);
    if (!o) { OWN.set(p, o = { ym, g: String(c), n: 1, prevYm: 0, lastSeen: ym }); continue; }
    o.n++;
    if (ym < o.lastSeen) outOfOrder++;
    o.lastSeen = ym;
    if (ym > o.ym) { o.prevYm = o.ym; o.ym = ym; o.g = String(c); }
    else if (ym === o.ym) o.g += c;
  }
}));
log(`plates in the log ${OWN.size} | rows ${rowsN} | rows with an earlier month than the plate's previous row (API order) ${outOfOrder}`);

const name = c => TYPES[c] || "?", same = (reg, c) => reg === c || (reg === 1 && c === 3);   // the register says חברה for a leased car (log: החכר)
const st = { cars: 0, noLog: 0, single: 0, tie: 0 }, mis = { appSingle: 0, appTie: 0, dealerFirstTie: 0, regTie: 0 };
const combos = {}, singleMis = {}, tieDetail = {};
for (const [p, reg] of REG) {
  const o = OWN.get(p); st.cars++;
  if (!o) { st.noLog++; continue; }
  const g = o.g.split("").map(Number), app = g[g.length - 1];
  if (g.length === 1) { st.single++; if (!same(reg, app)) { mis.appSingle++; const k = `register ${name(reg)} / log ${name(app)}`; singleMis[k] = (singleMis[k] || 0) + 1; } continue; }
  st.tie++;
  const k = g.map(name).join(">"); combos[k] = (combos[k] || 0) + 1;
  if (!same(reg, app)) mis.appTie++;
  // candidate A: a dealer in the same month as another type is the step between them, so it goes first
  const nonDealer = g.filter(c => c !== 2), a = nonDealer.length ? nonDealer[nonDealer.length - 1] : 2;
  if (!same(reg, a)) mis.dealerFirstTie++;
  // candidate B: the register's current type goes last when it is in the month (else candidate A)
  const b = g.some(c => same(reg, c)) ? reg : a;
  if (!same(reg, b)) mis.regTie++;
  const d = `${k} | register ${name(reg)}`; tieDetail[d] = (tieDetail[d] || 0) + 1;
}
console.log(`\n== active cars ${st.cars} | no log rows ${st.noLog} | one record in the last month ${st.single} | two or more records in the last month ${st.tie}`);
console.log(`app today, one record: log type != register type in ${mis.appSingle}`);
for (const [k, v] of Object.entries(singleMis).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`   ${k}: ${v}`);
console.log(`app today, same-month records: the last (API order) != register type in ${mis.appTie} of ${st.tie}`);
console.log(`candidate A (dealer first in the month): != register in ${mis.dealerFirstTie} of ${st.tie}`);
console.log(`candidate B (register's type last, else A): != register in ${mis.regTie} of ${st.tie}`);
console.log("\n== same-month groups in API order (count)");
for (const [k, v] of Object.entries(combos).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`   ${k}: ${v}`);
console.log("\n== same-month groups x register type (count)");
for (const [k, v] of Object.entries(tieDetail).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`   ${k}: ${v}`);
const dealerNow = [...REG].filter(([p, r]) => r === 2).length;
let appDealer = 0, appDealerReg = { 0: 0, 1: 0, 2: 0 };
for (const [p, reg] of REG) { const o = OWN.get(p); if (!o) continue; const g = o.g.split("").map(Number); if (g[g.length - 1] === 2) { appDealer++; appDealerReg[reg] = (appDealerReg[reg] || 0) + 1; } }
console.log(`\n== "הרכב רשום כעת על סוחר" today (log's last record is a dealer): ${appDealer} active cars; register says: private ${appDealerReg[0]}, company ${appDealerReg[1]}, dealer ${appDealerReg[2]} | register dealer cars ${dealerNow}`);
log("done");
