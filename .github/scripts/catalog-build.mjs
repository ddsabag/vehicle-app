// Builds the static model catalogue the comparison reads instead of querying the ministry live (0 requests to data.gov.il
// when a model is picked or added). Published on the catalog-data branch (force-pushed, one commit) by catalog.yml.
//   meta.json      {u, cols, makers: {cd: {n: maker name, m: [model names as the register spells them]}}}
//   c/<cd>.json    {u, cd, n, cols, rows: [[...]]}   one row per catalogue line of that maker: the WLTP fields the app shows,
//                  plus the price-list columns (mehir, shem_yevuan) and the counts (mispar_rechavim_pailim / le_pailim), joined by _id or key
//   r/<cd>.json    {u, rows: [...]}                  every recall of that maker (TOZAR_CD), the fields the app reads
// Runs on a GitHub runner (data.gov.il blocks other networks). OUT (default cat-out) is the output directory.
import fs from "node:fs";
const API = "https://data.gov.il/api/3/action/datastore_search";
const ID = {wltp: "142afde2-6228-49f9-8a29-9b6c3a0cbe40", price: "39f455bf-6db0-4926-859d-017f34eacbcb", counts: "5e87a7a1-2f6f-41c1-8aec-7216d52a6cf6", recalls: "2c33523f-87aa-44ec-a736-edbb0a82975e"};
const OUT = process.env.OUT || "out", PAGE = 30000, T0 = Date.now();
const log = m => console.log(`[${Math.round((Date.now() - T0) / 1000)}s] ${m}`);
// every WLTP column index.html reads (grep of the field names), in the order the shard stores them
const COLS = ["_id", "sug_degem", "tozeret_cd", "tozeret_nm", "tozeret_eretz_nm", "tozar", "degem_cd", "degem_nm", "shnat_yitzur", "kvuzat_agra_cd", "nefah_manoa", "mishkal_kolel", "hanaa_nm",
  "mazgan_ind", "abs_ind", "mispar_kariot_avir", "hege_koah_ind", "automatic_ind", "mispar_halonot_hashmal", "halon_bagg_ind", "galgaley_sagsoget_kala_ind", "merkav", "ramat_gimur", "delek_nm",
  "mispar_dlatot", "koah_sus", "mispar_moshavim", "bakarat_yatzivut_ind", "kosher_grira_im_blamim", "kosher_grira_bli_blamim", "technologiat_hanaa_nm", "kamut_CO2", "madad_yarok", "kvutzat_zihum",
  "bakarat_stiya_menativ_ind", "nitur_merhak_milfanim_ind", "zihuy_beshetah_nistar_ind", "bakarat_shyut_adaptivit_ind", "zihuy_holchey_regel_ind", "maarechet_ezer_labalam_ind", "matzlemat_reverse_ind",
  "hayshaney_lahatz_avir_batzmigim_ind", "hayshaney_hagorot_ind", "ramat_eivzur_betihuty", "teura_automatit_benesiya_kadima_ind", "shlita_automatit_beorot_gvohim_ind", "zihuy_matzav_hitkarvut_mesukenet_ind",
  "zihuy_tamrurey_tnua_ind", "zihuy_rechev_do_galgali", "CO2_WLTP", "bakarat_stiya_activ_s", "blima_otomatit_nesia_leahor", "bakarat_mehirut_isa", "blimat_hirum_lifnei_holhei_regel_ofanaim", "hitnagshut_cad_shetah_met", "kinuy_mishari"];
const EXTRA = ["mehir", "shem_yevuan", "mispar_rechavim_pailim", "mispar_rechavim_le_pailim"];
const RECALL_COLS = ["RECALL_ID", "TOZAR_CD", "TOZAR_TEUR", "DEGEM", "SHNAT_RECALL", "BUILD_BEGIN_A", "BUILD_END_A", "SUG_RECALL", "SUG_TAKALA", "TEUR_TAKALA", "OFEN_TIKUN", "TKINA_EU", "YEVUAN_TEUR", "TELEPHONE", "WEBSITE", "TAARICH_PTICHA"];

async function call(params, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(API + "?" + new URLSearchParams(params), {signal: AbortSignal.timeout(120000), headers: {Accept: "application/json"}});
      if (r.ok) { const j = await r.json(); if (j.success) return j.result; last = new Error("CKAN " + JSON.stringify(j.error || "").slice(0, 100)); }
      else last = new Error("HTTP " + r.status);
    } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 3000 * (i + 1)));
  }
  throw new Error("failed " + JSON.stringify(params).slice(0, 100) + ": " + (last && last.message));
}
// the whole dataset, page by page; the "fields" form is tried first (smaller answers), the plain form when the server rejects it
async function scan(id, fields, onRows) {
  let total = 0, useFields = !!fields;
  for (let off = 0; ; off += PAGE) {
    let r;
    try { r = await call(useFields ? {resource_id: id, limit: String(PAGE), offset: String(off), fields} : {resource_id: id, limit: String(PAGE), offset: String(off)}, useFields ? 2 : 5); }
    catch (e) { if (!useFields) throw e; useFields = false; off -= PAGE; continue; }
    if (!r.records.length) break;
    onRows(r.records); total += r.records.length;
    if (r.records.length < PAGE) break;
  }
  return total;
}
const val = v => v === null || v === undefined ? "" : typeof v === "string" ? v.trim() : v;
const key3 = r => `${r.tozeret_cd}|${r.degem_cd}|${r.shnat_yitzur}`;

// 1. the WLTP catalogue: every row, kept by maker code
const byMaker = new Map();   // cd -> rows (arrays in COLS order)
const ids = new Map();       // _id -> row (for the price join)
log("wltp: " + await scan(ID.wltp, COLS.join(","), rows => {
  for (const x of rows) {
    const cd = String(val(x.tozeret_cd)); if (!cd || empty(x.degem_cd)) continue;
    const row = COLS.map(c => val(x[c]));
    if (!byMaker.has(cd)) byMaker.set(cd, []);
    byMaker.get(cd).push(row); ids.set(Number(x._id), row);
  }
}) + " rows, makers " + byMaker.size);
function empty(v) { return v === null || v === undefined || String(v).trim() === ""; }

// 2. the price list: same catalogue with the list price and the importer; joined by _id when the two exports line up, else by maker|model|year
const I = Object.fromEntries(COLS.map((c, i) => [c, i])), MEHIR = COLS.length, YEVUAN = COLS.length + 1, ACT = COLS.length + 2, INACT = COLS.length + 3;
const priceRows = [];
let aligned = 0, checked = 0;
log("price: " + await scan(ID.price, "_id,tozeret_cd,degem_cd,shnat_yitzur,kinuy_mishari,mehir,shem_yevuan", rows => {
  for (const x of rows) {
    priceRows.push(x);
    const w = ids.get(Number(x._id)); if (!w) continue; checked++;
    if (String(w[I.tozeret_cd]) === String(val(x.tozeret_cd)) && String(w[I.degem_cd]) === String(val(x.degem_cd)) && String(w[I.shnat_yitzur]) === String(val(x.shnat_yitzur))) aligned++;
  }
}) + ` rows, _id aligned ${aligned}/${checked}`);
const byId = checked > 0 && aligned / checked > 0.98;
if (byId) { for (const x of priceRows) { const w = ids.get(Number(x._id)); if (w) { w[MEHIR] = val(x.mehir); w[YEVUAN] = val(x.shem_yevuan); } } }
else {
  const pk = new Map();   // key3 -> lowest price and its importer
  for (const x of priceRows) { const k = key3(x), m = Number(x.mehir) || 0; if (!(m > 0)) continue; const e = pk.get(k); if (!e || m < e[0]) pk.set(k, [m, val(x.shem_yevuan)]); }
  for (const rows of byMaker.values()) for (const w of rows) { const e = pk.get(`${w[I.tozeret_cd]}|${w[I.degem_cd]}|${w[I.shnat_yitzur]}`); if (e) { w[MEHIR] = e[0]; w[YEVUAN] = e[1]; } }
}
log("price join: " + (byId ? "by _id" : "by maker|model|year"));

// 3. counts: cars on the road / taken off, per maker|model|year (summed over the dataset's duplicates)
const cnt = new Map();
try {
  log("counts: " + await scan(ID.counts, "tozeret_cd,degem_cd,shnat_yitzur,mispar_rechavim_pailim,mispar_rechavim_le_pailim", rows => {
    for (const x of rows) { const k = key3(x), e = cnt.get(k) || [0, 0]; e[0] += Number(x.mispar_rechavim_pailim) || 0; e[1] += Number(x.mispar_rechavim_le_pailim) || 0; cnt.set(k, e); }
  }) + " rows");
  for (const rows of byMaker.values()) for (const w of rows) { const e = cnt.get(`${w[I.tozeret_cd]}|${w[I.degem_cd]}|${w[I.shnat_yitzur]}`); if (e) { w[ACT] = e[0]; w[INACT] = e[1]; } }
} catch (e) { log("counts FAILED (shards keep no counts): " + e.message); }

// 4. recalls by maker
const rec = new Map();
let recN = 0;
try {
  recN = await scan(ID.recalls, null, rows => { for (const x of rows) { const cd = String(val(x.TOZAR_CD)); if (!cd) continue; if (!rec.has(cd)) rec.set(cd, []); rec.get(cd).push(Object.fromEntries(RECALL_COLS.map(c => [c, val(x[c])]))); } });
  log("recalls: " + recN + " rows, makers " + rec.size);
} catch (e) { log("recalls FAILED: " + e.message); }
if (recN < 100) throw new Error("recall list implausibly small: " + recN);

// 5. write
const total = [...byMaker.values()].reduce((s, r) => s + r.length, 0);
if (total < 50000) throw new Error("catalogue implausibly small: " + total);
fs.rmSync(OUT, {recursive: true, force: true}); fs.mkdirSync(OUT + "/c", {recursive: true}); fs.mkdirSync(OUT + "/r", {recursive: true});
const u = new Date().toISOString().slice(0, 10), cols = COLS.concat(EXTRA), makers = {};
let bytes = 0, biggest = ["", 0];
for (const [cd, rows] of byMaker) {
  for (const w of rows) for (let i = 0; i < cols.length; i++) if (w[i] === undefined) w[i] = "";
  rows.sort((a, b) => (b[I.shnat_yitzur] || 0) - (a[I.shnat_yitzur] || 0) || String(a[I.kinuy_mishari]).localeCompare(String(b[I.kinuy_mishari])));
  const names = new Map(); for (const w of rows) names.set(String(w[I.tozeret_nm]), (names.get(String(w[I.tozeret_nm])) || 0) + 1);
  const n = [...names.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const models = [...new Set(rows.map(w => String(w[I.kinuy_mishari] || w[I.degem_nm] || "").trim().toUpperCase()).filter(Boolean))].sort();
  makers[cd] = {n, m: models, r: rows.length};
  const txt = JSON.stringify({u, cd, n, cols, rows});
  fs.writeFileSync(`${OUT}/c/${cd}.json`, txt); bytes += txt.length; if (txt.length > biggest[1]) biggest = [n, txt.length];
}
for (const [cd, rows] of rec) fs.writeFileSync(`${OUT}/r/${cd}.json`, JSON.stringify({u, rows}));
fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify({u, cols, rows: total, recalls: recN, makers}));
log(`written: ${byMaker.size} maker shards (${Math.round(bytes / 1e6 * 10) / 10} MB, biggest ${biggest[0]} ${Math.round(biggest[1] / 1e3)} KB), ${rec.size} recall files, meta ${Math.round(fs.statSync(OUT + "/meta.json").size / 1e3)} KB`);
