// Probe for the compare picker redesign: per model, which years carry which trim + engine combinations in the two
// catalogue datasets (WLTP 142afde2, price list 39f455bf), how far back trims exist, and the total row counts.
const API = "https://data.gov.il/api/3/action/datastore_search";
const SETS = {wltp: "142afde2-6228-49f9-8a29-9b6c3a0cbe40", price: "39f455bf-6db0-4926-859d-017f34eacbcb"};
const get = async p => { const r = await fetch(API + "?" + new URLSearchParams(p), {headers: {Accept: "application/json"}}); if (!r.ok) throw new Error("HTTP " + r.status); return (await r.json()).result; };
const MODELS = [["טויוטה", "COROLLA"], ["יונדאי", "TUCSON"], ["קיה", "SPORTAGE"], ["סקודה", "OCTAVIA"], ["מאזדה", "MAZDA3"], ["טסלה", "MODEL 3"]];
for (const [k, id] of Object.entries(SETS)) {
  const r = await get({resource_id: id, limit: "1"}); console.log(`${k}: total=${r.total} fields=${r.fields.map(f => f.id).join(",")}`);
}
for (const [mk, md] of MODELS) {
  for (const [k, id] of Object.entries(SETS)) {
    try {
      const r = await get({resource_id: id, q: md, limit: "5000"});
      const rows = r.records.filter(x => String(x.tozeret_nm || "").startsWith(mk) && String(x.kinuy_mishari || "").toUpperCase().trim() === md);
      const byYear = {};
      for (const x of rows) { const y = x.shnat_yitzur; const t = [String(x.ramat_gimur || "").trim() || "-", x.nefach_manoa || "", x.technologiat_hanaa_nm || x.delek_nm || "", x.koah_sus || ""].join("/"); (byYear[y] ||= new Set()).add(t); }
      const ys = Object.keys(byYear).sort();
      console.log(`\n${k} ${mk} ${md}: ${rows.length} rows, years ${ys[0]}..${ys[ys.length - 1]} (${ys.length})`);
      for (const y of ys) console.log(`  ${y}: ${byYear[y].size} variants: ${[...byYear[y]].slice(0, 8).join(" | ")}${byYear[y].size > 8 ? " …" : ""}`);
    } catch (e) { console.log(`${k} ${mk} ${md}: ${e.message}`); }
  }
}
// size of a per-model variants index: distinct (maker, model, year, trim, engine) across the WLTP set, sampled by paging
let n = 0, distinct = new Set(), off = 0;
for (;;) { const r = await get({resource_id: SETS.wltp, limit: "30000", offset: String(off), fields: "tozeret_cd,kinuy_mishari,shnat_yitzur,ramat_gimur,nefach_manoa,koah_sus,technologiat_hanaa_nm"}); for (const x of r.records) { n++; distinct.add([x.tozeret_cd, String(x.kinuy_mishari).toUpperCase(), x.shnat_yitzur, String(x.ramat_gimur || "").trim(), x.nefach_manoa, x.koah_sus, x.technologiat_hanaa_nm].join("|")); } if (r.records.length < 30000) break; off += 30000; }
console.log(`\nWLTP rows ${n}, distinct maker|model|year|trim|engine ${distinct.size}`);
