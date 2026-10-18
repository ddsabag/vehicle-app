// Verification of an audit finding (towing card): for a deterministic sample of active cars per model year, what the app's
// towing rule decides from the model rows (fetchModelData: maker + model code, any year, any model type) and what the
// registration's own towing-hook field (cont.grira_nm) says. Also a few totals (ownership-log types, safety-level values).
// Read-only. Plates, VINs and owner details are never printed: only totals and generic category values.
const OPTS = Object.fromEntries(String(process.env.QUERIES || "").split(/[;,]\s*(?=[a-z]+=)/).map(s => s.split("=")).filter(a => a[0]).map(([k, ...v]) => [k.trim(), v.join("=").trim()]));
const SEED = String(OPTS.seed || "7"), N = Number(OPTS.n || 30), YEARS = String(OPTS.years || "2005|2006|2007|2009|2012|2018|2023").split("|").map(Number);
const API = "https://data.gov.il/api/3/action/";
const ID = {active: "053cea08-09bc-40ec-8f7a-156f0677aff3", cont: "0866573c-40cd-4ca8-91d2-9dd2d7a492e5", owners: "bb2355dc-9ec7-4f06-9c3f-3344672171da", wltp: "142afde2-6228-49f9-8a29-9b6c3a0cbe40"};
const sleep = ms => new Promise(r => setTimeout(r, ms));
let LIMIT = 55; const HITS = []; let reqN = 0;
async function slot() { for (;;) { const t = Date.now() - 60000; while (HITS.length && HITS[0] < t) HITS.shift(); if (HITS.length < LIMIT) return; await sleep(Math.max(250, HITS[0] + 60050 - Date.now())); } }
async function search(id, p) {
  const params = {resource_id: id, ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]))};
  let last;
  for (let a = 0; a < 5; a++) {
    await slot(); HITS.push(Date.now()); reqN++;
    try {
      const r = await fetch(API + "datastore_search?" + new URLSearchParams(params), {headers: {Accept: "application/json", "User-Agent": "luchit-verify/1.0"}, signal: AbortSignal.timeout(60000)});
      if (r.status === 403 || r.status === 429 || r.status >= 500) { last = new Error("HTTP " + r.status); LIMIT = Math.max(30, Math.round(LIMIT * 0.9)); await sleep(r.status === 500 ? 5000 : 60000); continue; }
      const j = await r.json(); if (!j.success) throw new Error("CKAN error"); return j.result;
    } catch (e) { last = e; await sleep(2000 * (a + 1)); }
  }
  throw last;
}
const E = v => v === null || v === undefined || String(v).trim() === "";
const num = v => Number(String(v).replace(/,/g, ""));
const isNum = v => !E(v) && !isNaN(num(v));
function fnv(s) { let h = 0x811c9dc5; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
// the app's own rules (index.html rankRows, hasTow, fetchModelData)
function rankRows(rows, rec) {
  const n = s => String(s || "").trim().toLowerCase(), year = num(rec.shnat_yitzur);
  const score = r => { let sc = 0; const dy = Math.abs(num(r.shnat_yitzur) - year); sc -= isNaN(dy) ? 50 : dy * 10;
    if (n(r.sug_degem) && n(r.sug_degem) === n(rec.sug_degem)) sc += 3; if (n(r.ramat_gimur) && n(r.ramat_gimur) === n(rec.ramat_gimur)) sc += 5; if (n(r.kinuy_mishari) && n(r.kinuy_mishari) === n(rec.kinuy_mishari)) sc += 2; return sc; };
  return rows.slice().sort((a, b) => score(b) - score(a));
}
const hasTow = r => r && (isNum(r.kosher_grira_im_blamim) && num(r.kosher_grira_im_blamim) > 0 || isNum(r.kosher_grira_bli_blamim) && num(r.kosher_grira_bli_blamim) > 0);
const MODEL = new Map();
async function modelRows(rec) {
  const k = rec.tozeret_cd + "|" + rec.degem_cd; if (MODEL.has(k)) return MODEL.get(k);
  let rows = [];
  for (const f of [{tozeret_cd: num(rec.tozeret_cd), degem_cd: num(rec.degem_cd)}, {tozeret_cd: String(rec.tozeret_cd).trim(), degem_cd: String(rec.degem_cd).trim()}]) {
    try { const r = await search(ID.wltp, {filters: f, limit: 300}); if (r.records.length) { rows = r.records; break; } } catch {}
  }
  MODEL.set(k, rows); return rows;
}
function outcome(rows, v) {
  const ranked = rankRows(rows, v); if (!ranked.length) return {o: "no model rows"};
  const towRow = ranked.find(hasTow) || null;
  const zeroTow = !towRow && isNum(ranked[0].kosher_grira_im_blamim) && isNum(ranked[0].kosher_grira_bli_blamim) && num(ranked[0].kosher_grira_im_blamim) === 0 && num(ranked[0].kosher_grira_bli_blamim) === 0;
  if (!towRow) return {o: zeroTow ? "BAN card" : "no towing data"};
  const sameYear = num(towRow.shnat_yitzur) === num(v.shnat_yitzur), sameType = String(towRow.sug_degem || "").trim() === String(v.sug_degem || "").trim();
  const sameName = String(towRow.kinuy_mishari || "").trim() === String(v.kinuy_mishari || "").trim();
  return {o: sameYear && sameType ? "limits of its own year" : !sameType ? "limits of the other model type (P/M)" : !sameName ? "limits of another model name, same type" : "limits of another year, same model"};
}
const hookCat = t => { if (E(t)) return "(empty)"; t = String(t).trim(); return /^(0|לא|אין|ללא)$|ללא|אין|לא מותקן/.test(t) ? "no hook: " + t : "hook: " + t; };

console.log(`verify-tow-hook seed=${SEED} n=${N} per year, years ${YEARS.join(",")}`);
const T = {}; const HOOKS = {};
for (const y of YEARS) {
  let tot = 0; try { tot = (await search(ID.active, {filters: {shnat_yitzur: y}, limit: 0})).total; } catch (e) { console.log(`year ${y}: count failed ${e.message}`); continue; }
  const seen = new Set();
  for (let i = 0; i < N; i++) {
    const off = fnv(`${SEED}|tow|${y}|${i}`) % tot; if (seen.has(off)) continue; seen.add(off);
    let v; try { v = (await search(ID.active, {filters: {shnat_yitzur: y}, limit: 1, offset: off, fields: "mispar_rechev,tozeret_cd,degem_cd,sug_degem,shnat_yitzur,ramat_gimur,kinuy_mishari"})).records[0]; } catch { continue; }
    if (!v) continue;
    let hook = "(cont not read)"; try { const c = await search(ID.cont, {filters: {mispar_rechev: num(v.mispar_rechev)}, limit: 1}); hook = c.records[0] ? hookCat(c.records[0].grira_nm) : "(no cont row)"; } catch {}
    const rows = E(v.tozeret_cd) || E(v.degem_cd) ? [] : await modelRows(v);
    const {o} = outcome(rows, v);
    const key = `${y} | ${o}`; T[key] = T[key] || {n: 0, hooks: {}}; T[key].n++; T[key].hooks[hook] = (T[key].hooks[hook] || 0) + 1;
    HOOKS[hook] = (HOOKS[hook] || 0) + 1;
  }
  console.log(`year ${y}: ${tot} active cars, sampled ${seen.size}, requests so far ${reqN}`);
}
console.log("\n===== app towing outcome by model year, with the registration's own towing-hook field (counts of sampled cars)");
for (const [k, s] of Object.entries(T).sort()) console.log(`TOW ${k}: ${s.n} | ${Object.entries(s.hooks).sort((a, b) => b[1] - a[1]).map(([h, n]) => `${h}=${n}`).join(", ")}`);
console.log("\n===== towing-hook field values among sampled cars"); for (const [h, n] of Object.entries(HOOKS).sort((a, b) => b[1] - a[1])) console.log(`HOOK ${h}: ${n}`);

console.log("\n===== totals: ownership log types (owners.baalut)");
for (const b of ["פרטי", "סוחר", "החכר", "ליסינג", "השכרה", "חברה", "ממשלתי", "החכר/ליסינג"]) { try { console.log(`OWN ${b}: ${(await search(ID.owners, {filters: {baalut: b}, limit: 0})).total}`); } catch (e) { console.log(`OWN ${b}: ${e.message}`); } }
console.log("\n===== totals: register current ownership (active.baalut)");
for (const b of ["פרטי", "ליסינג", "השכרה", "חברה", "סוחר", "החכר"]) { try { console.log(`ACT ${b}: ${(await search(ID.active, {filters: {baalut: b}, limit: 0})).total}`); } catch (e) { console.log(`ACT ${b}: ${e.message}`); } }
console.log("\n===== totals: active register safety level (ramat_eivzur_betihuty)");
for (const l of [0, 1, 2, 3, 4, 5, 6, 7, 8]) { try { console.log(`SAFE all level=${l}: ${(await search(ID.active, {filters: {ramat_eivzur_betihuty: l}, limit: 0})).total}`); } catch (e) { console.log(`SAFE ${l}: ${e.message}`); } }
for (const [kin, y] of [["COROLLA", 2020], ["MODEL 3", 2021], ["COROLLA CROSS", 2023]]) for (const l of [1, 2, 3, 4, 5, 6, 7, 8]) {
  try { const t = (await search(ID.active, {filters: {kinuy_mishari: kin, shnat_yitzur: y, ramat_eivzur_betihuty: l}, limit: 0})).total; if (t) console.log(`SAFE ${kin} ${y} level=${l}: ${t}`); } catch {}
}
console.log(`\nrequests: ${reqN}`);
