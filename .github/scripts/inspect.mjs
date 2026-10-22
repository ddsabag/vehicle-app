// Prints what the open datasets hold for given plates and which datasets exist for a topic.
// Runs on GitHub (data.gov.il is not reachable from the development container).
import fs from "node:fs";
const html = fs.readFileSync("index.html", "utf8");
const block = html.slice(html.indexOf("const PLATE_SETS"), html.indexOf("const MODEL_SETS"));
const sets = [...block.matchAll(/\{key:"([^"]+)",\s*id:"([0-9a-f-]{36})"[^}]*?(?:field:"([^"]+)")?[^}]*\}/g)].map(m => ({key: m[1], id: m[2], field: m[3] || "mispar_rechev"}));
const API = "https://data.gov.il/api/3/action/";
const get = async (act, params) => {
  const r = await fetch(API + act + "?" + new URLSearchParams(params), {headers: {Accept: "application/json"}});
  if (!r.ok) throw new Error(act + " HTTP " + r.status);
  return (await r.json()).result;
};
const PLATES_RAW = process.env.PLATES || "38548003";   // the app's public example plate (EXAMPLE_PLATE); others come as "b64:<base64 of a comma-separated list>"
const plates = (PLATES_RAW.startsWith("b64:") ? Buffer.from(PLATES_RAW.slice(4), "base64").toString("utf8") : PLATES_RAW).split(",").map(s => s.replace(/\D/g, "")).filter(Boolean);
for (const [pi, plate] of plates.entries()) {
  console.log(`\n===== plate #${pi + 1} =====`);   // the number itself never goes to the log
  for (const s of sets) {
    for (const v of [plate, Number(plate), plate.padStart(8, "0")]) {
      try {
        const res = await get("datastore_search", {resource_id: s.id, filters: JSON.stringify({[s.field]: v}), limit: "3"});
        // the row with its plate and VIN masked: the log and the inspect-output branch are public
        const row = () => JSON.stringify(res.records[0]).split(String(Number(plate))).join("#plate").replace(/"(misgeret|mispar_shilda|vin)":"[^"]*"/gi, '"$1":"#"');
        if (res.records.length) { console.log(`--- ${s.key} (${s.id}) ${s.field}=#plate -> ${res.records.length} rows`); console.log(row()); break; }
      } catch (e) { console.log(`--- ${s.key}: ${e.message}`); break; }
    }
  }
}
console.log("\n===== fields per dataset =====");
for (const s of sets) {
  try { const res = await get("datastore_search", {resource_id: s.id, limit: "1"}); console.log(`${s.key}: total=${res.total} fields=${res.fields.map(f => f.id).join(",")}`); }
  catch (e) { console.log(`${s.key}: ${e.message}`); }
}
console.log("\n===== dataset search =====");
for (const q of (process.env.QUERIES || "שעבוד,משועבד,רכב,יבוא אישי,רישום,מסירות,בעלות").split(",")) {
  try {
    const res = await get("package_search", {q, rows: "40"});
    console.log(`\n# "${q}": ${res.count} datasets`);
    for (const p of res.results) console.log(`- ${p.title} | ${p.organization && p.organization.title} | ${p.resources.filter(r => r.datastore_active).map(r => r.id + ":" + r.name).slice(0, 3).join("; ")}`);
  } catch (e) { console.log(`"${q}": ${e.message}`); }
}
