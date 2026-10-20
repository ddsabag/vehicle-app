// One-off (probe-go branch, not for main), 20.10, follow-up to safety-probe.mjs: in the WLTP model rows, how the safety level relates to
// the points score (nikud_betihut), the airbags and the main systems, and what an empty level is. Model rows only, no plates.
const API = "https://data.gov.il/api/3/action/datastore_search", WLTP = "142afde2-6228-49f9-8a29-9b6c3a0cbe40", PAGE = 30000;
async function call(params, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(API + "?" + new URLSearchParams(params), { signal: AbortSignal.timeout(120000) }); const j = await r.json(); if (j.success) return j.result; } catch {}
    await new Promise(r => setTimeout(r, 4000 * (i + 1)));
  }
  throw new Error("failed");
}
const F = ["tozeret_nm", "kinuy_mishari", "degem_nm", "ramat_gimur", "shnat_yitzur", "sug_degem", "ramat_eivzur_betihuty", "nikud_betihut", "mispar_kariot_avir", "kariot_avir_source",
  "maarechet_ezer_labalam_ind", "bakarat_stiya_menativ_ind", "bakarat_stiya_activ_s", "bakarat_shyut_adaptivit_ind", "zihuy_beshetah_nistar_ind", "hitnagshut_cad_shetah_met",
  "blima_otomatit_nesia_leahor", "shlita_automatit_beorot_gvohim_ind", "zihuy_holchey_regel_ind", "blimat_hirum_lifnei_holhei_regel_ofanaim", "bakarat_mehirut_isa"];
const rows = [];
for (let off = 0; ; off += PAGE) { const r = await call({ resource_id: WLTP, limit: String(PAGE), offset: String(off), fields: F.join(",") }); rows.push(...r.records); if (r.records.length < PAGE) break; }
console.log("rows", rows.length);
const s = v => String(v ?? "").trim(), yes = v => s(v) === "1", N = v => s(v) === "" ? null : Number(s(v));
const L = r => s(r.ramat_eivzur_betihuty) || "-";
// 1. level vs points, airbags and systems (model years 2013+)
const by = {};
for (const r of rows) { if (Number(r.shnat_yitzur) < 2013) continue; const k = L(r) + " " + (s(r.sug_degem) || "-"); const o = by[k] ||= { n: 0, pts: [], ptsEmpty: 0, air: {}, aeb: 0, lka: 0, acc: 0, bsd: 0, abs: 0, rev: 0, hb: 0 };
  o.n++; const p = N(r.nikud_betihut); if (p === null) o.ptsEmpty++; else o.pts.push(p); const a = N(r.mispar_kariot_avir); const ab = a === null ? "?" : a < 4 ? "<4" : a < 6 ? String(a) : "6+"; o.air[ab] = (o.air[ab] || 0) + 1;
  if (yes(r.maarechet_ezer_labalam_ind)) o.aeb++; if (yes(r.bakarat_stiya_menativ_ind) || yes(r.bakarat_stiya_activ_s)) o.lka++; if (yes(r.bakarat_shyut_adaptivit_ind)) o.acc++; if (yes(r.zihuy_beshetah_nistar_ind)) o.bsd++;
  if (yes(r.hitnagshut_cad_shetah_met)) o.abs++; if (yes(r.blima_otomatit_nesia_leahor)) o.rev++; if (yes(r.shlita_automatit_beorot_gvohim_ind)) o.hb++; }
const pc = (a, n) => Math.round(a / n * 100) + "%";
console.log("\n== WLTP 2013+: level and type -> rows, points min/median/max (empty), airbags, share with AEB / lane / ACC / blind spot / active blind spot / reverse braking / auto high beams");
for (const k of Object.keys(by).sort()) { const o = by[k], p = o.pts.sort((a, b) => a - b); console.log(k.padEnd(5), String(o.n).padStart(6), "pts", p.length ? p[0] + "/" + p[p.length >> 1] + "/" + p[p.length - 1] : "-", "(empty " + o.ptsEmpty + ")", "air", JSON.stringify(o.air), "AEB", pc(o.aeb, o.n), "lane", pc(o.lka, o.n), "ACC", pc(o.acc, o.n), "BSD", pc(o.bsd, o.n), "aBSD", pc(o.abs, o.n), "rev", pc(o.rev, o.n), "HB", pc(o.hb, o.n)); }
// 2. points -> level: every (points, level) pair seen
const pl = {}; for (const r of rows) { const p = N(r.nikud_betihut); if (p === null) continue; const k = p + " -> " + L(r); pl[k] = (pl[k] || 0) + 1; }
console.log("\n== points -> level (rows)"); console.log(Object.entries(pl).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]) || a[0].localeCompare(b[0])).map(([k, n]) => k + ": " + n).join(" | "));
// 3. named models, by year
const want = [["קיה", "SPORTAGE"], ["טויוטה", "COROLLA HSD"], ["יונדאי", "IONIQ HYBRID"], ["קיה", "PICANTO"], ["מזדה", "MAZDA 3"], ["סקודה", "OCTAVIA"], ["טויוטה", "C-HR"], ["יונדאי", "TUCSON"]];
console.log("\n== named models: year | type | trim | level | points | airbags (source) | AEB lane ACC BSD aBSD rev HB");
for (const [mk, md] of want) { const rs = rows.filter(r => s(r.tozeret_nm).startsWith(mk) && s(r.kinuy_mishari).toUpperCase() === md && Number(r.shnat_yitzur) >= 2015).sort((a, b) => Number(a.shnat_yitzur) - Number(b.shnat_yitzur));
  const seen = new Set(); for (const r of rs) { const line = [r.shnat_yitzur, s(r.sug_degem), s(r.ramat_gimur).slice(0, 18), L(r), s(r.nikud_betihut) || "-", (s(r.mispar_kariot_avir) || "-") + "(" + s(r.kariot_avir_source) + ")", [r.maarechet_ezer_labalam_ind, r.bakarat_stiya_menativ_ind || r.bakarat_stiya_activ_s, r.bakarat_shyut_adaptivit_ind, r.zihuy_beshetah_nistar_ind, r.hitnagshut_cad_shetah_met, r.blima_otomatit_nesia_leahor, r.shlita_automatit_beorot_gvohim_ind].map(x => s(x) || ".").join(" ")].join(" | ");
    const key = r.shnat_yitzur + L(r) + s(r.nikud_betihut); if (seen.has(key)) continue; seen.add(key); console.log(mk, md, "|", line); } }
// 4. empty level in recent model years: points and airbags
const em = {}; for (const r of rows) { const y = Number(r.shnat_yitzur); if (y < 2018 || L(r) !== "-") continue; const a = N(r.mispar_kariot_avir), t = s(r.sug_degem) || "-"; const k = t + " airbags " + (a === null ? "?" : a < 4 ? "<4" : a < 6 ? String(a) : "6+") + " points " + (N(r.nikud_betihut) === null ? "empty" : N(r.nikud_betihut) === 0 ? "0" : ">0"); em[k] = (em[k] || 0) + 1; }
console.log("\n== WLTP 2018+, empty level: type, airbags, points"); for (const [k, n] of Object.entries(em).sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(6), k);
const emM = {}; for (const r of rows) { const y = Number(r.shnat_yitzur); if (y < 2020 || L(r) !== "-") continue; const k = s(r.tozeret_nm).split(" ")[0] + " " + s(r.kinuy_mishari) + " (" + (s(r.mispar_kariot_avir) || "?") + " airbags)"; emM[k] = (emM[k] || 0) + 1; }
console.log("\n== WLTP 2020+, empty level, most rows:", Object.entries(emM).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => k + " " + n).join(", "));
