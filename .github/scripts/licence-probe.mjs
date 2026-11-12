// One-off (data thread, 12.11.2026; CEO full review item 3): the licence and title of every data.gov.il dataset the app reads (PLATE_SETS and
// MODEL_SETS in index.html), and the site's terms page, as text. The luchit.app terms (/terms/) rely on them. Public data only; run through
// inspect.yml (script=licence-probe.mjs); the report lands on inspect-output.
import fs from "node:fs";
const API = "https://data.gov.il/api/3/action/", H = { "User-Agent": "luchit-licence-probe/1.0" };
const html = fs.readFileSync("index.html", "utf8");
const ids = [...new Set([...html.slice(html.indexOf("const PLATE_SETS"), html.indexOf("const SYSTEMS")).matchAll(/"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g)].map(m => m[1]))];
const get = async (act, id) => { try { const r = await fetch(API + act + "?id=" + id, { headers: H, signal: AbortSignal.timeout(30000) }); return r.ok ? (await r.json()).result : null; } catch { return null; } };
const out = [];
for (const id of ids) {
  const res = await get("resource_show", id), pkg = res && await get("package_show", res.package_id);
  out.push({ resource: id, resource_name: res && res.name, dataset: pkg && pkg.title, dataset_name: pkg && pkg.name, organization: pkg && pkg.organization && pkg.organization.title,
    license_id: pkg && pkg.license_id, license_title: pkg && pkg.license_title, license_url: pkg && pkg.license_url, modified: pkg && pkg.metadata_modified });
  console.log(`${id} | ${pkg ? pkg.title : "NOT FOUND"} | ${pkg ? pkg.license_id + " / " + pkg.license_title + (pkg.license_url ? " / " + pkg.license_url : "") : ""}`);
}
const lic = await (async () => { try { const r = await fetch(API + "license_list", { headers: H }); return r.ok ? (await r.json()).result : null; } catch { return null; } })();
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/licences.json", JSON.stringify({ probed: new Date().toISOString(), datasets: out, license_list: lic }, null, 1));
for (const u of ["https://data.gov.il/terms", "https://data.gov.il/he/terms", "https://www.gov.il/he/departments/policies/data_gov_il_terms"]) {
  try { const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(30000) }); const t = await r.text();
    console.log(`terms ${u}: HTTP ${r.status}, ${t.length} chars`);
    fs.writeFileSync("out/terms-" + u.replace(/[^a-z0-9]+/gi, "_").slice(8, 60) + ".html", t);
  } catch (e) { console.log(`terms ${u}: ${e.name}`); }
}
console.log(`${out.length} resources, ${out.filter(o => o.license_id).length} with a licence`);
