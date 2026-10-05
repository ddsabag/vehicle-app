// Lists datasets on data.gov.il for given topics, with datastore fields and row counts (value-estimate / enrichment research).
const API = "https://data.gov.il/api/3/action/";
const get = async (act, params) => {
  const r = await fetch(API + act + "?" + new URLSearchParams(params), {headers: {Accept: "application/json"}});
  if (!r.ok) throw new Error(act + " HTTP " + r.status);
  return (await r.json()).result;
};
const qs = (process.env.QUERIES || "").split(",").map(s => s.trim()).filter(Boolean);
for (const q of qs) {
  console.log(`\n######## ${q}`);
  let res; try { res = await get("package_search", {q, rows: "8"}); } catch (e) { console.log(e.message); continue; }
  for (const p of res.results) {
    console.log(`\n# ${p.title} | org=${(p.organization || {}).title} | updated=${p.metadata_modified} | id=${p.id}`);
    for (const r of p.resources.slice(0, 4)) {
      let info = "";
      if (r.datastore_active) { try { const d = await get("datastore_search", {resource_id: r.id, limit: "1"}); info = `total=${d.total} fields=${d.fields.map(f => f.id).join(",")}`; } catch (e) { info = e.message; } }
      console.log(`  - ${r.format} ${r.name} id=${r.id} ${info}`);
    }
  }
}
