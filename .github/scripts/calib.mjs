// Prints list prices (Ministry price list) per model and year, to calibrate the value estimate against asking prices.
const API = "https://data.gov.il/api/3/action/datastore_search";
const WLTP = "142afde2-6228-49f9-8a29-9b6c3a0cbe40", PRICE = "39f455bf-6db0-4926-859d-017f34eacbcb";
const get = async p => { for (let i = 0; i < 4; i++) { try { const j = await (await fetch(API + "?" + new URLSearchParams(p))).json(); if (j.success) return j.result; } catch {} await new Promise(r => setTimeout(r, 2000)); } return {records: []}; };
const cases = [["COROLLA", 2019], ["COROLLA", 2021], ["MAZDA 3", 2019], ["MAZDA3", 2019], ["MAZDA 3", 2021], ["MAZDA3", 2021], ["TUCSON", 2020], ["ELANTRA", 2021], ["PICANTO", 2019], ["OCTAVIA", 2020], ["NIRO", 2020], ["MODEL 3", 2021], ["SWIFT", 2020], ["OUTLANDER", 2019]];
for (const [q, y] of cases) {
  const r = await get({resource_id: WLTP, q, limit: "100", filters: JSON.stringify({shnat_yitzur: y})});
  const seen = new Map();
  for (const x of r.records) seen.set(x.tozeret_cd + "|" + x.degem_cd, x);
  console.log(`\n### ${q} ${y}: ${seen.size} variants`);
  for (const [k, x] of [...seen].slice(0, 14)) {
    const p = await get({resource_id: PRICE, limit: "50", filters: JSON.stringify({tozeret_cd: x.tozeret_cd, degem_cd: x.degem_cd, shnat_yitzur: y})});
    console.log(`${x.tozeret_nm} | ${x.kinuy_mishari} | ${x.ramat_gimur || ""} | ${x.delek_nm || ""} | cd=${k} | prices=${p.records.map(z => z.mehir).join(",")}`);
  }
}
