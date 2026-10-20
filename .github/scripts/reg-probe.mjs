// One-off (probe-go branch, not for main), 20.10: how the registers that share plates relate, to decide which one describes the car.
// Prints totals and dataset values only, never a plate.
//  import  personal imports (03adc637): which plates are only there, are its test/licence dates current, does it agree with active
//  public  public vehicles (cf29862d): its own cancel fields, against the cancel register and active
//  reuse   a plate in an old cancel register and in active/inactive: the same vehicle or a reused number
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
const rel = d => d === null ? "empty" : d >= TODAY ? "future" : d >= TODAY - 30 ? "ended <=30 days ago" : d >= TODAY - 365 ? "ended 31-365 days ago" : "ended >1 year ago";
const age = d => d === null ? "empty" : d >= TODAY - 400 ? "<=400 days" : d >= TODAY - 800 ? "401-800 days" : ">800 days";
const cmpD = (a, b) => a === null && b === null ? "both empty" : b === null ? "other empty" : a === null ? "this empty" : a === b ? "same" : b < a ? "other older" : "other newer";

const IMP = new Map(), PUB = new Map(), OTHER = new Map();   // plate -> row; OTHER: plate -> set of other registers
const mark = (p, k) => { if (!p) return; (OTHER.get(p) || OTHER.set(p, new Set()).get(p)).add(k); };
await section("read import + public", async () => {
  await scan(ID.import, null, rows => { for (const r of rows) { const p = plateOf(r.mispar_rechev); if (p) IMP.set(p, r); } });
  await scan(ID.public, null, rows => { for (const r of rows) { const p = plateOf(r.mispar_rechev); if (p) PUB.set(p, r); } });
  console.log(`import ${IMP.size} | public ${PUB.size}`);
  const f = {}; for (const r of IMP.values()) { inc(f, `sug_yevu ${r.sug_yevu}`); inc(f, `type ${r.sug_rechev_nm}`); }
  show("import values", f, 40);
  const g = {}; for (const r of PUB.values()) { inc(g, `bitul ${r.bitul_cd}/${r.bitul_nm}${E(r.bitul_dt) ? "" : " +date"}`); inc(g, `type ${r.sug_rechev_nm}`); inc(g, `tokef ${rel(day(r.tokef_dt))}`); }
  show("public values", g, 40);
});
const ACT = {}, AP = {}, MOT = {};
await section("active", async () => {
  await scan(ID.active, "mispar_rechev,tokef_dt,mivchan_acharon_dt,tozeret_cd,degem_cd,shnat_yitzur,moed_aliya_lakvish", rows => { for (const r of rows) {
    const p = plateOf(r.mispar_rechev); mark(p, "active");
    const i = IMP.get(p); if (i) { inc(ACT, `tokef: import vs active ${cmpD(day(r.tokef_dt), day(i.tokef_dt))}`); inc(ACT, `last test: import vs active ${cmpD(day(r.mivchan_acharon_dt), day(i.mivchan_acharon_dt))}`);
      inc(ACT, `maker ${N(i.tozeret_cd) === N(r.tozeret_cd) ? "same" : "differs"}, year ${N(i.shnat_yitzur) === N(r.shnat_yitzur) ? "same" : "differs"}`); inc(ACT, `sug_yevu ${i.sug_yevu}`); }
    const u = PUB.get(p); if (u) { inc(AP, `tokef: public vs active ${cmpD(day(r.tokef_dt), day(u.tokef_dt))}`); inc(AP, `public bitul ${u.bitul_nm}`); inc(AP, `maker ${N(u.tozeret_cd) === N(r.tozeret_cd) ? "same" : "differs"}, degem_cd ${N(u.degem_cd) === N(r.degem_cd) ? "same" : "differs"}`); }
  } });
  show("active + import", ACT); show("active + public", AP);
});
await section("moto", async () => {
  await scan(ID.moto, "mispar_rechev,tozeret_cd,shnat_yitzur,mkoriut_nm,baalut,moed_aliya_lakvish", rows => { for (const r of rows) {
    const p = plateOf(r.mispar_rechev); mark(p, "moto"); inc(MOT, `mkoriut ${E(r.mkoriut_nm) ? "(empty)" : r.mkoriut_nm}`);
    const i = IMP.get(p); if (i) { inc(MOT, `+import: maker ${N(i.tozeret_cd) === N(r.tozeret_cd) ? "same" : "differs"}, year ${N(i.shnat_yitzur) === N(r.shnat_yitzur) ? "same" : "differs"}`); inc(MOT, `+import: import tokef ${rel(day(i.tokef_dt))}`); inc(MOT, `+import: import last test ${age(day(i.mivchan_acharon_dt))}`); inc(MOT, `+import: mkoriut ${E(r.mkoriut_nm) ? "(empty)" : r.mkoriut_nm}`); }
  } });
  show("moto (and moto + import)", MOT, 40);
});
const HV = {};
await section("heavy", async () => {
  await scan(ID.heavy, "mispar_rechev,tozeret_cd,shnat_yitzur", rows => { for (const r of rows) { const p = plateOf(r.mispar_rechev); mark(p, "heavy"); const u = PUB.get(p); if (u) { inc(HV, `public bitul ${u.bitul_nm}`); inc(HV, `public tokef ${rel(day(u.tokef_dt))}`); inc(HV, `maker ${N(u.tozeret_cd) === N(r.tozeret_cd) ? "same" : "differs"}`); } } });
  show("heavy + public", HV);
});
const CAN = {}, REUSE = {};
const IDENT = new Map();   // plate -> "maker|year" of active/inactive rows, for the reuse check
await section("inactive", async () => {
  await scan(ID.inactive, "mispar_rechev,tozeret_cd,shnat_yitzur,tokef_dt", rows => { for (const r of rows) { const p = plateOf(r.mispar_rechev); mark(p, "inactive"); IDENT.set(p, `${N(r.tozeret_cd)}|${N(r.shnat_yitzur)}`); } });
});
await section("inactive2", async () => { await scan(ID.inactive2, "mispar_rechev", rows => { for (const r of rows) mark(plateOf(r.mispar_rechev), "inactive2"); }); });
for (const k of ["cancel", "cancel2010", "cancel2000"]) await section(k, async () => {
  await scan(ID[k], null, rows => { for (const r of rows) {
    const p = plateOf(r.mispar_rechev); const was = OTHER.get(p); mark(p, k);
    const u = PUB.get(p); if (u) { inc(CAN, `${k}: public bitul ${u.bitul_nm}${E(u.bitul_dt) ? "" : " +date"}`); inc(CAN, `${k}: cancel date vs public bitul date ${cmpD(day(r.bitul_dt), day(u.bitul_dt))}`); inc(CAN, `${k}: public tokef ${rel(day(u.tokef_dt))}`); }
    const i = IMP.get(p); if (i) { inc(CAN, `${k} + import: import tokef ${rel(day(i.tokef_dt))}`); inc(CAN, `${k} + import: maker ${N(i.tozeret_cd) === N(r.tozeret_cd) ? "same" : "differs"}`); }
    if (was && (was.has("active") || was.has("inactive"))) { const id = IDENT.get(p); inc(REUSE, `${[...was].filter(x => x === "active" || x === "inactive").join("+")} + ${k}: ${id === undefined ? "active row (maker not kept)" : id === `${N(r.tozeret_cd)}|${N(r.shnat_yitzur)}` ? "same maker and year" : "different maker or year"}`); }
  } });
});
show("cancel registers vs public / import", CAN, 40); show("plate in an old cancel register and in active/inactive", REUSE);
await section("only one register", async () => {
  const io = {}, po = {};
  for (const [p, r] of IMP) { const o = OTHER.get(p); if (o && o.size) continue; inc(io, `tokef ${rel(day(r.tokef_dt))}`); inc(io, `last test ${age(day(r.mivchan_acharon_dt))}`); inc(io, `sug_yevu ${r.sug_yevu}`); inc(io, `type ${r.sug_rechev_nm}`); inc(io, `road ${String(r.moed_aliya_lakvish || "").slice(0, 4) || "empty"}`); }
  show("import only (in no other register)", io, 60);
  for (const [p, r] of PUB) { const o = OTHER.get(p); if (o && o.size) continue; inc(po, `bitul ${r.bitul_nm}${E(r.bitul_dt) ? "" : " +date"}`); inc(po, `tokef ${rel(day(r.tokef_dt))}`); inc(po, `type ${r.sug_rechev_nm}`); }
  show("public only", po, 40);
});
log("done");
