// One-off (probe-go branch, not for main), 20.10: how fresh and how consistent the ministry's test and license dates are.
// 1. every register's test, license, km and cancel fields, and when each dataset was last updated
// 2. every active car: tests per day in the last 60 days (does the data stop before today?), license expiry per day around today
//    (are recently expired licenses really expired, or renewed and not yet in the data?), license vs last test, new cars, odd values
// 3. the km dataset ("tech"): is its last test the same one the active register names?
// Prints totals only, never a plate.
const API = "https://data.gov.il/api/3/action/";
const REGS = { active: "053cea08-09bc-40ec-8f7a-156f0677aff3", moto: "bf9df4e2-d90d-4c0a-a400-19e15af8e95f", heavy: "cd3acc5c-03c3-4c89-9c54-d40f93c0d790", public: "cf29862d-ca25-4691-84f6-1be60dcb4a1e", import: "03adc637-b6fe-402b-9937-7c3d3afc9140", inactive: "f6efe89a-fb3d-43a4-bb61-9bf12a9b9099", inactive2: "6f6acd03-f351-4a8f-8ecf-df792f4f573a", cancel: "851ecab1-0622-4dbe-a6c7-f950cf82abf9", cancel2010: "4e6b9724-4c1e-43f0-909a-154d4cc4e046", cancel2000: "ec8cbc34-72e1-4b69-9c48-22821ba0bd6c", cont: "0866573c-40cd-4ca8-91d2-9dd2d7a492e5", tech: "56063a99-8a3e-4ff4-912e-5966c0279bad" };
const T0 = Date.now(), log = m => console.log(`[${Math.round((Date.now() - T0) / 1000)}s] ${m}`);
async function call(act, params, tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(API + act + "?" + new URLSearchParams(params), { signal: AbortSignal.timeout(180000) }); const j = await r.json(); if (j.success) return j.result; last = JSON.stringify(j.error || "").slice(0, 160); } catch (e) { last = e.message; }
    await new Promise(r => setTimeout(r, 4000 * (i + 1)));
  }
  throw new Error("failed " + last);
}
const PAGE = 32000;
async function scan(id, fields, onRows) {
  let total = 0, all = null;
  for (let off = 0; ; off += PAGE) {
    const r = await call("datastore_search", { resource_id: id, limit: String(PAGE), offset: String(off), fields, sort: "_id" });
    if (all === null) all = r.total;
    onRows(r.records); total += r.records.length;
    if (r.records.length < PAGE) break;
  }
  if (total < all * 0.995) throw new Error(`${id}: read ${total} of ${all}`);
  return total;
}
const inc = (o, k, by = 1) => { o[k] = (o[k] || 0) + by; };
const top = (o, n = 30) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
const day = s => { const m = String(s ?? "").match(/^(\d{4})-?(\d{2})-?(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5 : null; };
const now = new Date(), TODAY = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 864e5;
const iso = d => new Date(d * 864e5).toISOString().slice(0, 10);

// 1. fields and freshness
console.log("== registers: last update and the test / license / km / cancel fields (with a sample value)");
for (const [k, id] of Object.entries(REGS)) {
  try {
    const rs = await call("resource_show", { id }, 3);
    const r = await call("datastore_search", { resource_id: id, limit: "1" }, 3), f = r.fields.map(x => x.id).filter(x => /tokef|mivchan|test|kilometer|bitul|rishum|aliya|horada/i.test(x));
    console.log(`  ${k}: updated ${rs.last_modified || rs.metadata_modified} | rows ${r.total} | ${f.map(x => `${x}=${JSON.stringify((r.records[0] || {})[x] ?? null)}`).join(", ") || "none"}`);
  } catch (e) { console.log(`  ${k}: ${e.message}`); }
}

// 2. the active register
const testDay = {}, tokefDay = {}, rel = {}, newCars = {}, odd = {}; let maxTest = 0, cars = 0;
const TECH = new Map();
log("active rows: " + await scan(REGS.active, "mispar_rechev,tokef_dt,mivchan_acharon_dt,moed_aliya_lakvish,shnat_yitzur", rows => {
  for (const r of rows) {
    cars++;
    const t = day(r.mivchan_acharon_dt), e = day(r.tokef_dt), road = String(r.moed_aliya_lakvish || "").match(/^(\d{4})-?(\d{1,2})/);
    if (r.tokef_dt && e === null) inc(odd, "tokef_dt not a date: " + String(r.tokef_dt).slice(0, 12));
    if (!r.tokef_dt) inc(odd, "tokef_dt empty");
    if (r.mivchan_acharon_dt && t === null) inc(odd, "mivchan_acharon_dt not a date: " + String(r.mivchan_acharon_dt).slice(0, 12));
    if (t !== null) { if (t > maxTest) maxTest = t; if (t >= TODAY - 60) inc(testDay, iso(t)); }
    if (e !== null && e >= TODAY - 60 && e <= TODAY + 30) inc(tokefDay, iso(e));
    if (t !== null && e !== null) { const g = e - t; inc(rel, g < 0 ? "license ends before the last test" : g < 300 ? "license ends <300 days after the last test" : g <= 400 ? "license ends 300-400 days after the last test" : g <= 800 ? "license ends 401-800 days after the last test" : "license ends >800 days after the last test"); }
    else inc(rel, t === null ? (e === null ? "no test, no license date" : "license date, never tested") : "tested, no license date");
    if (road) { const ageM = (now.getUTCFullYear() - +road[1]) * 12 + now.getUTCMonth() + 1 - +road[2]; if (ageM < 48) inc(newCars, `on the road ${Math.floor(ageM / 12)} years: ${t === null ? "never tested" : "tested"}${e !== null && e < TODAY ? ", license expired" : ""}`); }
    if (t !== null && t >= TODAY - 400) TECH.set(Number(r.mispar_rechev), t);
  }
}));
console.log(`\n== active cars ${cars} | newest last-test date ${iso(maxTest)} (today ${iso(TODAY)})`);
console.log("tests per day, last 60 days (date: cars):"); console.log("  " + Object.entries(testDay).sort().map(([d, n]) => `${d.slice(5)}:${n}`).join(" "));
console.log("license ends per day, 60 days back to 30 ahead:"); console.log("  " + Object.entries(tokefDay).sort().map(([d, n]) => `${d.slice(5)}:${n}`).join(" "));
const sum = (o, a, b) => Object.entries(o).filter(([d]) => { const x = day(d); return x >= a && x < b; }).reduce((s, [, n]) => s + n, 0);
console.log(`licenses that ended in the last 30 days ${sum(tokefDay, TODAY - 30, TODAY)} | that end in the next 30 days ${sum(tokefDay, TODAY, TODAY + 30)} | ended 31-60 days ago ${sum(tokefDay, TODAY - 60, TODAY - 30)}`);
console.log("license vs last test:"); for (const [k, v] of top(rel)) console.log(`   ${k}: ${v}`);
console.log("cars on the road under 4 years:"); for (const [k, v] of top(newCars)) console.log(`   ${k}: ${v}`);
console.log("odd values:"); for (const [k, v] of top(odd, 12)) console.log(`   ${k}: ${v}`);

// 3. the km dataset against the active register's last test
try {
  const f = (await call("datastore_search", { resource_id: REGS.tech, limit: "0" })).fields.map(x => x.id), dateF = f.filter(x => /mivchan|test|_dt$/i.test(x));
  console.log(`\n== tech dataset fields with dates: ${dateF.join(", ") || "none"}`);
  const cmp = {}; let n = 0;
  log("tech rows: " + await scan(REGS.tech, ["mispar_rechev", "kilometer_test_aharon", ...dateF].join(","), rows => {
    for (const r of rows) {
      const t = TECH.get(Number(r.mispar_rechev)); if (t === undefined) continue; n++;
      for (const k of dateF) { const d = day(r[k]); inc(cmp, `${k}: ${d === null ? "empty" : d === t ? "same day as the register's last test" : d < t ? (t - d <= 31 ? "up to a month before" : "over a month before") : "after"}`); }
      if (!dateF.length) inc(cmp, "no date field");
      if (!(Number(String(r.kilometer_test_aharon).replace(/,/g, "")) > 0)) inc(cmp, "km empty or 0");
    }
  }));
  console.log(`cars tested in the last 400 days found in tech: ${n}`); for (const [k, v] of top(cmp)) console.log(`   ${k}: ${v}`);
} catch (e) { console.log("tech: " + e.message); }
log("done");
