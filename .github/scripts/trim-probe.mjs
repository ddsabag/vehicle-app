// One-off probe: for recently launched models, joins deliveries (units per catalogue code, Q2-Q3 2026), the WLTP catalogue (trim name ramat_gimur, engine, fuel) and the price list (mehir). Prints only.
const API = "https://data.gov.il/api/3/action/datastore_search", DELIV = "602ac32d-19c0-4b41-88e0-e3ce8a7e80b7", WLTP = "142afde2-6228-49f9-8a29-9b6c3a0cbe40", PRICE = "39f455bf-6db0-4926-859d-017f34eacbcb";
const get = async (id, p) => { for (let i = 0; i < 3; i++) { try { const j = await (await fetch(API + "?" + new URLSearchParams({ resource_id: id, ...p }), { signal: AbortSignal.timeout(60000) })).json(); if (j.success) return j.result; } catch {} await new Promise(r => setTimeout(r, 2000)); } return { records: [], fields: [] }; };
const w = await get(WLTP, { limit: "1" });
console.log("WLTP fields:", w.fields.map(x => x.id).join(", "));
const MODELS = [["קופרה", "TERRAMAR", 1690], ["פולקסווגן", "TAYRON", 724], ["BYD", "ATTO 3 EVO", 1014], ["צ'רי", "TIGGO 7 HEV", 1450], ["טויוטה", "C-HR PLUS", 0], ["אורה", "ORA 5", 0], ["דונגפנג", "MAGE", 0]];
for (const [mk, q, cd] of MODELS) {
  console.log("\n==== " + mk + " " + q);
  const d = await get(DELIV, { q, limit: "200", sort: "sgira_month desc" });
  const units = {};
  for (const r of d.records) { if (r.sug_degem !== "P" || r.sgira_month < 202604) continue; const k = r.tozeret_cd + "|" + r.degem_cd; units[k] = (units[k] || 0) + (Number(r.car_num) || 0); }
  console.log("delivered since Apr 2026 per code:", JSON.stringify(units));
  for (const k of Object.keys(units)) {
    const [t, g] = k.split("|");
    const ww = await get(WLTP, { filters: JSON.stringify({ tozeret_cd: t, degem_cd: g }), limit: "3", sort: "shnat_yitzur desc" });
    const pp = await get(PRICE, { filters: JSON.stringify({ tozeret_cd: t, degem_cd: g }), limit: "3", sort: "shnat_yitzur desc" });
    const x = ww.records[0] || {}, p = pp.records[0] || {};
    console.log(`code ${k}: units ${units[k]} | trim "${x.ramat_gimur ?? "-"}" | engine ${x.nefah_manoa ?? "-"}cc ${x.koah_sus ?? "-"}hp fuel ${x.delek_nm ?? "-"} drive ${x.technologiat_hanaa_nm ?? "-"} | price ${p.mehir ?? "none"} (${p.shnat_yitzur ?? "-"}) wltp rows ${ww.total} price rows ${pp.total}`);
  }
}
