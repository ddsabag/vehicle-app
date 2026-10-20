// One-off (probe-go branch, not for main), 20.10: measures every data question the reliability review left open.
// Prints totals, model names and dataset values only, never a plate.
//  M  model list (WLTP) and price list: rows per model code, names per code, towing 0/0 by year, plug-in CO2, zeros, price alignment
//  R  recall lists: the per-car list against the model list (which recalls it covers), duplicates
//  G  disability tags: several rows per plate, types, dates
//  C  cont (towing hook) and tech (km, first owner) per plate
//  A  active register: towing as the app decides it against the hook, own trim row or not, new cars and km
//  X  every register's plates: overlaps (a plate in more than one register) and duplicates inside a register
const API = "https://data.gov.il/api/3/action/";
const ID = { active: "053cea08-09bc-40ec-8f7a-156f0677aff3", moto: "bf9df4e2-d90d-4c0a-a400-19e15af8e95f", heavy: "cd3acc5c-03c3-4c89-9c54-d40f93c0d790", public: "cf29862d-ca25-4691-84f6-1be60dcb4a1e", import: "03adc637-b6fe-402b-9937-7c3d3afc9140", inactive: "f6efe89a-fb3d-43a4-bb61-9bf12a9b9099", inactive2: "6f6acd03-f351-4a8f-8ecf-df792f4f573a", cancel: "851ecab1-0622-4dbe-a6c7-f950cf82abf9", cancel2010: "4e6b9724-4c1e-43f0-909a-154d4cc4e046", cancel2000: "ec8cbc34-72e1-4b69-9c48-22821ba0bd6c", cont: "0866573c-40cd-4ca8-91d2-9dd2d7a492e5", tech: "56063a99-8a3e-4ff4-912e-5966c0279bad", recall: "36bf1404-0be4-49d2-82dc-2f1ead4a8b93", tag: "c8b9f9c8-4612-4068-934f-d4acd2e3c06e", wltp: "142afde2-6228-49f9-8a29-9b6c3a0cbe40", price: "39f455bf-6db0-4926-859d-017f34eacbcb", recalls: "2c33523f-87aa-44ec-a736-edbb0a82975e" };
const MAINS = ["active", "moto", "heavy", "public", "import", "inactive", "inactive2", "cancel", "cancel2010", "cancel2000"];   // PLATE_SETS order
const T0 = Date.now(), log = m => console.log(`[${Math.round((Date.now() - T0) / 1000)}s] ${m}`);
async function call(act, params, tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(API + act + "?" + new URLSearchParams(params), { headers: { Accept: "application/json", "User-Agent": "luchit-dq-probe/1.0" }, signal: AbortSignal.timeout(180000) }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { throw new Error(`HTTP ${r.status} not JSON: ${t.slice(0, 60).replace(/\s+/g, " ")}`); } if (j.success) return j.result; last = JSON.stringify(j.error || "").slice(0, 160); } catch (e) { last = e.message; }
    await new Promise(r => setTimeout(r, 5000 * (i + 1)));
  }
  throw new Error("failed " + last);
}
const PAGE = 32000;
async function scan(id, fields, onRows) {
  let total = 0, all = null;
  for (let off = 0; ; off += PAGE) {
    const p = { resource_id: id, limit: String(PAGE), offset: String(off), sort: "_id" }; if (fields) p.fields = fields;
    const r = await call("datastore_search", p);
    if (all === null) all = r.total;
    onRows(r.records); total += r.records.length;
    if (r.records.length < PAGE) break;
  }
  if (total < all * 0.995) throw new Error(`${id}: read ${total} of ${all}`);
  return total;
}
const inc = (o, k, by = 1) => { o[k] = (o[k] || 0) + by; };
const top = (o, n = 30) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
const show = (title, o, n = 30) => { console.log(title); for (const [k, v] of top(o, n)) console.log(`   ${k}: ${v}`); };
const E = v => v === null || v === undefined || String(v).trim() === "";
const N = v => Number(String(v ?? "").replace(/,/g, "").trim());
const isN = v => !E(v) && !isNaN(N(v));
const posV = v => isN(v) && N(v) > 0;
const U = s => String(s ?? "").trim().toUpperCase();
const plateOf = v => { const n = Number(String(v ?? "").replace(/\D/g, "")); return n > 0 ? n : null; };
const day = s => { const m = String(s ?? "").match(/^(\d{4})-?(\d{2})-?(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5 : null; };
const now = new Date(), TODAY = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 864e5;
const section = async (name, fn) => { log(`== ${name}`); try { await fn(); } catch (e) { console.log(`  ${name} FAILED: ${e.message}`); } };

/* ---------- M: model list and price list ---------- */
const WL = new Map();   // "maker|code" -> rows
let WROWS = [];
await section("M wltp", async () => {
  await scan(ID.wltp, null, rows => { for (const r of rows) WROWS.push(r); });
  for (const r of WROWS) { const k = `${N(r.tozeret_cd)}|${N(r.degem_cd)}`; (WL.get(k) || WL.set(k, []).get(k)).push(r); }
  const sizes = [...WL.values()].map(a => a.length).sort((a, b) => b - a);
  console.log(`wltp rows ${WROWS.length} | maker+code groups ${WL.size} | largest ${sizes.slice(0, 8).join(",")} | groups over 300 rows: ${sizes.filter(x => x > 300).length} (rows in them ${sizes.filter(x => x > 300).reduce((s, x) => s + x, 0)})`);
  // one code under several model names (kinuy_mishari), per type
  const names = {}; let multi = 0; const ex = [];
  for (const [k, rs] of WL) for (const sd of new Set(rs.map(r => U(r.sug_degem)))) { const ns = new Set(rs.filter(r => U(r.sug_degem) === sd).map(r => U(r.kinuy_mishari)).filter(Boolean)); inc(names, ns.size > 3 ? ">3" : String(ns.size)); if (ns.size > 1) { multi++; if (ex.length < 12) ex.push(`${rs[0].tozeret_nm}:${[...ns].slice(0, 4).join("/")}`); } }
  show("model names per maker+code+type (names: groups)", names); console.log(`  examples: ${ex.join(" ; ")}`);
  // towing by year: has / 0/0 / empty
  const tow = {};
  for (const r of WROWS) { const y = N(r.shnat_yitzur); const b = y < 2000 ? "<2000" : String(y); const k = posV(r.kosher_grira_im_blamim) || posV(r.kosher_grira_bli_blamim) ? "has" : isN(r.kosher_grira_im_blamim) && isN(r.kosher_grira_bli_blamim) && N(r.kosher_grira_im_blamim) === 0 && N(r.kosher_grira_bli_blamim) === 0 ? "0/0" : "empty"; inc(tow, `${b} ${k}`); }
  console.log("towing in model rows by year (year kind: rows):"); console.log("  " + Object.entries(tow).sort().map(([k, v]) => `${k}:${v}`).join(" "));
  // rows of one code+type+year that disagree on towing
  const grp = new Map(); for (const r of WROWS) { const k = `${N(r.tozeret_cd)}|${N(r.degem_cd)}|${U(r.sug_degem)}|${N(r.shnat_yitzur)}`; (grp.get(k) || grp.set(k, []).get(k)).push(r); }
  let dis = 0, disZ = 0; for (const rs of grp.values()) { const vs = new Set(rs.map(r => `${N(r.kosher_grira_im_blamim) || 0}/${N(r.kosher_grira_bli_blamim) || 0}`)); if (vs.size > 1) { dis++; if (vs.has("0/0")) disZ++; } }
  console.log(`code+type+year groups ${grp.size} | towing differs between trims: ${dis} (one of them 0/0: ${disZ})`);
  // plug-ins and zeros
  const keys = Object.keys(WROWS[0] || {}); console.log(`wltp fields: ${keys.filter(k => k !== "_id").join(",")}`);
  const ph = {}, z = {};
  for (const r of WROWS) {
    const fuel = String(r.delek_nm || ""), tech = U(r.technologiat_hanaa_nm), y = N(r.shnat_yitzur), yb = y >= 2020 ? "2020+" : y >= 2014 ? "2014-19" : y >= 2008 ? "2008-13" : "<2008";
    const plug = /חשמל\//.test(fuel) || /PLUG|פלאג|נטען/.test(tech);
    if (plug) inc(ph, `plug-in CO2_WLTP ${!isN(r.CO2_WLTP) ? "empty" : N(r.CO2_WLTP) === 0 ? "0" : N(r.CO2_WLTP) < 60 ? "1-59" : N(r.CO2_WLTP) < 100 ? "60-99" : "100+"}`);
    if (!/^חשמל$/.test(fuel.trim()) && isN(r.CO2_WLTP) && N(r.CO2_WLTP) === 0 && posV(r.kamut_CO2)) inc(z, `not EV, CO2_WLTP 0 but kamut_CO2 > 0 (${yb})`);
    if (!/^חשמל$/.test(fuel.trim()) && !posV(r.CO2_WLTP) && !posV(r.kamut_CO2)) inc(z, `not EV, no CO2 at all (${yb})`);
    if (isN(r.mispar_kariot_avir) && N(r.mispar_kariot_avir) === 0) inc(z, `airbags 0 (${yb})`);
    if (isN(r.abs_ind) && N(r.abs_ind) === 0) inc(z, `abs_ind 0 (${yb})`);
    if (isN(r.koah_sus) && N(r.koah_sus) === 0) inc(z, `koah_sus 0 (${yb})`);
    if (isN(r.nefah_manoa) && N(r.nefah_manoa) === 0 && !/^חשמל$/.test(fuel.trim())) inc(z, `nefah_manoa 0, not EV (${yb})`);
  }
  show("plug-in rows:", ph); show("zeros:", z, 40);
  // names the settlement rules depend on
  const nm = {}; for (const r of WROWS) { const k = U(r.kinuy_mishari), d = U(r.degem_nm), t = U(r.ramat_gimur);
    if (/E-?TRON/.test(k + " " + d)) inc(nm, `e-tron kinuy "${k}"`);
    if (/MAZDA ?3|^3$/.test(k) && /MAZDA|מאזדה|מזדה/.test(U(r.tozeret_nm) + k)) inc(nm, `mazda3 kinuy "${k}"`);
    if (/CIVIC/.test(k + d) && /TYPE ?R/.test(k + " " + d + " " + t)) inc(nm, `civic type r cc ${r.nefah_manoa} trim "${t}" kinuy "${k}"`);
    if (/SPORTAGE/.test(k) && N(r.shnat_yitzur) >= 2016 && N(r.shnat_yitzur) <= 2018) inc(nm, `sportage 16-18 tozeret_nm "${String(r.tozeret_nm).trim()}"`); }
  show("names the settlement rules rely on (model rows):", nm, 40);
});
await section("M price", async () => {
  const P = []; await scan(ID.price, null, rows => { for (const r of rows) P.push(r); });
  const byId = new Map(WROWS.map(r => [N(r._id), r])); let same = 0, diff = 0, miss = 0;
  for (const p of P) { const w = byId.get(N(p._id)); if (!w) { miss++; continue; } if (N(w.tozeret_cd) === N(p.tozeret_cd) && N(w.degem_cd) === N(p.degem_cd) && N(w.shnat_yitzur) === N(p.shnat_yitzur) && U(w.sug_degem) === U(p.sug_degem)) same++; else diff++; }
  console.log(`price rows ${P.length} | same _id as a model row with the same maker, code, year and type: ${same} | differs: ${diff} | no model row with that _id: ${miss}`);
  const m = {}; for (const p of P) { const y = N(p.shnat_yitzur); inc(m, `${y < 2010 ? "<2010" : y} ${posV(p.mehir) ? "price" : isN(p.mehir) ? "0" : "empty"}`); }
  console.log("price by year:"); console.log("  " + Object.entries(m).sort().map(([k, v]) => `${k}:${v}`).join(" "));
  const g = new Map(); for (const p of P) if (posV(p.mehir)) { const k = `${N(p.tozeret_cd)}|${N(p.degem_cd)}|${U(p.sug_degem)}|${N(p.shnat_yitzur)}`; (g.get(k) || g.set(k, new Set()).get(k)).add(N(p.mehir)); }
  const sp = {}; for (const s of g.values()) { if (s.size < 2) { inc(sp, "one price"); continue; } const a = [...s], r = Math.max(...a) / Math.min(...a); inc(sp, `${s.size > 3 ? ">3" : s.size} prices, top/bottom ${r < 1.1 ? "<10%" : r < 1.3 ? "10-30%" : ">30%"}`); }
  show("code+type+year groups with a price: how many distinct prices", sp);
});

/* ---------- R: recall lists ---------- */
await section("R recalls", async () => {
  const L = []; await scan(ID.recalls, null, rows => { for (const r of rows) L.push(r); });
  const ids = new Map(); for (const r of L) { const k = N(r.RECALL_ID); ids.set(k, (ids.get(k) || 0) + 1); }
  console.log(`model recall list rows ${L.length} | distinct RECALL_ID ${ids.size} | ids on several rows ${[...ids.values()].filter(x => x > 1).length}`);
  const makers = {}; for (const r of L) inc(makers, String(r.TOZAR_TEUR || "").trim()); console.log(`TOZAR_TEUR values (${Object.keys(makers).length}): ${top(makers, 200).map(([k, v]) => `${k}:${v}`).join(", ")}`);
  const per = new Map(), pairs = new Map(); let rows = 0, txt = 0; const open = {}; let maxOpen = "";
  await scan(ID.recall, null, rs => { for (const r of rs) { rows++; if (typeof r.MISPAR_RECHEV === "string") txt++; const id = N(r.RECALL_ID); per.set(id, (per.get(id) || 0) + 1); const k = `${plateOf(r.MISPAR_RECHEV)}|${id}`; pairs.set(k, (pairs.get(k) || 0) + 1); const d = String(r.TAARICH_PTICHA || "").slice(0, 10); if (d > maxOpen) maxOpen = d; } });
  console.log(`per-car list rows ${rows} | plate as text in ${txt} rows | distinct RECALL_ID ${per.size} | (plate, recall) pairs on several rows ${[...pairs.values()].filter(x => x > 1).length} | newest TAARICH_PTICHA ${maxOpen}`);
  const cov = {}; for (const r of L) { const y = N(r.SHNAT_RECALL), k = y < 2015 ? "<2015" : String(y); inc(cov, `${k} ${per.has(N(r.RECALL_ID)) ? "in per-car list" : "not in it"}`); }
  console.log("model-list recalls by year: in the per-car list or not"); console.log("  " + Object.entries(cov).sort().map(([k, v]) => `${k}:${v}`).join(" "));
  const notL = [...per.keys()].filter(k => !ids.has(k)); console.log(`per-car recall ids missing from the model list: ${notL.length}`);
});

/* ---------- G: disability tags ---------- */
await section("G tags", async () => {
  const pl = new Map(); const typ = {}, yr = {}; let rows = 0;
  await scan(ID.tag, null, rs => { for (const r of rs) { rows++; const p = plateOf(r["MISPAR RECHEV"]); pl.set(p, (pl.get(p) || 0) + 1); inc(typ, String(r["SUG TAV"])); const d = String(r["TAARICH HAFAKAT TAG"] || ""); inc(yr, d.slice(0, 4) || "empty"); } });
  console.log(`tag rows ${rows} | plates ${pl.size} | plates with several rows ${[...pl.values()].filter(x => x > 1).length}`);
  show("SUG TAV values:", typ); console.log("issue year: " + Object.entries(yr).sort().map(([k, v]) => `${k}:${v}`).join(" "));
});

/* ---------- C: cont and tech ---------- */
const HOOK = new Map(); const KM = new Map(); const FO = new Map();
await section("C cont", async () => {
  const g = {}; let rows = 0;
  await scan(ID.cont, "mispar_rechev,grira_nm", rs => { for (const r of rs) { rows++; const t = String(r.grira_nm ?? "").trim(); inc(g, t || "(empty)"); if (t) HOOK.set(plateOf(r.mispar_rechev), t); } });
  console.log(`cont rows ${rows}`); show("grira_nm values:", g, 40);
});
await section("C tech", async () => {
  const mk = {}; let rows = 0;
  await scan(ID.tech, "mispar_rechev,kilometer_test_aharon,mkoriut_nm,rishum_rishon_dt", rs => { for (const r of rs) { rows++; const p = plateOf(r.mispar_rechev); inc(mk, String(r.mkoriut_nm ?? "").trim() || "(empty)"); if (posV(r.kilometer_test_aharon)) KM.set(p, N(r.kilometer_test_aharon)); const rr = day(r.rishum_rishon_dt); if (rr !== null) FO.set(p, rr); } });
  console.log(`tech rows ${rows} | with km ${KM.size}`); show("mkoriut_nm values (full count):", mk, 40);
});

/* ---------- A: active register ---------- */
const REG = new Map();   // plate -> bitmask of registers (bit = index in MAINS)
const DUP = {};
const towOf = (rows, v) => {   // mirror of index.html towOf over rankRows(ofType(rows))
  const sd = U(v.sug_degem), typed = sd && rows.some(r => U(r.sug_degem) === sd) ? rows.filter(r => U(r.sug_degem) === sd) : rows;
  const year = N(v.shnat_yitzur), n = s => String(s || "").trim().toLowerCase();
  const score = r => { let sc = 0; const dy = Math.abs(N(r.shnat_yitzur) - year); sc -= isNaN(dy) ? 50 : dy * 10; if (n(r.sug_degem) && n(r.sug_degem) === n(v.sug_degem)) sc += 3; if (n(r.ramat_gimur) && n(r.ramat_gimur) === n(v.ramat_gimur)) sc += 5; if (n(r.kinuy_mishari) && n(r.kinuy_mishari) === n(v.kinuy_mishari)) sc += 2; return sc; };
  const ranked = typed.slice().sort((a, b) => score(b) - score(a));
  const has = r => posV(r.kosher_grira_im_blamim) || posV(r.kosher_grira_bli_blamim), zero = r => isN(r.kosher_grira_im_blamim) && isN(r.kosher_grira_bli_blamim) && N(r.kosher_grira_im_blamim) === 0 && N(r.kosher_grira_bli_blamim) === 0;
  const t = ranked.find(r => N(r.shnat_yitzur) === year && (has(r) || zero(r)));
  const own = t && U(t.ramat_gimur) === U(v.ramat_gimur);
  if (t) return { k: has(t) ? "own year" : year >= 2008 ? "ban (0/0)" : "0/0 before 2008", own, ranked, typed };
  const same = r => !E(v.kinuy_mishari) && U(r.kinuy_mishari) === U(v.kinuy_mishari) || !E(v.degem_nm) && U(r.degem_nm) === U(v.degem_nm);
  return { k: ranked.find(r => has(r) && same(r)) ? "other year" : "none", own: false, ranked, typed };
};
await section("A active", async () => {
  const tw = {}, hookTw = {}, trim = {}, nc = {}, kmn = {}, sp = {}; let rows = 0;
  await scan(ID.active, "mispar_rechev,tozeret_cd,tozeret_nm,degem_cd,degem_nm,sug_degem,shnat_yitzur,ramat_gimur,kinuy_mishari,mivchan_acharon_dt,tokef_dt,moed_aliya_lakvish", rs => {
    for (const v of rs) {
      rows++; const p = plateOf(v.mispar_rechev);
      if (REG.has(p)) inc(DUP, "active"); REG.set(p, (REG.get(p) || 0) | 1);
      const rowsM = WL.get(`${N(v.tozeret_cd)}|${N(v.degem_cd)}`) || [];
      // towing as the app decides it, against the registration's hook
      const t = towOf(rowsM, v), hk = HOOK.get(p), hook = !hk ? "no hook field" : /אין|ללא|^לא/.test(hk) ? "no hook" : "hook fitted";
      inc(tw, t.k); inc(hookTw, `${t.k} | ${hook}`);
      // the model row the page shows (ranked[0]) against the car's own year, trim and type
      const y = N(v.shnat_yitzur), sd = U(v.sug_degem), tr = U(v.ramat_gimur);
      const k = !rowsM.length ? "no model rows" : !sd || t.typed.length !== rowsM.length || rowsM.every(r => U(r.sug_degem) === sd) ? (() => { const w = t.ranked[0]; const yOk = N(w.shnat_yitzur) === y, tOk = !tr || U(w.ramat_gimur) === tr; return yOk && tOk ? "own year and trim" : yOk ? "own year, other trim" + (tr ? "" : " (car has no trim)") : "other year"; })() : "only the other type's rows";
      inc(trim, k);
      // new cars: km and the last test against the road date
      const road = String(v.moed_aliya_lakvish || "").match(/^(\d{4})-?(\d{1,2})/), test = day(v.mivchan_acharon_dt);
      if (road) { const ageM = (now.getUTCFullYear() - +road[1]) * 12 + now.getUTCMonth() + 1 - +road[2], rd = Date.UTC(+road[1], +road[2] - 1, 1) / 864e5;
        if (test !== null && test < rd - 31) inc(nc, "last test more than a month before the road month");
        if (ageM < 36) { const km = KM.get(p), fo = FO.get(p);
          inc(nc, `on the road <3y: last test ${test === null ? "empty" : fo !== undefined && Math.abs(test - fo) <= 3 ? "= first registration" : "after it"}`);
          if (ageM < 12) inc(kmn, km === undefined ? "<1y: no km" : km < 100 ? "<1y: km <100" : km < 2000 ? "<1y: km 100-1999" : km < 15000 ? "<1y: km 2000-14999" : "<1y: km 15000+"); } }
      if (/SPORTAGE/.test(U(v.kinuy_mishari)) && y >= 2016 && y <= 2018) inc(sp, `sportage ${y} "${String(v.tozeret_nm).trim()}"`);
      if (/E-?TRON/.test(U(v.kinuy_mishari) + " " + U(v.degem_nm))) inc(sp, `e-tron kinuy "${U(v.kinuy_mishari)}"`);
      if (/MAZDA ?3$|^3$/.test(U(v.kinuy_mishari))) inc(sp, `mazda3 kinuy "${U(v.kinuy_mishari)}"`);
    }
  });
  console.log(`active rows ${rows}`);
  show("towing as the app decides it:", tw); show("towing x the registration's hook field:", hookTw, 40);
  show("the model row shown (ranked[0]) vs the car:", trim); show("new cars and test dates:", nc); show("km of cars on the road under a year:", kmn); show("names the settlement rules rely on (active cars):", sp, 40);
});

/* ---------- X: every register's plates ---------- */
const EXTRA = {};
for (const [i, k] of MAINS.entries()) {
  if (k === "active") continue;
  await section("X " + k, async () => {
    const bit = 1 << i; let rows = 0; const f = { moto: "mispar_rechev", heavy: "mispar_rechev", public: "mispar_rechev,tokef_dt", import: "mispar_rechev,tokef_dt,mivchan_acharon_dt,sug_yevu", inactive: "mispar_rechev,tokef_dt,mivchan_acharon_dt", inactive2: "mispar_rechev", cancel: "mispar_rechev,bitul_dt", cancel2010: "mispar_rechev", cancel2000: "mispar_rechev" }[k];
    const seen = new Set();
    await scan(ID[k], f, rs => { for (const r of rs) { rows++; const p = plateOf(r.mispar_rechev); if (!p) { inc(EXTRA, `${k}: no plate`); continue; } if (seen.has(p)) inc(DUP, k); seen.add(p); REG.set(p, (REG.get(p) || 0) | bit);
      if (k === "inactive" && !E(r.tokef_dt)) inc(EXTRA, "inactive row with tokef_dt"); if (k === "import") inc(EXTRA, `import sug_yevu "${String(r.sug_yevu || "").trim()}"`); } });
    console.log(`  ${k} rows ${rows} | plates ${seen.size}`);
  });
}
await section("X overlaps", async () => {
  show("rows that repeat a plate inside one register:", DUP); show("other:", EXTRA);
  const pair = {}, prim = {}, fillDates = {};
  for (const [, m] of REG) {
    const ks = MAINS.filter((k, i) => m & (1 << i));
    if (ks.length > 1) inc(pair, ks.join("+"));
    const pk = ks[0]; inc(prim, pk);
    // a plate the app reads without the active register: later registers fill empty fields (tokef_dt, mivchan_acharon_dt) of the first one
    if (pk !== "active" && ["moto", "heavy", "public"].includes(pk)) { const later = ks.slice(1).filter(k => ["import", "inactive"].includes(k)); if (later.length) inc(fillDates, `${pk} car with a ${later.join("+")} row (test dates filled from it)`); }
  }
  show("plates in more than one register (registers: plates):", pair, 40); show("first register (what the page calls the car):", prim); show("dates filled from another register:", fillDates);
});
log("done");
