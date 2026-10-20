// Probe (20.10.2026): are the WLTP, price-list and counts datasets one row per maker+code+type+year, and do the counts of one
// maker+code+year differ by type (the catalogue sums them per maker|code|year)? Model-level totals and samples only.
const API = "https://data.gov.il/api/3/action/";
const SETS = { wltp: "142afde2-6228-49f9-8a29-9b6c3a0cbe40", price: "39f455bf-6db0-4926-859d-017f34eacbcb", counts: "5e87a7a1-2f6f-41c1-8aec-7216d52a6cf6" };
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
async function all(id, fields) {
  const out = [];
  for (let off = 0; ; off += 32000) {
    const p = { resource_id: id, limit: "32000", offset: String(off), sort: "_id" }; if (fields) p.fields = fields;
    const r = await call(p); out.push(...r.records); if (r.records.length < 32000) return { rows: out, total: r.total, fields: r.fields.map(f => f.id) };
  }
}
const N = v => Number(String(v ?? "").replace(/,/g, "").trim()), S = v => String(v ?? "").trim().toUpperCase();
const k3 = r => `${N(r.tozeret_cd)}|${N(r.degem_cd)}|${N(r.shnat_yitzur)}`, k4 = r => `${k3(r)}|${S(r.sug_degem)}`;
const got = {};
for (const [name, id] of Object.entries(SETS)) {
  const d = await all(id, name === "wltp" ? "_id,tozeret_cd,degem_cd,sug_degem,shnat_yitzur,kinuy_mishari" : "");
  got[name] = d;
  const g4 = new Map(), g3 = new Map();
  for (const r of d.rows) { g4.set(k4(r), (g4.get(k4(r)) || 0) + 1); (g3.get(k3(r)) || g3.set(k3(r), []).get(k3(r))).push(r); }
  let dup4 = 0, max4 = 0; for (const n of g4.values()) { if (n > 1) dup4++; max4 = Math.max(max4, n); }
  let multi3 = 0, multiType = 0; for (const rs of g3.values()) if (rs.length > 1) { multi3++; if (new Set(rs.map(r => S(r.sug_degem))).size === rs.length) multiType++; }
  console.log(`${name}: ${d.rows.length} of ${d.total} rows; fields ${d.fields.join(",")}`);
  console.log(`  maker+code+type+year keys ${g4.size}, with more than one row ${dup4} (largest ${max4}); maker+code+year groups with more than one row ${multi3}, of them one row per type ${multiType}`);
}
// counts: within maker+code+year groups of several types, do the types' counts differ (summing them would mix two models)?
const c3 = new Map(); for (const r of got.counts.rows) (c3.get(k3(r)) || c3.set(k3(r), []).get(k3(r))).push(r);
let groups = 0, differ = 0, same = 0; const sample = [];
for (const rs of c3.values()) {
  if (rs.length < 2) continue; groups++;
  const vals = new Set(rs.map(r => `${N(r.mispar_rechavim_pailim)}/${N(r.mispar_rechavim_le_pailim)}`));
  if (vals.size > 1) { differ++; if (sample.length < 8) sample.push(`${S(rs[0].tozeret_nm)} | ${N(rs[0].degem_cd)} | ${N(rs[0].shnat_yitzur)}: ` + rs.map(r => `${S(r.sug_degem) || "-"}/${S(r.kinuy_mishari) || "-"}/${N(r.mispar_rechavim_pailim)}+${N(r.mispar_rechavim_le_pailim)}`).join("  ;  ")); } else same++;
}
console.log(`counts: maker+code+year groups with several rows ${groups}; the rows' counts differ ${differ}, equal ${same}`);
for (const s of sample) console.log("  " + s);
// do the WLTP and price-list rows line up by key (same key set)?
const w4 = new Set(got.wltp.rows.map(k4)), p4 = new Set(got.price.rows.map(k4)), c4 = new Set(got.counts.rows.map(k4));
let pNotW = 0; for (const k of p4) if (!w4.has(k)) pNotW++;
let cNotW = 0; for (const k of c4) if (!w4.has(k)) cNotW++;
console.log(`price-list keys not in WLTP ${pNotW}; counts keys not in WLTP ${cNotW}`);
