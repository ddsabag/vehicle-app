const API = "https://data.gov.il/api/3/action/";
const get = async (p) => (await (await fetch(API + "datastore_search?" + new URLSearchParams(p))).json()).result;
for (const [name, id, extra] of [["monthly new vehicles WITH model code", "602ac32d-19c0-4b41-88e0-e3ce8a7e80b7", {}], ["monthly new vehicles WITH model code, 2026 rows", "602ac32d-19c0-4b41-88e0-e3ce8a7e80b7", {q: "2026"}], ["no-model-code monthly latest", "c967097c-3c74-4adf-a732-0fdd2fda56d9", {sort: "sgira_month desc"}], ["counts by model/year dataset", "5e87a7a1-2f6f-41c1-8aec-7216d52a6cf6", {}], ["importers+price list", "39f455bf-6db0-4926-859d-017f34eacbcb", {}], ["EVs by area", "07421a4e-5b12-4444-9173-5ca297b31f79", {}]]) {
  try { const r = await get({resource_id: id, limit: "6", ...extra}); console.log(`\n### ${name} total=${r.total}\nfields: ${r.fields.map(f => f.id + (f.info && f.info.notes ? "(" + f.info.notes + ")" : "")).join(", ")}\n` + r.records.map(x => JSON.stringify(x)).join("\n")); }
  catch (e) { console.log(name, e.message); }
}
