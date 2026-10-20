import { createHash } from "node:crypto";
// One-off (probe-go branch, not for main), 20.10, round 2: which ownership record is "now", and how long each ownership lasted.
// 1. how each register writes the current owner type (fields, values)
// 2. the reported car (found by the hash of its plate, never printed): its log rows exactly as the app asks for them, and the register's type
// 3. every active car: the log's last month against the register's current type, under the app's rule today and candidate rules
// 4. what the log's first record means (is it the car's first registration, and where does the log start), for ownership durations
// Prints totals only, never a plate.
const API = "https://data.gov.il/api/3/action/";
const ID = { active: "053cea08-09bc-40ec-8f7a-156f0677aff3", owners: "bb2355dc-9ec7-4f06-9c3f-3344672171da" };
const REGS = { active: "053cea08-09bc-40ec-8f7a-156f0677aff3", moto: "bf9df4e2-d90d-4c0a-a400-19e15af8e95f", heavy: "cd3acc5c-03c3-4c89-9c54-d40f93c0d790", public: "cf29862d-ca25-4691-84f6-1be60dcb4a1e", import: "03adc637-b6fe-402b-9937-7c3d3afc9140", inactive: "f6efe89a-fb3d-43a4-bb61-9bf12a9b9099", inactive2: "6f6acd03-f351-4a8f-8ecf-df792f4f573a", cancel: "851ecab1-0622-4dbe-a6c7-f950cf82abf9", cancel2010: "4e6b9724-4c1e-43f0-909a-154d4cc4e046", cancel2000: "ec8cbc34-72e1-4b69-9c48-22821ba0bd6c" };
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
const top = (o, n = 30) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
const inc = (o, k, by = 1) => { o[k] = (o[k] || 0) + by; };
for (const [k, id] of Object.entries(ID)) { try { const r = await call("resource_show", { id }); log(`${k}: last_modified ${r.last_modified || r.metadata_modified}`); } catch (e) { log(`${k}: ${e.message}`); } }

// 1. registers: owner-type fields and their values
console.log("\n== registers: owner fields");
for (const [k, id] of Object.entries(REGS)) {
  try {
    const f = (await call("datastore_search", { resource_id: id, limit: "0" }, 3)).fields.map(x => x.id).filter(x => /baalut|mkoriut|bitul/i.test(x));
    let vals = "";
    const bf = f.find(x => /^baalut$/i.test(x));
    if (bf) { try { const d = await call("datastore_search", { resource_id: id, distinct: "true", fields: bf, limit: "60" }, 3); vals = d.records.map(r => r[bf]).join(" / "); } catch (e) { vals = "distinct failed"; } }
    console.log(`  ${k}: ${f.join(",") || "none"}${vals ? " | baalut values: " + vals : ""}`);
  } catch (e) { console.log(`  ${k}: ${e.message}`); }
}

// the app's grouping of an owner type (index.html ownerKind + isDealerRec)
const kindOf = t => { t = String(t || ""); return /סוחר|יבואן|מסחר/.test(t) ? "dealer" : /השכר/.test(t) ? "rental" : /ליסינג|החכר|חכיר/.test(t) ? "lease" : /חברה|חברת|תאגיד/.test(t) ? "company" : /פרטי/.test(t) ? "private" : t.trim() ? "other" : "none"; };
const KINDS = ["private", "company", "lease", "rental", "dealer", "other", "none"], kc = k => KINDS.indexOf(k), kn = c => KINDS[c];
const ymOf = s => { const m = String(s || "").match(/^(\d{4})-?(\d{1,2})/); return m ? +m[1] * 100 + +m[2] : 0; };
const mdiff = (a, b) => (Math.floor(b / 100) - Math.floor(a / 100)) * 12 + (b % 100 - a % 100);

// 2+3. the active register
const HASH = "b963c629a856e795e7c4caa4519e5428c7d08bf39033da273b62ee7e7e41251d", sha = s => createHash("sha256").update(String(s)).digest("hex");
const REG = new Map(), regVals = {}; let P = 0;
log("active rows: " + await scan(ID.active, "mispar_rechev,baalut,moed_aliya_lakvish", rows => {
  for (const r of rows) {
    const p = Number(r.mispar_rechev), b = String(r.baalut ?? "").trim();
    inc(regVals, b || "(empty)");
    REG.set(p, { k: kc(kindOf(b)), raw: b, road: ymOf(r.moed_aliya_lakvish) });
    if (!P && sha(p) === HASH) P = p;
  }
}));
console.log("register baalut values: " + top(regVals, 20).map(([k, v]) => `${k} ${v}`).join(" | "));
log(`reported car found: ${!!P}`);

const OWN = new Map(), logVals = {}; let rowsN = 0, minYm = 999999, maxYm = 0;
log("owners rows: " + await scan(ID.owners, "_id,mispar_rechev,baalut_dt,baalut", rows => {
  for (const r of rows) {
    rowsN++;
    const p = Number(r.mispar_rechev), ym = Number(r.baalut_dt), raw = String(r.baalut ?? "").trim(), c = kc(kindOf(raw));
    inc(logVals, raw || "(empty)");
    if (ym < minYm) minYm = ym; if (ym > maxYm) maxYm = ym;
    let o = OWN.get(p);
    if (!o) { OWN.set(p, { f: ym, fk: c, l: ym, g: [c], n: 1, prev: 0 }); continue; }
    o.n++;
    if (ym > o.l) { o.prev = o.l; o.l = ym; o.g = [c]; } else if (ym === o.l) o.g.push(c);
  }
}));
console.log(`log rows ${rowsN} | plates ${OWN.size} | months ${minYm}..${maxYm} | values: ${top(logVals, 12).map(([k, v]) => `${k} ${v}`).join(" | ")}`);

// the candidate rules: which record of the last month is "now"
const RANK = { lease: 0, rental: 0, company: 0, other: 0, none: 0, dealer: 1, private: 2 };
const sameStrict = (reg, k) => reg === k;
const sameLoose = (reg, k) => reg === k || (reg === kc("company") && k === kc("lease")) || (reg === kc("lease") && k === kc("company"));
const rules = {
  today: (g) => g[g.length - 1],
  dealerFirst: (g) => { const nd = g.filter(c => c !== kc("dealer")); return nd.length ? nd[nd.length - 1] : g[g.length - 1]; },
  progression: (g) => g.map((c, i) => [c, i]).sort((a, b) => RANK[kn(a[0])] - RANK[kn(b[0])] || a[1] - b[1]).pop()[0],
};
rules.registerThenProgression = (g, reg, same) => g.some(c => same(reg, c)) ? g.filter(c => same(reg, c)).pop() : rules.progression(g);

if (P) {
  const o = await call("datastore_search", { resource_id: ID.owners, filters: JSON.stringify({ mispar_rechev: P }), limit: "100" });
  console.log("\n== the reported car: log rows exactly as the app asks for them");
  for (const r of o.records) console.log(`  _id ${r._id} | ${r.baalut_dt} | ${r.baalut}`);
  const R = REG.get(P); console.log(`  register: baalut "${R.raw}" | on road ${R.road}`);
  const g = OWN.get(P).g; console.log(`  last month ${OWN.get(P).l}, records in _id order: ${g.map(kn).join(">")}`);
  for (const [k, f] of Object.entries(rules)) console.log(`  rule ${k}: now = ${kn(f(g, R.k, sameLoose))}`);
}

// 3. every active car
const st = { cars: 0, noLog: 0, single: 0, multi: 0 }, mis = {}, singleX = {}, singleAge = {}, pairs = {}, multiMiss = {}, regDealer = {}, dealerNow = {};
for (const [p, R] of REG) {
  st.cars++;
  const o = OWN.get(p);
  if (!o) { st.noLog++; if (R.k === kc("dealer")) inc(regDealer, "no log rows"); continue; }
  const g = o.g;
  if (R.k === kc("dealer")) inc(regDealer, g.includes(kc("dealer")) ? "last month has a dealer record" : "last month has no dealer record: " + [...new Set(g.map(kn))].join("+"));
  if (g.length === 1) {
    st.single++;
    inc(singleX, `register ${R.raw || "(empty)"} / log ${kn(g[0])}`);
    if (!sameLoose(R.k, g[0])) { const a = mdiff(o.l, 202610); inc(singleAge, `${kn(R.k)}<-${kn(g[0])} ${a <= 0 ? "0" : a === 1 ? "1" : a <= 3 ? "2-3" : a <= 12 ? "4-12" : a <= 24 ? "13-24" : ">24"} months old`); }
  } else {
    st.multi++;
    for (const [k, f] of Object.entries(rules)) { inc(mis, k + " strict", sameStrict(R.k, f(g, R.k, sameStrict)) ? 0 : 1); inc(mis, k + " loose", sameLoose(R.k, f(g, R.k, sameLoose)) ? 0 : 1); }
    const kinds = [...new Set(g.map(kn))].sort().join("+");
    inc(pairs, `${kinds} -> register ${kn(R.k)}`);
    if (!g.some(c => sameLoose(R.k, c))) inc(multiMiss, `${g.map(kn).join(">")} | register ${R.raw || "(empty)"}`);
  }
  const t = rules.today(g), nw = g.length > 1 ? rules.registerThenProgression(g, R.k, sameLoose) : g[0];
  inc(dealerNow, `today log-last dealer ${t === kc("dealer") ? 1 : 0} | new rule dealer ${nw === kc("dealer") ? 1 : 0} | register dealer ${R.k === kc("dealer") ? 1 : 0}`);
}
console.log(`\n== active cars ${st.cars} | no log rows ${st.noLog} | one record in the last month ${st.single} | several ${st.multi}`);
console.log("one record in the last month, register value x log kind:"); for (const [k, v] of top(singleX, 30)) console.log(`   ${k}: ${v}`);
console.log("one record, kinds differ (loose), by how old the log record is (months before 10/2026):"); for (const [k, v] of top(singleAge, 30)) console.log(`   ${k}: ${v}`);
console.log(`several records in the last month (${st.multi}): the rule's "now" differs from the register in:`); for (const [k, v] of Object.entries(mis)) console.log(`   ${k}: ${v}`);
console.log("several records, the kinds in the month -> the register's kind:"); for (const [k, v] of top(pairs, 40)) console.log(`   ${k}: ${v}`);
console.log("several records, none of the register's kind:"); for (const [k, v] of top(multiMiss, 20)) console.log(`   ${k}: ${v}`);
console.log("register says dealer:"); for (const [k, v] of top(regDealer, 15)) console.log(`   ${k}: ${v}`);
console.log("now at a dealer, today vs new rule vs register:"); for (const [k, v] of top(dealerNow, 10)) console.log(`   ${k}: ${v}`);

// 4. the first record: is it the car's first registration, and the log's start
const first = {}, firstOld = {}, plateFirstAtMin = [...OWN.values()].filter(o => o.f === minYm).length;
for (const [p, R] of REG) {
  const o = OWN.get(p); if (!R.road) { inc(first, "no road date"); continue; }
  if (R.road < 201701) { inc(firstOld, !o ? "no log" : o.f === minYm ? `first record at ${minYm}` : o.f < 201801 ? "first record later in 2017" : "first record 2018 or later"); continue; }
  if (!o) { inc(first, "no log"); continue; }
  const d = mdiff(R.road, o.f);
  inc(first, d < 0 ? "first record before the road date" : d === 0 ? "same month" : d === 1 ? "1 month after" : d <= 3 ? "2-3 months after" : d <= 12 ? "4-12 months after" : "over a year after");
}
console.log(`\n== log starts ${minYm}; plates whose first record is in ${minYm}: ${plateFirstAtMin}`);
console.log("cars on the road before 2017, their first log record:"); for (const [k, v] of top(firstOld)) console.log(`   ${k}: ${v}`);
console.log("cars on the road from 2017, first log record vs the road date:"); for (const [k, v] of top(first)) console.log(`   ${k}: ${v}`);
log("done");
