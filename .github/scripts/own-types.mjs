// Distinct ownership-type values in the ministry registers (CKAN datastore_search with distinct=true), with counts for each value.
const API = "https://data.gov.il/api/3/action/datastore_search";
const SETS = { active: "053cea08-09bc-40ec-8f7a-156f0677aff3", tech: "56063a99-8a3e-4ff4-912e-5966c0279bad", owners: "bb2355dc-9ec7-4f06-9c3f-3344672171da", cancelled: "851ecab1-0622-4dbe-a6c7-f950cf82abf9", inactive: "f6efe89a-fb3d-43a4-bb61-9bf12a9b9099", taxi_public: "cf29862d-0806-4a08-9f8a-ddf90ab3e1a3" };
const FIELDS = { active: ["baalut", "sug_rechev_nm"], tech: ["mkoriut_nm"], owners: ["baalut"], cancelled: ["baalut"], inactive: ["baalut"], taxi_public: ["sug_rechev_nm", "baalut"] };
async function j(u) { for (let i = 0; i < 4; i++) { try { const r = await fetch(u, { headers: { Accept: "application/json" } }); if (r.ok) return await r.json(); console.log("http", r.status, u); } catch (e) { console.log("err", e.message); } await new Promise(r => setTimeout(r, 3000 * (i + 1))); } return null; }
for (const [name, id] of Object.entries(SETS)) for (const f of FIELDS[name]) {
  const d = await j(`${API}?resource_id=${id}&fields=${f}&distinct=true&limit=200`);
  const vals = d && d.success ? d.result.records.map(r => r[f]) : null;
  console.log(`\n## ${name}.${f}: ${vals ? vals.length + " distinct" : "FAILED " + JSON.stringify(d && d.error).slice(0, 200)}`);
  if (!vals) continue;
  for (const v of vals) { const c = await j(`${API}?resource_id=${id}&filters=${encodeURIComponent(JSON.stringify({ [f]: v }))}&limit=0`); console.log(`${JSON.stringify(v)}\t${c && c.success ? c.result.total : "?"}`); }
}
