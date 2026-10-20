// One-off (probe-go branch, not for main), 20.10: how the licence end (tokef_dt) sits against the last test (mivchan_acharon_dt) in the
// active register, to set the rule "a test that belongs to this renewal" and to see which cars renew on other cycles.
// Prints totals only, never a plate.
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
// the official sources index.html cites for the licence fee table and the company-car tax figures (gov.il is not reachable from the dev container)
import fs from "node:fs";
for (const [name, url] of [["fees2026.pdf", "https://www.gov.il/BlobFolder/policy/car_fees_2026/he/%D7%93%D7%A3%20%D7%90%D7%92%D7%A8%D7%95%D7%AA%20%2001.04.2026.pdf"],
  ["tax2026.pdf", "https://www.gov.il/BlobFolder/generalpage/income-tax-monthly-deductions-booklet/he/generalInformation_income-tax-monthly-deductions-booklet_monthly-deductions-booklet-2026.pdf"]]) {
  try { const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (luchit data check)" }, signal: AbortSignal.timeout(60000) }); const b = Buffer.from(await r.arrayBuffer()); fs.mkdirSync("out", { recursive: true }); fs.writeFileSync("out/" + name, b); console.log(`${name}: HTTP ${r.status}, ${b.length} bytes`); }
  catch (e) { console.log(`${name}: ${e.message}`); }
}
const gapB = g => g === null ? "no test" : g < 0 ? "test after licence end" : g <= 30 ? "0-30" : g <= 90 ? "31-90" : g <= 180 ? "91-180" : g <= 299 ? "181-299" : g <= 364 ? "300-364" : g <= 400 ? "365-400" : g <= 500 ? "401-500" : ">500";
const kindOf = t => { t = String(t || ""); return /השכר/.test(t) ? "rental" : /ליסינג|החכר|חכיר/.test(t) ? "lease" : /סוחר/.test(t) ? "dealer" : /חברה/.test(t) ? "company" : /פרטי/.test(t) ? "private" : "other:" + t.slice(0, 12); };
const G = {}, EXP = {}, VAL = {}, DOM = {}, AGE = {}, REC = {}, NEW = {}, PUBT = {};
const PUBP = new Set();
await section("public plates", async () => { await scan(ID.public, "mispar_rechev,sug_rechev_nm", rows => { for (const r of rows) { const p = plateOf(r.mispar_rechev); if (p) PUBP.add(p); } }); console.log(`public plates ${PUBP.size}`); });
await section("active", async () => {
  await scan(ID.active, "mispar_rechev,tokef_dt,mivchan_acharon_dt,moed_aliya_lakvish,baalut,sug_degem,shnat_yitzur", rows => { for (const r of rows) {
    const e = day(r.tokef_dt), t = day(r.mivchan_acharon_dt); if (e === null) { inc(G, "no licence date"); continue; }
    const g = t === null ? null : e - t, b = gapB(g), st = e >= TODAY ? "valid" : e >= TODAY - 30 ? "ended <=30d" : e >= TODAY - 365 ? "ended 31-365d" : "ended >1y";
    inc(G, `${st} | ${b}`);
    const road = String(r.moed_aliya_lakvish || "").match(/^(\d{4})-?(\d{1,2})/), ageY = road ? (now.getUTCFullYear() - +road[1]) + (now.getUTCMonth() + 1 - +road[2]) / 12 : null;
    const ab = ageY === null ? "age ?" : ageY < 3 ? "<3y" : ageY < 10 ? "3-10y" : ">=10y", k = kindOf(r.baalut), pub = PUBP.has(plateOf(r.mispar_rechev)) ? "public" : "not public";
    inc(AGE, `${ab} | ${b}`);
    if (g !== null && g >= 0 && g <= 299) { inc(REC, `kind ${k}`); inc(REC, `type ${r.sug_degem}`); inc(REC, `${pub}`); inc(REC, `age ${ab}`); inc(REC, `licence ${st}`); }
    if (g !== null && g >= 365 && g <= 500) { inc(NEW, `kind ${k}`); inc(NEW, `${pub}`); }
    if (st === "ended <=30d") { inc(EXP, `${b}`); inc(EXP, `${b} | ${k}`); }
    if (st === "valid" && e <= TODAY + 30) inc(VAL, b);
    const dd = String(r.tokef_dt).slice(8, 10); inc(DOM, dd === "" ? "?" : +dd >= 28 ? "28-31" : +dd === 1 ? "1st" : "2-27");
    if (pub === "public") inc(PUBT, b);
  } });
});
show("licence state | days from the last test to the licence end", G, 60);
show("age | days from the last test to the licence end", AGE, 40);
show("licence ends 0-299 days after the last test: who", REC, 40);
show("licence ends 365-500 days after the last test: who (the usual yearly cycle)", NEW, 20);
show("licences that ended in the last 30 days: days from the last test", EXP, 40);
show("licences that end in the next 30 days: days from the last test", VAL, 20);
show("day of month of the licence end", DOM, 5);
show("public vehicles in active: days from the last test to the licence end", PUBT, 20);
log("done");
