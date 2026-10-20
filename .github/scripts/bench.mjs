// Times the ministry API the way the app uses it (runs on GitHub; data.gov.il is not reachable from the dev container).
import fs from "node:fs";
const html = fs.readFileSync("index.html", "utf8");
const block = html.slice(html.indexOf("const PLATE_SETS"), html.indexOf("const MODEL_SETS"));
const sets = [...block.matchAll(/\{key:"([^"]+)",\s*id:"([0-9a-f-]{36})"([^}]*)\}/g)].map(m => ({key: m[1], id: m[2], field: (m[3].match(/field:"([^"]+)"/) || [])[1] || "mispar_rechev", pad: /pad:true/.test(m[3])}));
const API = "https://data.gov.il/api/3/action/datastore_search";
const plates = (process.env.PLATES || "75350003,46644401").split(",");
const ms = () => Number(process.hrtime.bigint() / 1000000n);
async function q(id, filters, limit = 100, extra = {}) {
  const t = ms();
  try {
    const r = await fetch(`${API}?` + new URLSearchParams({resource_id: id, filters: JSON.stringify(filters), limit: String(limit), ...extra}), {headers: {Accept: "application/json"}});
    const txt = await r.text(); let n = -1; try { n = JSON.parse(txt).result.records.length; } catch {}
    return {ms: ms() - t, status: r.status, rows: n, bytes: txt.length};
  } catch (e) { return {ms: ms() - t, status: "ERR " + e.message, rows: -1, bytes: 0}; }
}
const med = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
for (const plate of plates) {
  console.log(`\n===== plate ${plate} =====`);
  console.log("-- one request per dataset, string form vs number form (3 reps each), median ms");
  for (const s of sets) {
    const a = [], b = []; let ra = 0, rb = 0;
    for (let i = 0; i < 3; i++) { const x = await q(s.id, {[s.field]: plate}); a.push(x.ms); ra = x.rows; const y = await q(s.id, {[s.field]: Number(plate)}); b.push(y.ms); rb = y.rows; }
    console.log(`${s.key.padEnd(11)} str ${String(med(a)).padStart(5)}ms rows=${ra}   num ${String(med(b)).padStart(5)}ms rows=${rb}`);
  }
  console.log("-- whole lookup, all datasets in parallel with the app's retry forms (5 runs)");
  for (let i = 0; i < 5; i++) {
    const t = ms(); let reqs = 0;
    await Promise.all(sets.map(async s => { const forms = s.pad ? [plate, plate.padStart(7, "0"), plate.padStart(8, "0")] : [plate]; for (const v of [...new Set(forms)]) { reqs++; const x = await q(s.id, {[s.field]: v}); if (x.rows > 0) break; } }));
    console.log(`run ${i + 1}: ${ms() - t}ms, ${reqs} requests`);
  }
  console.log("-- same, but only the first form per dataset (what a learned form would cost)");
  for (let i = 0; i < 3; i++) { const t = ms(); await Promise.all(sets.map(s => q(s.id, {[s.field]: plate}))); console.log(`run ${i + 1}: ${ms() - t}ms, ${sets.length} requests`); }
  console.log("-- same, but only active + the extra datasets (no rare vehicle types)");
  const core = sets.filter(s => ["active", "cont", "tech", "owners", "recall", "tag", "dpf"].includes(s.key));
  for (let i = 0; i < 3; i++) { const t = ms(); await Promise.all(core.map(s => q(s.id, {[s.field]: plate}))); console.log(`run ${i + 1}: ${ms() - t}ms, ${core.length} requests`); }
}
console.log("\n===== model stage (needs tozeret_cd/degem_cd of a real car; uses the first plate's active row) =====");
const first = plates[0];
const act = await (await fetch(`${API}?` + new URLSearchParams({resource_id: sets[0].id, filters: JSON.stringify({mispar_rechev: first}), limit: "1"}))).json();
const rec = act.result && act.result.records[0];
if (rec) {
  const ids = {wltp: "142afde2-6228-49f9-8a29-9b6c3a0cbe40", counts: "5e87a7a1-2f6f-41c1-8aec-7216d52a6cf6", price: "39f455bf-6db0-4926-859d-017f34eacbcb"};
  for (const [k, id] of Object.entries(ids)) { const r = []; for (let i = 0; i < 3; i++) r.push(await q(id, {tozeret_cd: rec.tozeret_cd, degem_cd: rec.degem_cd}, 300)); console.log(k, r.map(x => `${x.ms}ms/${x.rows}rows/${x.bytes}B`).join("  ")); }
  const r = []; for (let i = 0; i < 3; i++) r.push(await q("2c33523f-87aa-44ec-a736-edbb0a82975e", {TOZAR_CD: rec.tozeret_cd}, 1000)); console.log("recalls-by-maker", r.map(x => `${x.ms}ms/${x.rows}rows/${x.bytes}B`).join("  "));
  const t = ms(); await Promise.all(Object.values(ids).map(id => q(id, {tozeret_cd: rec.tozeret_cd, degem_cd: rec.degem_cd}, 300)).concat(q("2c33523f-87aa-44ec-a736-edbb0a82975e", {TOZAR_CD: rec.tozeret_cd}, 1000))); console.log("model stage in parallel:", ms() - t, "ms");
}
