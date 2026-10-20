// Probe (20.10.2026): build the catalogue with this branch's catalog-build.mjs into a scratch folder (nothing is published) and hold every
// row's list price and importer against the price list's own row (maker, code, type, year); also count the rows the old join (lowest price
// per maker|code|year) priced otherwise. Model-level totals and samples only.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const OUT = "verify-cat";
execFileSync(process.execPath, ["--max-old-space-size=6144", ".github/scripts/catalog-build.mjs"], { env: { ...process.env, OUT }, stdio: "inherit" });
const API = "https://data.gov.il/api/3/action/";
async function call(params, tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(API + "datastore_search?" + new URLSearchParams(params), { signal: AbortSignal.timeout(180000) }); const j = await r.json(); if (j.success) return j.result; last = JSON.stringify(j.error || "").slice(0, 160); }
    catch (e) { last = e.message; }
    await new Promise(r => setTimeout(r, 5000 * (i + 1)));
  }
  throw new Error("failed " + last);
}
const rows = [];
for (let off = 0; ; off += 32000) { const r = await call({ resource_id: "39f455bf-6db0-4926-859d-017f34eacbcb", limit: "32000", offset: String(off), sort: "_id", fields: "tozeret_cd,degem_cd,sug_degem,shnat_yitzur,mehir,shem_yevuan" }); rows.push(...r.records); if (r.records.length < 32000) break; }
const N = v => Number(String(v ?? "").replace(/,/g, "").trim()), S = v => String(v ?? "").trim().toUpperCase();
const own = new Map(), low = new Map();
for (const r of rows) {
  const k3 = `${N(r.tozeret_cd)}|${N(r.degem_cd)}|${N(r.shnat_yitzur)}`, m = N(r.mehir);
  own.set(`${k3}|${S(r.sug_degem)}`, { m: m > 0 ? m : 0, imp: String(r.shem_yevuan ?? "").trim() });
  if (m > 0 && !(low.get(k3) <= m)) low.set(k3, m);
}
let checked = 0, priced = 0, ok = 0, bad = 0, impBad = 0, oldBad = 0, missing = 0; const badS = [], fixedS = [];
for (const f of fs.readdirSync(`${OUT}/c`).filter(f => f.endsWith(".json"))) {
  const idx = JSON.parse(fs.readFileSync(`${OUT}/c/${f}`, "utf8")), cd = f.replace(".json", ""), C = Object.fromEntries(idx.cols.map((c, i) => [c, i]));
  for (const [name, [file]] of Object.entries(idx.models)) {
    for (const a of JSON.parse(fs.readFileSync(`${OUT}/c/${cd}/${file}.json`, "utf8")).rows) {
      checked++;
      const k3 = `${N(idx.cd)}|${N(a[C.degem_cd])}|${N(a[C.shnat_yitzur])}`, o = own.get(`${k3}|${S(a[C.sug_degem])}`), got = N(a[C.mehir]) || 0;
      if (!o) { missing++; continue; }
      if (o.m > 0) priced++;
      if (got === o.m) ok++; else { bad++; if (badS.length < 8) badS.push(`${idx.n} ${name} ${a[C.shnat_yitzur]} ${S(a[C.sug_degem])}: catalogue ${got}, price list ${o.m}`); }
      if (o.m > 0 && String(a[C.shem_yevuan] ?? "").trim() !== o.imp) impBad++;
      if (o.m > 0 && low.get(k3) !== o.m) { oldBad++; if (fixedS.length < 8) fixedS.push(`${idx.n} ${name} ${a[C.shnat_yitzur]} ${S(a[C.sug_degem])}: ${o.m} (the old join: ${low.get(k3)})`); }
    }
  }
}
console.log(`catalogue rows ${checked}, with a list price ${priced}; price equal to the price list's own row ${ok}, different ${bad}, row not in the price list ${missing}; importer different ${impBad}`);
console.log(`rows the old join (lowest price per maker|code|year) priced otherwise: ${oldBad}`);
for (const s of badS) console.log("  different: " + s);
for (const s of fixedS) console.log("  fixed: " + s);
