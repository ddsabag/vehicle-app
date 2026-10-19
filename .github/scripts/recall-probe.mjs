// Shows where the "model recall history" card of a plate comes from: the car's register row, its importer, its own open recalls,
// the maker's recall file in the catalogue, which rows the app's matcher keeps, and for each one the ministry's full recall row
// and how many cars in Israel still have it open. Runs on GitHub (data.gov.il is not reachable from the development container).
// PLATES may be "b64:<base64 of a comma-separated list>" so the plate is not written into the public run log; the report masks it.
import fs from "node:fs";
import {appMatcher} from "./app-matcher.mjs";
const html = fs.readFileSync("index.html", "utf8");
const block = html.slice(html.indexOf("const PLATE_SETS"), html.indexOf("const MODEL_SETS"));
const SETS = [...block.matchAll(/\{key:"([^"]+)",\s*id:"([0-9a-f-]{36})"[^}]*?(?:field:"([^"]+)")?[^}]*\}/g)].map(m => ({key: m[1], id: m[2], field: m[3] || "mispar_rechev"}));
const MODEL = Object.fromEntries([...html.slice(html.indexOf("const MODEL_SETS")).slice(0, 600).matchAll(/(\w+):\s*"([0-9a-f-]{36})"/g)].map(m => [m[1], m[2]]));
const {matchModelRecalls, brandModels} = appMatcher();   // the app's own matcher, taken from index.html so the probe keeps up with it
const API = "https://data.gov.il/api/3/action/", CAT = "https://raw.githubusercontent.com/ddsabag/vehicle-app/catalog-data/";
const get = async (act, params) => {
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(API + act + "?" + new URLSearchParams(params), {headers: {Accept: "application/json"}, signal: AbortSignal.timeout(60000)});
      if (!r.ok) throw new Error(act + " HTTP " + r.status);
      return (await r.json()).result;
    } catch (e) { if (a >= 2) throw e; await new Promise(r => setTimeout(r, 3000 * (a + 1))); }
  }
};
const search = (id, filters, limit = 50) => get("datastore_search", {resource_id: id, filters: JSON.stringify(filters), limit: String(limit)});
const raw = process.env.PLATES || "";
const plates = (raw.startsWith("b64:") ? Buffer.from(raw.slice(4), "base64").toString("utf8") : raw).split(",").map(s => s.replace(/\D/g, "")).filter(Boolean);
const mask = p => p.length > 4 ? p.slice(0, 2) + "x".repeat(p.length - 4) + p.slice(-2) : "xx";
const show = (o, keys) => keys.filter(k => o[k] !== undefined && o[k] !== null && String(o[k]).trim() !== "").map(k => `${k}=${String(o[k]).trim()}`).join(" | ");

let recallFields = null, openFields = null;
try { recallFields = (await get("datastore_search", {resource_id: MODEL.recalls, limit: "1"})).fields.map(f => f.id); } catch (e) { console.log("recall list fields: " + e.message); }
try { openFields = (await get("datastore_search", {resource_id: SETS.find(s => s.key === "recall").id, limit: "1"})).fields.map(f => f.id); } catch (e) { console.log("open recalls fields: " + e.message); }
console.log("recall list (" + MODEL.recalls + ") fields: " + (recallFields || []).join(","));
console.log("open recalls per car fields: " + (openFields || []).join(","));
const openRecallField = (openFields || []).find(f => /recall/i.test(f) && /id|mispar/i.test(f)) || "RECALL_ID";

for (const plate of plates) {
  console.log(`\n===== plate ${mask(plate)} =====`);
  let v = null, from = null;
  for (const s of SETS.filter(s => s.key !== "recall")) {
    for (const val of [Number(plate), plate]) {
      try { const r = await search(s.id, {[s.field]: val}, 3); if (r.records.length) { if (s.key !== "tag" && s.key !== "dpf" && !v && /^(active|moto|heavy|public|import|inactive|inactive2|cancel|cancel2010|cancel2000)$/.test(s.key)) { v = r.records[0]; from = s.key; } console.log(`in ${s.key}: ${r.records.length} row(s)`); break; } }
      catch (e) { console.log(`${s.key}: ${e.message}`); break; }
    }
  }
  if (!v) { console.log("no register row"); continue; }
  console.log(`register (${from}): ` + show(v, ["tozeret_cd", "tozeret_nm", "tozar", "degem_cd", "degem_nm", "kinuy_mishari", "sug_degem", "shnat_yitzur", "moed_aliya_lakvish", "ramat_gimur", "baalut", "tozeret_eretz_nm"]));
  const own = await search(SETS.find(s => s.key === "recall").id, {MISPAR_RECHEV: Number(plate)}, 50).catch(e => ({records: [], err: e.message}));
  console.log(`\nthe car's own open recalls: ${own.records.length}${own.err ? " (" + own.err + ")" : ""}`);
  for (const r of own.records) console.log("  " + show(r, Object.keys(r).filter(k => k !== "_id" && !/MISPAR_RECHEV/i.test(k))));
  try {
    const p = await search(MODEL.price, {tozeret_cd: Number(v.tozeret_cd), degem_cd: Number(v.degem_cd)}, 50);
    const imps = [...new Set(p.records.map(r => String(r.shem_yevuan || "").trim()).filter(Boolean))];
    console.log(`\nprice list rows for the model: ${p.records.length}, importers: ${imps.join(" / ") || "none"}; years ${[...new Set(p.records.map(r => r.shnat_yitzur))].sort().join(",")}`);
  } catch (e) { console.log("price list: " + e.message); }
  const cd = String(Number(v.tozeret_cd));
  const idx = await fetch(`${CAT}c/${cd}.json`).then(r => r.ok ? r.json() : null).catch(() => null);
  if (idx) console.log(`catalogue maker ${cd}: n=${idx.n} tozar=${idx.tozar} eretz=${idx.eretz} brand importer=${JSON.stringify(idx.imp)}`);
  const rec = await fetch(`${CAT}r/${cd}.json`).then(r => r.ok ? r.json() : null).catch(() => null);
  if (!rec) { console.log(`catalogue recall file r/${cd}.json: missing`); continue; }
  const brands = [...new Set(rec.rows.map(r => r.TOZAR_TEUR))], importers = {};
  for (const r of rec.rows) importers[r.YEVUAN_TEUR || "?"] = (importers[r.YEVUAN_TEUR || "?"] || 0) + 1;
  console.log(`catalogue recall file r/${cd}.json (built ${rec.u}): ${rec.rows.length} rows, brands ${brands.join(", ")}`);
  console.log("  importers in the file: " + Object.entries(importers).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n})`).join(", "));
  // as the app calls it: with every model name of the brand (meta.json) and the model's WLTP row (body, powertrain)
  const meta = await fetch(`${CAT}meta.json`).then(r => r.ok ? r.json() : null).catch(() => null);
  const wr = await search(MODEL.wltp, {tozeret_cd: Number(v.tozeret_cd), degem_cd: Number(v.degem_cd), shnat_yitzur: Number(v.shnat_yitzur)}, 5).catch(() => ({records: []}));
  const hits = matchModelRecalls(rec.rows, v, brandModels(meta, v), wr.records[0] || {}), kept = new Set(hits.map(h => h.RECALL_ID + "|" + h.DEGEM));
  console.log(`\nthe app's matcher keeps ${hits.length} row(s) for degem_nm="${v.degem_nm}" kinuy_mishari="${v.kinuy_mishari}" year ${v.shnat_yitzur}:`);
  for (const h of hits) {
    console.log(`\n--- recall ${h.RECALL_ID}: fits=${h.fits}`);
    console.log("  catalogue row: " + show(h, ["TOZAR_TEUR", "DEGEM", "SHNAT_RECALL", "BUILD_BEGIN_A", "BUILD_END_A", "SUG_RECALL", "SUG_TAKALA", "TEUR_TAKALA", "OFEN_TIKUN", "TKINA_EU", "YEVUAN_TEUR", "WEBSITE", "TAARICH_PTICHA"]));
    try {
      const full = await search(MODEL.recalls, {RECALL_ID: Number(h.RECALL_ID)}, 5);
      for (const r of full.records) console.log("  ministry row: " + show(r, Object.keys(r).filter(k => k !== "_id")));
      if (!full.records.length) console.log("  ministry row: none for this RECALL_ID");
    } catch (e) { console.log("  ministry row: " + e.message); }
    try {
      const open = await get("datastore_search", {resource_id: SETS.find(s => s.key === "recall").id, filters: JSON.stringify({[openRecallField]: Number(h.RECALL_ID)}), limit: "200"});
      const years = {}; for (const r of open.records) { const k = Object.entries(r).find(([k]) => /shnat|year/i.test(k)); if (k) years[k[1]] = (years[k[1]] || 0) + 1; }
      console.log(`  cars in Israel with this recall still open: ${open.total}` + (Object.keys(years).length ? ` (sample years ${JSON.stringify(years)})` : ""));
      if (open.records[0]) console.log("  sample open row (plate removed): " + show(open.records[0], Object.keys(open.records[0]).filter(k => k !== "_id" && !/MISPAR_RECHEV/i.test(k))));
    } catch (e) { console.log("  open count: " + e.message); }
  }
  const near = rec.rows.filter(r => !kept.has(r.RECALL_ID + "|" + r.DEGEM) && [v.degem_nm, v.kinuy_mishari].some(n => n && String(r.DEGEM || "").toUpperCase().includes(String(n).toUpperCase().slice(0, 3))));
  console.log(`\nother rows in the file sharing the first 3 letters of the model name (not shown by the app): ${near.length}`);
  for (const r of near.slice(0, 15)) console.log("  " + show(r, ["RECALL_ID", "DEGEM", "BUILD_BEGIN_A", "BUILD_END_A", "YEVUAN_TEUR", "TAARICH_PTICHA"]));
}

console.log("\n===== recall datasets on data.gov.il =====");
for (const q of ["ריקול", "ריקולים", "recall"]) {
  try {
    const res = await get("package_search", {q, rows: "20"});
    console.log(`\n# "${q}": ${res.count} datasets`);
    for (const p of res.results) console.log(`- ${p.title} | ${p.organization && p.organization.title} | ${p.resources.filter(r => r.datastore_active).map(r => r.id + ":" + r.name).slice(0, 4).join("; ")}`);
  } catch (e) { console.log(`"${q}": ${e.message}`); }
}
