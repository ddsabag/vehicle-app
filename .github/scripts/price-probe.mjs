// One-off probe: field list and sample rows of the Ministry price-list dataset, and rows for a few recently launched models. Prints only.
const API = "https://data.gov.il/api/3/action/datastore_search", ID = "39f455bf-6db0-4926-859d-017f34eacbcb";
const get = async p => (await (await fetch(API + "?" + new URLSearchParams({ resource_id: ID, ...p }), { signal: AbortSignal.timeout(60000) })).json()).result;
const f = await get({ limit: "3" });
console.log("total", f.total, "\nfields", f.fields.map(x => x.id + ":" + x.type).join(", "), "\nsample", JSON.stringify(f.records[0]));
for (const q of ["TAYRON", "TERRAMAR", "ATTO 3", "TIGGO 7", "C-HR", "MAGE", "ORA 5", "DUSTER"]) {
  const r = await get({ q, limit: "400", sort: "shnat_yitzur desc" });
  console.log("\n== " + q, r.total, "rows");
  for (const x of r.records.slice(0, 12)) console.log(JSON.stringify(x).slice(0, 420));
}
