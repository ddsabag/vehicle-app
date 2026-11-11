// One-off (data thread, 11.11.2026): which Ministry of Transport datasets hold any plate of one block of 1000 plates. The block (5 leading
// digits) stands for no single car; the found rows are encrypted with .github/seo-data.pub.pem, the log prints counts only.
import fs from "node:fs";
import { encrypt } from "./camp-data.mjs";
const BLOCK = "15403", API = "https://data.gov.il/api/3/action/";
const plates = Array.from({ length: 1000 }, (_, i) => BLOCK + String(i).padStart(3, "0"));
const html = fs.readFileSync("index.html", "utf8");
const block = html.slice(html.indexOf("const PLATE_SETS"), html.indexOf("const MODEL_SETS"));
const sets = [...block.matchAll(/\{key:"([^"]+)",\s*id:"([0-9a-f-]{36})"[^}]*?\}/g)].map(m => ({ key: m[1], id: m[2], field: (m[0].match(/field:"([^"]+)"/) || [])[1] || "mispar_rechev" }));
const get = async (act, p) => { for (let a = 0; a < 3; a++) { await new Promise(r => setTimeout(r, 600)); try { const r = await fetch(API + act, { method: "POST", headers: { "User-Agent": "luchit-probe/1.0", "Content-Type": "application/json" }, body: JSON.stringify(p), signal: AbortSignal.timeout(30000) }); if (r.ok) return await r.json(); console.log(`  HTTP ${r.status}`); } catch (e) { console.log(`  ${e.name}`); } await new Promise(r => setTimeout(r, 3000 * (a + 1))); } return null; };
// every other datastore resource of the ministry that has a plate column
const pk = process.env.EXTRA === "1" ? await get("package_search", { q: "רכב", rows: 300 }) : null;
console.log("extra resources: " + (((pk && pk.result && pk.result.results) || []).length));
const extra = [];
for (const p of (pk && pk.result && pk.result.results) || []) for (const r of p.resources || []) if (r.datastore_active && !sets.some(s => s.id === r.id)) extra.push({ key: "x:" + (p.title || p.name).slice(0, 60) + " / " + (r.name || "").slice(0, 40), id: r.id });
const out = { block: BLOCK, sets: {} }, log = [];
for (const s of process.env.EXTRA === "1" ? extra : [...sets, ...extra]) {
  let fields = [s.field];
  if (s.key.startsWith("x:")) { const f = await get("datastore_search", { resource_id: s.id, limit: "0" }); const names = ((f && f.result && f.result.fields) || []).map(x => x.id); fields = names.filter(n => /mispar.?rechev|MISPAR.?RECHEV|מספר.?רכב/i.test(n)); if (!fields.length) continue; }
  const rows = []; let err = 0;
  for (const field of fields) for (let i = s.key.startsWith("x:") ? 200 : 0; i < (s.key.startsWith("x:") ? 300 : plates.length); i += 100) {
    const chunk = plates.slice(i, i + 100), vals = [...chunk, ...chunk.map(Number)];
    const j = await get("datastore_search", { resource_id: s.id, filters: { [field]: vals }, limit: 1000 });
    if (!j || !j.success) { err++; continue; }
    rows.push(...j.result.records);
  }
  out.sets[s.key] = { id: s.id, fields, err, rows };
  console.log(`${s.key.startsWith("x:") ? "extra" : s.key}: ${rows.length} rows${err ? ", " + err + " failed" : ""}`);
  log.push(`${s.key.startsWith("x:") ? "extra" : s.key}: ${rows.length} rows${err ? ", " + err + " failed" : ""}`);
}
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/plate-block.enc.json", JSON.stringify(encrypt(out, fs.readFileSync(".github/seo-data.pub.pem", "utf8"))));
console.log(log.join("\n")); console.log("probe: written encrypted");
