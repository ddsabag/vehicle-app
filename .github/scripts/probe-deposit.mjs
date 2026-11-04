// Probe (data thread, 4.11.2026, Dudu: how the app treats a car whose licence is deposited): which open register marks a deposited licence
// or a driving ban? Field names, code counts and dataset titles only; never a plate (the log is public).
const API = "https://data.gov.il/api/3/action/";
const SETS = { active: "053cea08-09bc-40ec-8f7a-156f0677aff3", moto: "bf9df4e2-d90d-4c0a-a400-19e15af8e95f", heavy: "cd3acc5c-03c3-4c89-9c54-d40f93c0d790",
  inactive: "f6efe89a-fb3d-43a4-bb61-9bf12a9b9099", inactive2: "6f6acd03-f351-4a8f-8ecf-df792f4f573a", cancel: "851ecab1-0622-4dbe-a6c7-f950cf82abf9",
  public: "cf29862d-ca25-4691-84f6-1be60dcb4a1e", import: "03adc637-b6fe-402b-9937-7c3d3afc9140", tech: "56063a99-8a3e-4ff4-912e-5966c0279bad" };
const get = async (a, q) => { for (let i = 0; i < 4; i++) { try { const r = await fetch(API + a + "?" + new URLSearchParams(q), { headers: { "User-Agent": "luchit-probe" } }); if (r.ok) { const j = await r.json(); if (j.success) return j.result; } } catch {} await new Promise(r => setTimeout(r, 3000 * (i + 1))); } return null; };
for (const [k, id] of Object.entries(SETS)) {
  const r = await get("datastore_search", { resource_id: id, limit: 0 });
  if (!r) { console.log(`${k}: not readable`); continue; }
  const f = r.fields.map(x => x.id);
  console.log(`${k}: ${r.total} rows; fields: ${f.filter(x => x !== "_id").join(", ")}`);
  for (const c of f.filter(x => /bitul|status|hafkad|matzav|sug_bitul|kod/i.test(x) && !/degem|tozeret|zihum|delek|tzeva|sug_rechev|baalut/i.test(x))) {
    // the distinct values and their counts, from a few pages (no plates printed)
    const by = {};
    for (let p = 0; p < 10; p++) { const s = await get("datastore_search", { resource_id: id, limit: 1000, offset: Math.floor(r.total * p / 10), fields: c });
      for (const x of (s && s.records) || []) { const v = String(x[c] ?? "").slice(0, 40); by[v] = (by[v] || 0) + 1; } }
    console.log(`  ${c}: ` + Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([v, n]) => `${v || "(empty)"}=${n}`).join("; "));
  }
}
// the public register's deposit codes, counted with a filter
for (const cd of ["C", "S"]) { const r = await get("datastore_search", { resource_id: SETS.public, limit: 0, filters: JSON.stringify({ bitul_cd: cd }) }); console.log(`public bitul_cd=${cd}: ${r ? r.total : "?"}`); }
// any dataset about deposits or driving bans
for (const q of ["הפקדה", "הפקדת רישיון", "איסור שימוש", "רכב מושבת", "השבתה"]) {
  const r = await get("package_search", { q, rows: 10 });
  console.log(`search "${q}": ${r ? r.count : "?"} — ` + ((r && r.results) || []).map(p => p.title + " [" + (p.organization && p.organization.title || "") + "]").join(" | "));
}
