// Probe (data thread, 3.11.2026, Dudu: "אפשר לבדוק את זה קצת יותר לעומק?"): do cars that left the road have a km reading or a test date
// in any register? Prints field names and counts only, never a plate (the log is public).
const API = "https://data.gov.il/api/3/action/";
const SETS = { active: "053cea08-09bc-40ec-8f7a-156f0677aff3", cancel: "851ecab1-0622-4dbe-a6c7-f950cf82abf9", cancel2010: "4e6b9724-4c1e-43f0-909a-154d4cc4e046", cancel2000: "ec8cbc34-72e1-4b69-9c48-22821ba0bd6c",
  inactive: "f6efe89a-fb3d-43a4-bb61-9bf12a9b9099", inactive2: "6f6acd03-f351-4a8f-8ecf-df792f4f573a" };
const TECH = "56063a99-8a3e-4ff4-912e-5966c0279bad", ACTIVE = "053cea08-09bc-40ec-8f7a-156f0677aff3";
const get = async (a, q) => { for (let i = 0; i < 4; i++) { try { const r = await fetch(API + a + "?" + new URLSearchParams(q), { headers: { "User-Agent": "luchit-probe" } }); if (r.ok) { const j = await r.json(); if (j.success) return j.result; } } catch {} await new Promise(r => setTimeout(r, 3000 * (i + 1))); } return null; };
const fieldsOf = async id => { const r = await get("datastore_search", { resource_id: id, limit: 0 }); return r ? { n: r.total, f: r.fields.map(x => x.id) } : null; };
const t = await fieldsOf(TECH), act = await fieldsOf(ACTIVE);
console.log(`tech register: ${t && t.n} rows; fields: ${t && t.f.join(", ")}`);
console.log(`active register fields with km/test: ${act && act.f.filter(f => /kilo|km|mivchan|test|tokef/i.test(f)).join(", ")}`);
const sqlOk = await get("datastore_search_sql", { sql: `SELECT COUNT(*) AS n FROM "${TECH}"` });
console.log(`SQL: ${sqlOk ? "available" : "not available"}`);
for (const [k, id] of Object.entries(SETS)) {
  const s = await fieldsOf(id); if (!s) { console.log(`${k}: not readable`); continue; }
  console.log(`\n${k}: ${s.n} rows; km/test fields: ${s.f.filter(f => /kilo|km|mivchan|test|tokef|bitul/i.test(f)).join(", ") || "none"}`);
  const dateF = s.f.find(f => /bitul_dt/i.test(f)), testF = s.f.find(f => /mivchan_acharon_dt/i.test(f)), kmF = s.f.find(f => /kilometer/i.test(f));
  // a sample spread over the register: 6 pages of 100
  const plates = [], rows = [];
  for (let p = 0; p < 6; p++) {
    const r = await get("datastore_search", { resource_id: id, limit: 100, offset: Math.floor((s.n - 100) * p / 5), fields: [ "mispar_rechev", dateF, testF, kmF ].filter(Boolean).join(",") });
    for (const x of (r && r.records) || []) { rows.push(x); if (x.mispar_rechev) plates.push(x.mispar_rechev); }
  }
  const yr = x => { const m = String(x[dateF] || "").match(/(19|20)\d\d/); return m ? m[0] : "?"; };
  const by = {}; for (const x of rows) { const y = yr(x); by[y] = (by[y] || 0) + 1; }
  console.log(`  sample ${rows.length}; left-the-road years: ${Object.entries(by).sort().map(([y, n]) => y + ":" + n).join(" ")}`);
  if (testF) console.log(`  with a last-test date in this register: ${rows.filter(x => x[testF] && !/^0|1900|0001/.test(String(x[testF]))).length}`);
  if (kmF) console.log(`  with a km reading in this register: ${rows.filter(x => +x[kmF] > 0).length}`);
  // the same cars in the tech register (the km the app shows)
  let inTech = 0, withKm = 0; const kmByYear = {};
  for (let i = 0; i < plates.length; i += 50) {
    const chunk = plates.slice(i, i + 50);
    const r = await get("datastore_search", { resource_id: TECH, limit: 200, filters: JSON.stringify({ mispar_rechev: chunk }) });
    const hit = new Map(((r && r.records) || []).map(x => [String(x.mispar_rechev), x]));
    for (const x of rows.filter(x => chunk.includes(x.mispar_rechev))) { const h = hit.get(String(x.mispar_rechev)); if (!h) continue; inTech++;
      if (+h.kilometer_test_aharon > 0) { withKm++; const y = yr(x); kmByYear[y] = (kmByYear[y] || 0) + 1; } }
  }
  console.log(`  of ${plates.length} sampled cars: ${inTech} have a row in the tech register, ${withKm} with a km reading; by year left: ${Object.entries(kmByYear).sort().map(([y, n]) => y + ":" + n).join(" ") || "-"}`);
}
