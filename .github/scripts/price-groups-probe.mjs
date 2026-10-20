// Probe (20.10.2026): the weekly invariant "price" read 893 maker+code+year groups with more than one list price.
// What splits them (model type P/M, trim, name), and what the app shows for the active cars of those groups: the 1.35 rule, the 1.34
// rule and the catalogue join (the lowest price per maker|code|year). Model-level totals and samples only, never a plate.
const API = "https://data.gov.il/api/3/action/";
const PRICE = "39f455bf-6db0-4926-859d-017f34eacbcb", ACTIVE = "053cea08-09bc-40ec-8f7a-156f0677aff3";
const T0 = Date.now(), log = m => console.log(`[${Math.round((Date.now() - T0) / 1000)}s] ${m}`);
async function call(params, tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(API + "datastore_search?" + new URLSearchParams(params), { headers: { Accept: "application/json", "User-Agent": "luchit-probe/1.0" }, signal: AbortSignal.timeout(180000) });
      const j = await r.json(); if (j.success) return j.result; last = JSON.stringify(j.error || "").slice(0, 160);
    } catch (e) { last = e.message; }
    await new Promise(r => setTimeout(r, 5000 * (i + 1)));
  }
  throw new Error("failed " + last);
}
async function scan(id, fields, onRows) {
  let total = 0, all = null;
  for (let off = 0; ; off += 32000) {
    const p = { resource_id: id, limit: "32000", offset: String(off), sort: "_id" }; if (fields) p.fields = fields;
    const r = await call(p);
    if (all === null) all = r.total;
    onRows(r.records); total += r.records.length;
    if (r.records.length < 32000) break;
  }
  if (total < all * 0.995) throw new Error(`${id}: read ${total} of ${all}`);
  return total;
}
// ---- the app's rules, as in index.html (1.35) ----
const empty = v => v === null || v === undefined || String(v).trim() === "" || String(v).trim().startsWith("0000-00-00");
const num = v => Number(String(v).replace(/,/g, ""));
const posN = v => !empty(v) && Number(String(v).replace(/,/g, "")) > 0;
function rankRows(rows, rec) {
  const n = s => String(s || "").trim().toLowerCase(), year = num(rec.shnat_yitzur);
  const score = r => { let sc = 0; const dy = Math.abs(num(r.shnat_yitzur) - year); sc -= isNaN(dy) ? 50 : dy * 10;
    if (n(r.sug_degem) && n(r.sug_degem) === n(rec.sug_degem)) sc += 3; if (n(r.ramat_gimur) && n(r.ramat_gimur) === n(rec.ramat_gimur)) sc += 5;
    if (n(r.kinuy_mishari) && n(r.kinuy_mishari) === n(rec.kinuy_mishari)) sc += 2; return sc; };
  return rows.slice().sort((a, b) => score(b) - score(a));
}
const sdOf = r => String(r.sug_degem || "").trim().toUpperCase();
const nameKey = x => String(x || "").trim().toUpperCase();
const sameModel = (r, v) => !empty(v.kinuy_mishari) && nameKey(r.kinuy_mishari) === nameKey(v.kinuy_mishari) || !empty(v.degem_nm) && nameKey(r.degem_nm) === nameKey(v.degem_nm);
function ofType(rows, v) {
  const sd = sdOf(v);
  if (sd && rows.some(r => sdOf(r) === sd)) return rows.filter(r => sdOf(r) === sd);
  if (!rows.some(sdOf) || empty(v.kinuy_mishari) && empty(v.degem_nm)) return rows;
  const named = new Set(rows.filter(r => sameModel(r, v)).map(sdOf));
  return !sd && !named.size ? rows : rows.filter(r => !sdOf(r) || named.has(sdOf(r)));
}
const trimKey = x => String(x ?? "").trim().toUpperCase().replace(/\s+/g, " ");
const trimOk = (r, v) => empty(v.ramat_gimur) || trimKey(r.ramat_gimur) === trimKey(v.ramat_gimur);
function pick(rows, v, rule) {
  const ranked = rankRows(rows, v), p = ranked.filter(r => posN(r.mehir)), y = num(v.shnat_yitzur);
  const trims = rows.some(r => !empty(r.ramat_gimur)), sameT = r => !trims || trimOk(r, v), sameY = r => num(r.shnat_yitzur) === y;
  return rule === "1.35" ? p.find(x => sameY(x) && sameT(x)) || p.find(sameY) || p.find(sameT) || p[0]
    : p.find(x => sameY(x) && sameT(x)) || p.find(sameT) || p.find(sameY) || p[0];
}
// ---- 1. the price list ----
const rows = []; let fieldsSeen = null;
log("price: " + await scan(PRICE, "", rs => { for (const r of rs) { if (!fieldsSeen) fieldsSeen = Object.keys(r); rows.push(r); } }) + " rows");
console.log("price fields: " + fieldsSeen.join(","));
const N = v => Number(String(v ?? "").replace(/,/g, "").trim()), S = v => String(v ?? "").trim().toUpperCase().replace(/\s+/g, " ");
const k3 = r => `${N(r.tozeret_cd)}|${N(r.degem_cd)}|${N(r.shnat_yitzur)}`, k4 = r => `${k3(r)}|${S(r.sug_degem)}`;
const g3 = new Map(), g4 = new Map(), byCode = new Map();
for (const r of rows) {
  const c = `${N(r.tozeret_cd)}|${N(r.degem_cd)}`; (byCode.get(c) || byCode.set(c, []).get(c)).push(r);
  (g4.get(k4(r)) || g4.set(k4(r), []).get(k4(r))).push(r);
  if (N(r.mehir) > 0) (g3.get(k3(r)) || g3.set(k3(r), []).get(k3(r))).push(r);
}
const prices = rs => new Set(rs.filter(r => N(r.mehir) > 0).map(r => N(r.mehir)));
const multi = [...g3.entries()].filter(([, rs]) => prices(rs).size > 1);
console.log(`maker+code+year groups with a price: ${g3.size}; with more than one price: ${multi.length}`);
let rows4 = 0, max4 = 0, multi4 = 0; for (const rs of g4.values()) { if (rs.length > 1) rows4++; max4 = Math.max(max4, rs.length); if (prices(rs).size > 1) multi4++; }
console.log(`maker+code+year+type keys: ${g4.size}; with more than one row: ${rows4} (largest ${max4}); with more than one price: ${multi4}`);
const single = (rs, f) => { const m = new Map(); for (const r of rs) { if (!(N(r.mehir) > 0)) continue; const k = f(r); (m.get(k) || m.set(k, new Set()).get(k)).add(N(r.mehir)); } return [...m.values()].every(s => s.size === 1); };
const CL = [["type", r => S(r.sug_degem)], ["trim", r => S(r.ramat_gimur)], ["type+trim", r => S(r.sug_degem) + "|" + S(r.ramat_gimur)], ["name", r => S(r.kinuy_mishari)],
  ["type+name", r => S(r.sug_degem) + "|" + S(r.kinuy_mishari)], ["type+trim+name", r => S(r.sug_degem) + "|" + S(r.ramat_gimur) + "|" + S(r.kinuy_mishari)]];
const cls = new Map(), samples = new Map(), years = new Map(), spread = { "<2%": 0, "2-10%": 0, "10-30%": 0, ">30%": 0 };
for (const [k, rs] of multi) {
  const c = (CL.find(([, f]) => single(rs, f)) || ["none"])[0]; cls.set(c, (cls.get(c) || 0) + 1);
  const y = N(rs[0].shnat_yitzur); years.set(y, (years.get(y) || 0) + 1);
  const ps = [...prices(rs)], q = Math.max(...ps) / Math.min(...ps) - 1; spread[q < 0.02 ? "<2%" : q < 0.1 ? "2-10%" : q < 0.3 ? "10-30%" : ">30%"]++;
  const s = samples.get(c) || samples.set(c, []).get(c);
  if (s.length < 6) s.push(`${S(rs[0].tozeret_nm)} | ${N(rs[0].degem_cd)} | ${N(rs[0].shnat_yitzur)}: ` + rs.filter(r => N(r.mehir) > 0).map(r => `${S(r.sug_degem) || "-"}/${S(r.kinuy_mishari) || "-"}/${S(r.ramat_gimur) || "-"}/${N(r.mehir)}`).join("  ;  "));
}
console.log("what splits them (the first key under which every part has one price): " + JSON.stringify(Object.fromEntries(cls)));
console.log("price spread (highest/lowest - 1): " + JSON.stringify(spread));
console.log("by year: " + JSON.stringify(Object.fromEntries([...years].sort((a, b) => b[0] - a[0]))));
for (const [c, s] of samples) { console.log(`samples (${c}):`); for (const x of s) console.log("  " + x); }
// ---- 2. the active cars of those groups: what each rule shows against the car's own row ----
const multiSet = new Set(multi.map(([k]) => k)), minOf = new Map(multi.map(([k, rs]) => [k, Math.min(...prices(rs))]));
const memo = new Map(), tally = { cars: 0, truth1: 0, truthTrim: 0, ambiguous: 0, noOwn: 0, r135ok: 0, r135bad: 0, r134ok: 0, r134bad: 0, catOk: 0, catBad: 0, regress: 0, improve: 0, bothBad: 0, hasTrim: 0 };
const bad135 = new Map();
function judgeCar(v) {
  const key = [v.tozeret_cd, v.degem_cd, v.sug_degem, v.shnat_yitzur, v.ramat_gimur, v.kinuy_mishari, v.degem_nm].map(S).join("|");
  if (memo.has(key)) return memo.get(key);
  const code = byCode.get(`${N(v.tozeret_cd)}|${N(v.degem_cd)}`) || [];
  const typed = ofType(code, v);
  // the car's own price: its maker, code, type and year; several prices there -> the row of its trim
  const own = (g4.get(`${N(v.tozeret_cd)}|${N(v.degem_cd)}|${N(v.shnat_yitzur)}|${S(v.sug_degem)}`) || []).filter(r => N(r.mehir) > 0);
  let truth = null, how = "noOwn";
  const ps = prices(own);
  if (ps.size === 1) { truth = [...ps][0]; how = "truth1"; }
  else if (ps.size > 1) { const t = own.filter(r => trimKey(r.ramat_gimur) === trimKey(v.ramat_gimur)); const tp = prices(t); if (tp.size === 1) { truth = [...tp][0]; how = "truthTrim"; } else how = "ambiguous"; }
  const a = pick(typed, v, "1.35"), b = pick(typed, v, "1.34");
  const res = { how, truth, a: a ? N(a.mehir) : null, b: b ? N(b.mehir) : null, cat: minOf.get(`${N(v.tozeret_cd)}|${N(v.degem_cd)}|${N(v.shnat_yitzur)}`),
    label: `${S(v.kinuy_mishari) || S(v.degem_nm)} ${N(v.shnat_yitzur)} ${S(v.sug_degem)}` };
  memo.set(key, res); return res;
}
log("active: " + await scan(ACTIVE, "tozeret_cd,degem_cd,sug_degem,shnat_yitzur,ramat_gimur,kinuy_mishari,degem_nm", rs => {
  for (const v of rs) {
    if (!multiSet.has(`${N(v.tozeret_cd)}|${N(v.degem_cd)}|${N(v.shnat_yitzur)}`)) continue;
    tally.cars++; if (!empty(v.ramat_gimur)) tally.hasTrim++;
    const j = judgeCar(v); tally[j.how]++;
    if (j.truth === null) continue;
    const okA = j.a === j.truth, okB = j.b === j.truth, okC = j.cat === j.truth;
    tally[okA ? "r135ok" : "r135bad"]++; tally[okB ? "r134ok" : "r134bad"]++; tally[okC ? "catOk" : "catBad"]++;
    if (!okA && okB) tally.regress++; if (okA && !okB) tally.improve++; if (!okA && !okB) tally.bothBad++;
    if (!okA) { const e = bad135.get(j.label) || { n: 0, truth: j.truth, shown: j.a }; e.n++; bad135.set(j.label, e); }
  }
}) + " rows");
console.log("active cars in those groups: " + JSON.stringify(tally));
console.log("1.35 shows another price than the car's own row (model, cars, own price, shown), top 15:");
for (const [l, e] of [...bad135].sort((a, b) => b[1].n - a[1].n).slice(0, 15)) console.log(`  ${l}: ${e.n} cars, own ${e.truth}, shown ${e.shown}`);
log("done");
