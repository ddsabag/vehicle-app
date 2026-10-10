// Lists data.gov.il datasets related to vehicles and roads that the app does not use yet (ids found in the repo are marked)
import fs from "node:fs"; import path from "node:path";
const API = "https://data.gov.il/api/3/action/";
const used = new Set();
(function walk(d){ for (const f of fs.readdirSync(d, {withFileTypes: true})) { if (["node_modules", ".git", "out", "model", "magazine"].includes(f.name)) continue; const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(html|mjs|java|json|yml)$/.test(f.name) && fs.statSync(p).size < 3e6) for (const m of fs.readFileSync(p, "utf8").matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) used.add(m[0]); } })(".");
const Q = (process.env.QUERIES || "רכב,כלי רכב,תאונות דרכים,רישוי,תחבורה,כביש,נהג,מוסך,טעינה חשמלי,אופנוע,אוטובוס,משאית,מכון רישוי,בדיקת רכב,צמיג,דלק,גניבה,ביטוח,שעבוד,הסדר").split(",");
const seen = new Map();
for (const q of Q) {
  try {
    const r = await (await fetch(API + "package_search?" + new URLSearchParams({q, rows: "100"}), {signal: AbortSignal.timeout(60000)})).json();
    for (const p of r.result?.results || []) if (!seen.has(p.id)) seen.set(p.id, {title: p.title, org: p.organization?.title, mod: (p.metadata_modified || "").slice(0, 10), res: (p.resources || []).filter(x => x.datastore_active).map(x => ({id: x.id, name: x.name}))});
    console.log("query", q, r.result?.count);
  } catch (e) { console.log("query", q, "failed", e.message); }
}
let n = 0;
for (const [id, p] of seen) {
  const free = p.res.filter(x => !used.has(x.id));
  if (!p.res.length) continue;
  n++; console.log(`\n## ${p.title} | ${p.org} | updated ${p.mod}`);
  for (const x of p.res.slice(0, 6)) console.log(`  ${used.has(x.id) ? "USED " : "     "}${x.id} ${x.name}`);
}
console.log("\ndatasets with datastore:", n, "of", seen.size);
