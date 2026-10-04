// Second look at the open data: can it aggregate on the server (SQL), what do the new-vehicle and personal-import datasets hold.
const API = "https://data.gov.il/api/3/action/";
const call = async (act, params) => { const r = await fetch(API + act + "?" + new URLSearchParams(params), {headers: {Accept: "application/json"}}); const t = await r.text(); try { return {status: r.status, body: JSON.parse(t)}; } catch { return {status: r.status, body: t.slice(0, 300)}; } };
const show = (t, x) => console.log(`\n### ${t}\n` + (typeof x === "string" ? x : JSON.stringify(x)).slice(0, 2500));
const ACTIVE = "053cea08-09bc-40ec-8f7a-156f0677aff3", IMPORT = "03adc637-b6fe-402b-9937-7c3d3afc9140", HEAVY = "cd3acc5c-03c3-4c89-9c54-d40f93c0d790", NEWNOCODE = "c967097c-3c74-4adf-a732-0fdd2fda56d9";
const sql = q => call("datastore_search_sql", {sql: q});
show("SQL works? monthly counts of registration month, last rows", await sql(`SELECT moed_aliya_lakvish AS m, count(*) AS n FROM "${ACTIVE}" WHERE shnat_yitzur >= 2024 GROUP BY moed_aliya_lakvish ORDER BY n DESC LIMIT 8`));
show("SQL: first owner type distribution (tech.mkoriut_nm)", await sql(`SELECT mkoriut_nm AS k, count(*) AS n FROM "56063a99-8a3e-4ff4-912e-5966c0279bad" GROUP BY mkoriut_nm ORDER BY n DESC LIMIT 12`));
show("SQL: current ownership type distribution (active.baalut)", await sql(`SELECT baalut AS k, count(*) AS n FROM "${ACTIVE}" GROUP BY baalut ORDER BY n DESC LIMIT 12`));
show("import sample rows", (await call("datastore_search", {resource_id: IMPORT, limit: "3"})).body);
show("import sug_yevu distribution", await sql(`SELECT sug_yevu AS k, count(*) AS n FROM "${IMPORT}" GROUP BY sug_yevu ORDER BY n DESC LIMIT 10`));
show("heavy kvutzat_sug_rechev distribution", await sql(`SELECT kvutzat_sug_rechev AS k, count(*) AS n FROM "${HEAVY}" GROUP BY kvutzat_sug_rechev ORDER BY n DESC LIMIT 10`));
show("new vehicles without model code: fields + rows", (await call("datastore_search", {resource_id: NEWNOCODE, limit: "6"})).body);
for (const q of ["כלי רכב חדשים", "עולים לכביש", "יבואן", "קוד דגם", "ביטול רישוי", "העברת בעלות"]) {
  const r = await call("package_search", {q, rows: "25"});
  const res = r.body && r.body.result; if (!res) { show("search " + q, r.body); continue; }
  console.log(`\n# "${q}": ${res.count}`); for (const p of res.results) console.log(`- ${p.title} | ${p.organization && p.organization.title} | ${p.resources.filter(x => x.datastore_active).map(x => x.id + ":" + x.name).slice(0, 4).join("; ")}`);
}
