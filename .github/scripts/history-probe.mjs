// Probe: which datasets could show a car that left the road and came back, in the past (fields, samples, value counts).
const BASE = "https://data.gov.il/api/3/action/";
async function get(a, p, t = 6) { for (let i = 0; i < t; i++) { try { const j = await (await fetch(BASE + a + "?" + new URLSearchParams(p), {signal: AbortSignal.timeout(120000)})).json(); if (j.success) return j.result; } catch {} await new Promise(r => setTimeout(r, 3000 * (i + 1))); } return null; }
const IDS = {inactive1: "f6efe89a-fb3d-43a4-bb61-9bf12a9b9099", inactive2: "6f6acd03-f351-4a8f-8ecf-df792f4f573a", cancel1: "851ecab1-0622-4dbe-a6c7-f950cf82abf9", cancel2: "4e6b9724-4c1e-43f0-909a-154d4cc4e046", cancel3: "ec8cbc34-72e1-4b69-9c48-22821ba0bd6c", owners: "bb2355dc-9ec7-4f06-9c3f-3344672171da", tech: "56063a99-8a3e-4ff4-912e-5966c0279bad", active: "053cea08-09bc-40ec-8f7a-156f0677aff3"};
for (const [k, id] of Object.entries(IDS)) {
  const r = await get("datastore_search", {resource_id: id, limit: "3"});
  if (!r) { console.log(k, "FAIL"); continue; }
  console.log(`\n== ${k} total=${r.total}\nfields: ${r.fields.map(f => f.id).join(",")}`);
  for (const x of r.records) console.log(JSON.stringify(x).slice(0, 700));
}
// value counts of small categorical fields
for (const [k, fld] of [["owners", "baalut"], ["inactive1", null], ["cancel1", null]]) {
  if (!fld) continue;
  const r = await get("datastore_search_sql", {sql: `SELECT "${fld}", count(*) n FROM "${IDS[k]}" GROUP BY 1 ORDER BY 2 DESC LIMIT 40`});
  console.log(`\n== ${k}.${fld} counts`, r ? JSON.stringify(r.records) : "sql not available");
}
// datasets by keyword
for (const q of ["ביטול", "השבתה", "הורדה מהכביש", "אובדן", "לא פעיל", "היסטוריה", "מצב רישוי", "חידוש רישיון", "מבחן", "שינוי מבנה", "תאונה", "גניבה", "שעבוד", "הוחזר"]) {
  const r = await get("package_search", {q, rows: "15"});
  if (!r) continue;
  console.log(`\n## "${q}": ${r.count}`);
  for (const p of r.results) if (/רכב|תחבורה|רישוי/.test(p.title + (p.organization && p.organization.title))) console.log(` - ${p.title} | ${p.resources.map(x => x.id + ":" + (x.name || "").slice(0, 40)).join(" ; ")}`);
}
