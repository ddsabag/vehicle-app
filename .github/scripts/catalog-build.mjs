// Builds the static model catalogue the comparison reads instead of querying the ministry live (0 requests to data.gov.il
// when a model is picked or added). Published on the catalog-data branch (force-pushed, one commit) by catalog.yml.
//   meta.json          {u, makers: {cd: {n: maker name, m: [model names as the register spells them], r: rows, y: [[first, last production year] per name in m]}}, rec: [maker codes with recalls],
//                      recHz: how far the ministry's per-car list of unfixed cars reaches {id, d, from, ids, n, max: newest RECALL_ID of the recall list} (recall-percar.mjs)}
//   c/<cd>.json        maker index {u, cd, n, eretz, tozar, cols, imp: {n: brand importer, c: its cars on the road, share}, models: {name: [file, rows, firstYear, lastYear]},
//                      degems: {"P|degem_cd": file, "M|degem_cd": file, degem_cd: file}} (the ministry numbers private and commercial models apart)
//   c/<cd>/<file>.json {u, rows: [[...]]}  the catalogue lines of one model name (file = stable hash of the name, so a cached index never points at the wrong file): the WLTP fields the app shows (the maker columns hoisted
//                      into the index), plus the price-list columns (mehir, shem_yevuan) and the counts (mispar_rechavim_pailim / le_pailim)
//   r/<cd>.json        {u, rows: [...], x: [...], l: {RECALL_ID: {"MODEL|year": cars}}}  rows: every recall of that maker's brand (joined by brand name: the recall list's
//                      TOZAR_CD is its own numbering), the fields the app reads; x: rows only the app from 1.34 on reads (rows stays what older versions read): the sister
//                      brands' recalls (BRANDS_MORE), and the rows of a recall the per-car list holds for the maker's cars that the others lack (from another brand, or
//                      written from the per-car list when the recall list lacks it); l: the models and years the ministry's per-car list of unfixed cars holds for each
//                      recall (recall-percar.mjs)
// Runs on a GitHub runner (data.gov.il blocks other networks). OUT (default out) is the output directory.
import fs from "node:fs";
import crypto from "node:crypto";
import {perCarRecalls} from "./recall-percar.mjs";
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
// The recall list numbers makers its own way (TOZAR_CD 1 = TOYOTA), unrelated to the register's tozeret_cd (413 = טויוטה יפן),
// so the rows are grouped by the brand name in TOZAR_TEUR and joined to the register through the Hebrew brand (tozar) below.
const recByBrand = new Map();
let recN = 0;
try {
  recN = await scan(ID.recalls, null, rows => { for (const x of rows) { const b = String(val(x.TOZAR_TEUR) || "").trim().toUpperCase(); if (!b) continue; if (!recByBrand.has(b)) recByBrand.set(b, []); recByBrand.get(b).push(Object.fromEntries(RECALL_COLS.map(c => [c, val(x[c])]))); } });
  log("recalls: " + recN + " rows, brands " + recByBrand.size);
} catch (e) { log("recalls FAILED: " + e.message); }
if (recN < 100) throw new Error("recall list implausibly small: " + recN);
// the per-car list of unfixed cars (recall-percar.mjs): how far it reaches, and the models and years each recall holds. Without it the app falls back to
// the horizon it was built with and to the recall list's free text alone.
let pc = null, recHz = null;
try {
  pc = await perCarRecalls(scan, log);
  const {id, d, from, ids, n} = pc.hz;
  recHz = {id, d, from, ids, n, max: [...recByBrand.values()].flat().reduce((m, r) => Math.max(m, Number(r.RECALL_ID) || 0), 0)};
  log(`per-car list: ${pc.found} of ${pc.plates} plates in the registers; newest recall ${id} (${d}), ${ids.length} of its recalls from ${from} on; recall list to ${recHz.max}`);
} catch (e) { log("per-car list FAILED: " + e.message); pc = null; }
// register brand (tozar, Hebrew) -> recall brands (TOZAR_TEUR); brands with no entry have no recalls in the list (checked 17.10.2026 against all 84 recall brands)
const BRANDS = {"טויוטה": ["TOYOTA"], "פורד": ["FORD"], "ב מ וו": ["BMW"], "ג'יפ": ["JEEP"], "שברולט": ["CHEVROLET"], "הונדה": ["HONDA"], "מרצדס": ["MERCEDES BENZ"], "מרצדס בנץ": ["MERCEDES BENZ"],
  "סובארו": ["SUBARU"], "יונדאי": ["HYUNDAI"], "פולקסווגן": ["VOLKSWAGEN"], "אאודי": ["AUDI"], "אודי": ["AUDI"], "מזדה": ["MAZDA"], "קרייזלר": ["CHRYSLER"], "דיימלר קרייזלר": ["CHRYSLER", "MERCEDES BENZ"], "דימלרקריזלר": ["CHRYSLER", "MERCEDES BENZ"],
  "ניסאן": ["NISSAN"], "מיצובישי": ["MITSUBISHI"], "סיטרואן": ["CITROEN"], "קאדילאק": ["CADILLAC"], "קיה": ["KIA"], "וולבו": ["VOLVO"], "פיג'ו": ["PEUGEOT"], "דודג'": ["DODGE", "RAM"], "לקסוס": ["LEXUS"], "אופל": ["OPEL"],
  "לנדרובר": ["LAND ROVER"], "רובר": ["LAND ROVER", "ROVER"], "סיאט": ["SEAT"], "קופרה": ["SEAT"], "רנו": ["RENAULT"], "סקודה": ["SKODA"], "ג'י.אמ.סי": ["GMC"], ".ג'י.אמ": ["GMC"], "ביואיק": ["BUICK"], "מאן": ["MAN"], "יגואר": ["JAGUAR"],
  "די אס": ["DS AUTOMOBILES"], "אלפא רומיאו": ["ALFA ROMEO"], "פיאט": ["FIAT", "FIAT PROFESSIONAL"], "טסלה": ["TESLA"], "איסוזו": ["ISUZU", "ISUZU TRUCKS"], "פורשה": ["PORSCHE"], "סוזוקי": ["SUZUKI"], "מרוטי סוזוקי": ["SUZUKI"],
  "דאצ'יה": ["DACIA"], "דאציה": ["DACIA"], "האמר": ["HUMMER"], "האמר ג.מ": ["HUMMER"], "פונטיאק": ["PONTIAC"], "פרארי": ["FERRARI"], "מזארטי": ["MASERATI"], "לינקולן": ["LINCOLN"], "איווקו": ["IVECO"], "סמארט": ["SMART"], "מ.ג": ["MG"],
  "סאנגיונג": ["SSANGYONG"], "קיי גי מוביליט": ["SSANGYONG"], "מיני": ["MINI"], "בנטלי": ["BENTLEY"], "גרייט וול": ["GREAT WALL MOTORS"], "ג'ילי": ["GEELY"], "ג'אקו": ["JAECOO"], "סאאב": ["SAAB"], "דייהטסו": ["DAIHATSU"], "אינפיניטי": ["INFINITI"]};
// A brand also reads the rows its group files under a sister brand: importers file Jeep recalls under CHRYSLER, Lexus under TOYOTA, MINI under BMW, Dacia under
// RENAULT, and the register files Jeeps under קרייזלר and Lexus under טויוטה (until 19.10.2026 such cars showed no model recall history at all).
// The app's matcher keeps only the rows that name the car's model; where two sister brands share a name (Dodge and Jeep AVENGER) it reads the brand written in
// front of the model. Not joined on purpose: שברולט with GMC, ג'יפ with DODGE (no shared models in Israel, and the AVENGER clash).
// These rows go to the file's x, which only the app from 1.34 on reads: older versions (and the model pages) read rows alone, and their matcher takes a
// sister brand's GRAND CHEROKEE for a CHEROKEE, so rows stays what it was before.
const BRANDS_MORE = {"טויוטה": ["LEXUS"], "פורד": ["LINCOLN"], "ב מ וו": ["MINI"], "ג'יפ": ["CHRYSLER"], "קרייזלר": ["JEEP", "DODGE"], "ניסאן": ["INFINITI"], "קאדילאק": ["GMC"],
  "דודג'": ["CHRYSLER"], "לקסוס": ["TOYOTA"], "רובר": ["JAGUAR"], "רנו": ["DACIA"], "סקודה": ["VOLKSWAGEN"], "ג'י.אמ.סי": ["HUMMER", "CHEVROLET"], ".ג'י.אמ": ["CHEVROLET"],
  "גמס": ["GMC", "HUMMER"], "ביואיק": ["GMC"], "פיאט": ["JEEP"], "לינקולן": ["FORD"], "סמארט": ["MERCEDES BENZ"], "מיני": ["BMW"], "פיאג'ו": ["PEUGEOT"], "טי אי סי": ["TOYOTA"]};

// 5. write
const total = [...byMaker.values()].reduce((s, r) => s + r.length, 0);
if (total < 50000) throw new Error("catalogue implausibly small: " + total);
for (const d of ["c", "r"]) fs.rmSync(`${OUT}/${d}`, {recursive: true, force: true});
fs.mkdirSync(OUT + "/c", {recursive: true}); fs.mkdirSync(OUT + "/r", {recursive: true});
const u = new Date().toISOString().slice(0, 10);
const HOIST = ["tozeret_cd", "tozeret_nm", "tozeret_eretz_nm", "tozar"], keepIdx = COLS.map((c, i) => HOIST.includes(c) ? -1 : i).filter(i => i >= 0).concat(EXTRA.map((_, i) => COLS.length + i));
const cols = keepIdx.map(i => COLS.concat(EXTRA)[i]), makers = {};
let bytes = 0, files = 0, biggest = ["", 0];
const brandOf = new Map();   // register maker code -> Hebrew brand (tozar)
const top = (rows, i) => { const m = new Map(); for (const w of rows) m.set(String(w[i]), (m.get(String(w[i])) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]; };
// the brand of a maker whose WLTP rows mostly or all leave tozar empty (לקסוס ארה"ב and פורד ד. אפריקה on 19.10.2026): the brand its rows that have one name,
// else the brand its name starts with, so the maker keeps its recall file
const nameBrands = Object.keys({...BRANDS, ...BRANDS_MORE}).sort((a, b) => b.length - a.length), noBrand = [];
const brandOfMaker = (rows, n) => { const named = rows.filter(w => String(w[I.tozar]).trim()); if (named.length) return top(named, I.tozar);
  const b = nameBrands.find(k => n === k || n.startsWith(k + " ")) || ""; noBrand.push(`${n}${b ? " -> " + b : ""}`); return b; };
for (const [cd, rows] of byMaker) {
  for (const w of rows) for (let i = 0; i < COLS.length + EXTRA.length; i++) if (w[i] === undefined) w[i] = "";
  rows.sort((a, b) => (b[I.shnat_yitzur] || 0) - (a[I.shnat_yitzur] || 0) || String(a[I.kinuy_mishari]).localeCompare(String(b[I.kinuy_mishari])));
  const n = top(rows, I.tozeret_nm), eretz = top(rows, I.tozeret_eretz_nm), tozar = brandOfMaker(rows, String(n).trim());
  const byModel = new Map();
  for (const w of rows) { const m = String(w[I.kinuy_mishari] || w[I.degem_nm] || "").trim().toUpperCase() || "-"; if (!byModel.has(m)) byModel.set(m, []); byModel.get(m).push(w); }
  fs.mkdirSync(`${OUT}/c/${cd}`, {recursive: true});
  const models = {}, degems = {};
  const impName = x => String(x || "").replace(/\s*בע['"׳״]{0,2}מ\.?\s*$|\s*בעמ\s*$/, "").replace(/\s+/g, " ").trim();
  // a code's count of cars (per maker|code|year, step 3) sits on each of its rows: counted once, not once per trim row
  const onRoad = new Map(), counted = new Set();
  for (const w of rows) { const nm = impName(w[YEVUAN]), c = Number(w[ACT]) || 0, k = `${w[I.degem_cd]}|${w[I.shnat_yitzur]}`; if (!nm || !(c > 0) || counted.has(k)) continue; counted.add(k); onRoad.set(nm, (onRoad.get(nm) || 0) + c); }
  const roadTotal = [...onRoad.values()].reduce((a, b) => a + b, 0), topImp = [...onRoad.entries()].sort((a, b) => b[1] - a[1])[0];
  const imp = topImp && topImp[1] >= 50 ? {n: topImp[0], c: topImp[1], share: Math.round(topImp[1] / roadTotal * 100)} : null;
  for (const [m, list] of [...byModel.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const f = crypto.createHash("sha1").update(cd + "|" + m).digest("hex").slice(0, 8);   // stable across builds: a model keeps its file name
    const ys = list.map(w => Number(w[I.shnat_yitzur]) || 0).filter(Boolean);
    models[m] = [f, list.length, ys.length ? Math.min(...ys) : 0, ys.length ? Math.max(...ys) : 0];
    for (const w of list) { const dg = String(w[I.degem_cd]), sd = String(w[I.sug_degem] || "").trim().toUpperCase(); if (sd) degems[sd + "|" + dg] = f; if (!degems[dg] || sd === "P") degems[dg] = f; }
    const txt = JSON.stringify({u, rows: list.map(w => keepIdx.map(i => w[i]))});
    fs.writeFileSync(`${OUT}/c/${cd}/${f}.json`, txt); bytes += txt.length; files++; if (txt.length > biggest[1]) biggest = [n + " " + m, txt.length];
  }
  makers[cd] = {n, m: Object.keys(models), r: rows.length, y: Object.values(models).map(x => [x[2], x[3]])};   // y: first and last production year of each name in m (the recall matcher reads "AVENSIS,VERSO" as one model or two by them)
  brandOf.set(cd, String(tozar || "").trim());
  const idx = JSON.stringify({u, cd: Number(cd), n, eretz, tozar, cols, imp, models, degems});
  fs.writeFileSync(`${OUT}/c/${cd}.json`, idx); bytes += idx.length;
}
if (noBrand.length) log("makers whose rows name no brand (brand taken from the maker name): " + noBrand.join(", "));
// one recall file per register maker code, holding every recall of that maker's brand (the app matches the model name itself), and the per-car list's
// models and years per recall; a recall that list holds for the maker's cars and the brand's rows lack comes from another brand's rows, or is written
// from the per-car list's own text when the recall list does not have it (in x, with the sister brands' rows)
const rec = new Map(), unmapped = new Map(), recById = new Map();
for (const rows of recByBrand.values()) for (const r of rows) { const k = Number(r.RECALL_ID); if (!recById.has(k)) recById.set(k, []); recById.get(k).push(r); }
const fromList = id => { const e = pc.info.get(id); return Object.fromEntries(RECALL_COLS.map(c => [c, c === "RECALL_ID" ? id : c === "SHNAT_RECALL" ? Number((e.d || "").slice(0, 4)) || "" : c === "TAARICH_PTICHA" ? e.d : e[c] || ""])); };
let added = 0, written = 0;
for (const [cd, tz] of brandOf) {
  const rows = (BRANDS[tz] || []).flatMap(b => recByBrand.get(b) || []);
  let x = (BRANDS_MORE[tz] || []).flatMap(b => recByBrand.get(b) || []);
  const l = pc && pc.links.get(String(cd));
  if (l) {
    const have = new Set(rows.concat(x).map(r => Number(r.RECALL_ID)));
    for (const id of l.keys()) if (!have.has(id)) { const more = recById.get(id); x = x.concat(more || [fromList(id)]); have.add(id); if (more) added++; else written++; }
  }
  if (rows.length || x.length) rec.set(cd, {rows, x, l: l ? Object.fromEntries([...l.entries()].sort((a, b) => a[0] - b[0]).map(([id, m]) => [id, Object.fromEntries(m)])) : undefined});
  else if (!BRANDS[tz] && !BRANDS_MORE[tz]) unmapped.set(tz, (unmapped.get(tz) || 0) + 1);
}
if (pc) log(`per-car list links: ${[...rec.values()].filter(x => x.l).length} makers; recalls added from another brand's rows ${added}, written from the per-car list ${written}`);
log("register brands with no recall map entry (fine when the brand has no recalls): " + [...unmapped.keys()].join(", "));
const mappedBrands = new Set([...Object.values(BRANDS), ...Object.values(BRANDS_MORE)].flat()), unusedBrands = [...recByBrand.keys()].filter(b => !mappedBrands.has(b));
log("recall brands in the list with no register brand (motorcycles, trucks, or a map entry to add): " + unusedBrands.join(", "));
for (const [cd, {rows, x, l}] of rec) fs.writeFileSync(`${OUT}/r/${cd}.json`, JSON.stringify({u, rows, ...(x.length ? {x} : {}), ...(l ? {l} : {})}));
fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify({u, rows: total, recalls: recN, makers, rec: [...rec.keys()], ...(recHz ? {recHz} : {})}));
log(`written: ${byMaker.size} makers, ${files} model files (${Math.round(bytes / 1e6 * 10) / 10} MB, biggest ${biggest[0]} ${Math.round(biggest[1] / 1e3)} KB), ${rec.size} recall files for ${[...new Set([...rec.keys()].map(cd => brandOf.get(cd)))].length} brands, meta ${Math.round(fs.statSync(OUT + "/meta.json").size / 1e3)} KB`);
