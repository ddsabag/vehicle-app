// One-off (probe-go branch, not for main), 20.10: the "רמת בטיחות נמוכה" insight (index.html: the register's ramat_eivzur_betihuty 1-2)
// against the data: the level by production year in the active register, level 0, how consistent one model-year is, the register vs
// the WLTP model rows (the safety card shows the register first, then the model row), and the level vs the systems the card lists.
// Prints totals and model names only, never a plate.
const API = "https://data.gov.il/api/3/action/datastore_search";
const ID = { active: "053cea08-09bc-40ec-8f7a-156f0677aff3", wltp: "142afde2-6228-49f9-8a29-9b6c3a0cbe40" };
const PAGE = 30000, T0 = Date.now();
const log = m => console.log(`[${Math.round((Date.now() - T0) / 1000)}s] ${m}`);
async function call(params, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(API + "?" + new URLSearchParams(params), { signal: AbortSignal.timeout(120000) }); const j = await r.json(); if (j.success) return j.result; } catch {}
    await new Promise(r => setTimeout(r, 4000 * (i + 1)));
  }
  throw new Error("failed " + JSON.stringify(params).slice(0, 120));
}
async function scan(id, fields, onRows) {
  let total = 0, all = null;
  for (let off = 0, empty = 0; ; off += PAGE) {
    const r = await call({ resource_id: id, limit: String(PAGE), offset: String(off), fields });
    if (!off && !r.records.length && empty++ < 2) { await new Promise(s => setTimeout(s, 20000)); off -= PAGE; continue; }
    if (!r.records.length) break;
    if (all === null) all = r.total;
    onRows(r.records); total += r.records.length;
    if (r.records.length < PAGE) break;
  }
  if (all && total < all * 0.995) throw new Error(`${id}: read ${total} of ${all}`);
  return total;
}
const SYS = ["abs_ind", "bakarat_yatzivut_ind", "maarechet_ezer_labalam_ind", "bakarat_stiya_menativ_ind", "bakarat_stiya_activ_s", "nitur_merhak_milfanim_ind", "zihuy_beshetah_nistar_ind",
  "bakarat_shyut_adaptivit_ind", "zihuy_holchey_regel_ind", "blimat_hirum_lifnei_holhei_regel_ofanaim", "zihuy_rechev_do_galgali", "matzlemat_reverse_ind", "blima_otomatit_nesia_leahor",
  "hayshaney_lahatz_avir_batzmigim_ind", "hayshaney_hagorot_ind", "shlita_automatit_beorot_gvohim_ind", "teura_automatit_benesiya_kadima_ind", "zihuy_tamrurey_tnua_ind",
  "zihuy_matzav_hitkarvut_mesukenet_ind", "bakarat_mehirut_isa", "hitnagshut_cad_shetah_met"];
const yes = v => { const s = String(v ?? "").trim(); return s === "1" || s === "כן" || s.toLowerCase() === "true"; };
const L = v => { const s = String(v ?? "").trim(); return s === "" ? "-" : String(Number(s)) === s || /^\d+$/.test(s) ? String(Number(s)) : "?" + s; };
const yb = y => { y = Number(y); return !y ? "?" : y < 2000 ? "<2000" : String(y); };
const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const norm = s => String(s ?? "").trim().toUpperCase();

// 0. the WLTP table's columns (is there a points score beside the level?)
{ const r = await call({ resource_id: ID.wltp, limit: "1" }); log("WLTP columns about safety: " + r.fields.map(f => f.id).filter(f => /betih|kariot|nikud|airbag|safe/i.test(f)).join(", ") + " | total rows " + r.total); }

// 1. WLTP model rows: level per model-year (+ trim), systems listed, airbags
const WL = new Map(), WLG = new Map();   // key cd|degem|year|type -> Set(levels); + trim -> level
const wYear = {}, wSys = {}, wAir0 = {}, wByType = {};
log("wltp rows: " + await scan(ID.wltp, ["tozeret_cd", "degem_cd", "shnat_yitzur", "sug_degem", "ramat_gimur", "kinuy_mishari", "ramat_eivzur_betihuty", "mispar_kariot_avir", ...SYS].join(","), rows => {
  for (const r of rows) {
    const k = [r.tozeret_cd, r.degem_cd, r.shnat_yitzur, norm(r.sug_degem)].join("|"), l = L(r.ramat_eivzur_betihuty), y = yb(r.shnat_yitzur);
    if (!WL.has(k)) WL.set(k, new Set()); WL.get(k).add(l); WLG.set(k + "|" + norm(r.ramat_gimur), l);
    (wYear[y] ||= {}); inc(wYear[y], l);
    (wByType[norm(r.sug_degem) || "-"] ||= {}); inc(wByType[norm(r.sug_degem) || "-"], l);
    const n = SYS.filter(f => yes(r[f])).length; (wSys[y + " L" + l] ||= [0, 0]); wSys[y + " L" + l][0]++; wSys[y + " L" + l][1] += n;
    if (l === "0") inc(wAir0, y + " airbags=" + String(r.mispar_kariot_avir ?? "").trim());
  }
}));
const LV = ["-", "0", "1", "2", "3", "4", "5", "6", "7", "8"];
const row = (o, keys) => keys.map(k => String(o[k] || 0).padStart(6)).join(" ");
console.log("\n== WLTP rows by production year x level (" + LV.join(" ") + ")");
for (const y of Object.keys(wYear).sort()) console.log(y.padEnd(6), row(wYear[y], LV), Object.keys(wYear[y]).filter(k => !LV.includes(k)).map(k => k + ":" + wYear[y][k]).join(" "));
console.log("\n== WLTP rows by model type x level"); for (const t of Object.keys(wByType)) console.log(t.padEnd(6), row(wByType[t], LV));
console.log("\n== WLTP: average number of listed systems (of " + SYS.length + ") per year and level");
for (const y of Object.keys(wYear).sort()) if (Number(y) >= 2012) console.log(y, LV.filter(l => wSys[y + " L" + l]).map(l => "L" + l + "=" + (wSys[y + " L" + l][1] / wSys[y + " L" + l][0]).toFixed(1) + " (" + wSys[y + " L" + l][0] + ")").join("  "));
console.log("\n== WLTP level 0 rows by year and airbags"); for (const [k, n] of Object.entries(wAir0).sort()) console.log(k, n);

// 2. the active register
const rYear = {}, rType = {}, G = new Map(), cmp = {}, ex = {};
log("active rows: " + await scan(ID.active, "tozeret_cd,degem_cd,shnat_yitzur,sug_degem,ramat_gimur,kinuy_mishari,tozeret_nm,ramat_eivzur_betihuty", rows => {
  for (const r of rows) {
    const l = L(r.ramat_eivzur_betihuty), y = yb(r.shnat_yitzur), t = norm(r.sug_degem) || "-", k = [r.tozeret_cd, r.degem_cd, r.shnat_yitzur, t].join("|");
    (rYear[y] ||= {}); inc(rYear[y], l); (rType[t] ||= {}); inc(rType[t], l);
    let g = G.get(k); if (!g) { g = { n: 0, l: {}, name: norm(r.tozeret_nm).split(" ")[0] + " " + norm(r.kinuy_mishari) + " " + r.shnat_yitzur }; G.set(k, g); } g.n++; inc(g.l, l);
    // what the page does: the insight reads the register only; the safety card shows the register, else the model row
    const set = WL.get(k), wl = WLG.get(k + "|" + norm(r.ramat_gimur)) ?? (set && set.size === 1 ? [...set][0] : set ? "multi" : "none");
    const low = x => x === "1" || x === "2", pos = x => /^[1-8]$/.test(x);
    const c = low(l) ? (wl === l ? "alert, model row same" : pos(wl) && !low(wl) ? "alert, model row says 3-8" : low(wl) ? "alert, model row other 1-2" : "alert, model row " + wl)
      : (l === "-" || l === "0") ? (low(wl) ? "no alert (register " + l + "), card shows model row 1-2" : pos(wl) ? "no alert (register " + l + "), model row 3-8" : "no alert (register " + l + "), model row " + wl)
      : low(wl) ? "no alert (register 3-8), model row 1-2" : "no alert (register 3-8), model row " + (pos(wl) ? "3-8" : wl);
    inc(cmp, c); (ex[c] ||= {}); inc(ex[c], g.name);
  }
}));
console.log("\n== active register: cars by production year x level (" + LV.join(" ") + ")  | alert share");
let tot = 0, al = 0;
for (const y of Object.keys(rYear).sort()) { const o = rYear[y], n = Object.values(o).reduce((a, b) => a + b, 0), a = (o["1"] || 0) + (o["2"] || 0); tot += n; al += a; console.log(y.padEnd(6), row(o, LV), "|", (a / n * 100).toFixed(1) + "%", Object.keys(o).filter(k => !LV.includes(k)).map(k => k + ":" + o[k]).join(" ")); }
console.log("all cars", tot, "| with the alert (level 1-2):", al, (al / tot * 100).toFixed(1) + "%");
console.log("\n== active register by model type x level"); for (const t of Object.keys(rType)) console.log(t.padEnd(6), row(rType[t], LV));
// one model-year: does every car carry the same level?
let gN = 0, gMixed = 0, carsOff = 0, gMixedLow = 0; const mixedEx = [];
for (const [k, g] of G) { const ls = Object.entries(g.l).filter(([l]) => l !== "-"); if (g.n < 5 || !ls.length) continue; gN++; if (ls.length > 1) { gMixed++; const top = Math.max(...ls.map(x => x[1])); carsOff += g.n - top - (g.l["-"] || 0); if (ls.some(([l]) => l === "1" || l === "2") && ls.some(([l]) => /^[3-8]$/.test(l))) { gMixedLow++; mixedEx.push([g.n, g.name, JSON.stringify(g.l)]); } } }
console.log(`\n== model-years with 5+ cars and a level: ${gN}; with more than one level: ${gMixed}; cars off their model-year's usual level: ${carsOff}; mixed between 1-2 and 3-8: ${gMixedLow}`);
for (const e of mixedEx.sort((a, b) => b[0] - a[0]).slice(0, 15)) console.log("  ", e.join(" | "));
console.log("\n== what each car's page does, register vs the WLTP row of its model-year (trim when it matches)");
for (const [c, n] of Object.entries(cmp).sort((a, b) => b[1] - a[1])) { console.log(String(n).padStart(8), c); console.log("          e.g.", Object.entries(ex[c]).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([m, n]) => m + " (" + n + ")").join(", ")); }
log("done");
