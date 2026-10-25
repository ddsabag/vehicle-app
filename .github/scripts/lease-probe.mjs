// One-off: how long does a first lease/rental/dealer/company ownership last, and do cars whose first lease owner held them only briefly
// drive like private cars? Totals only, never a plate.
const API = "https://data.gov.il/api/3/action/", PAGE = 32000, T0 = Date.now(), log = m => console.log(`[${Math.round((Date.now() - T0) / 1000)}s] ${m}`);
const ID = { active: "053cea08-09bc-40ec-8f7a-156f0677aff3", tech: "56063a99-8a3e-4ff4-912e-5966c0279bad", owners: "bb2355dc-9ec7-4f06-9c3f-3344672171da" };
async function call(p, tries = 8) { let last = ""; for (let i = 0; i < tries; i++) { try { const r = await fetch(API + "datastore_search?" + new URLSearchParams(p), { headers: { Accept: "application/json", "User-Agent": "luchit-probe/1.0" }, signal: AbortSignal.timeout(180000) }); const j = await r.json(); if (j.success) return j.result; last = JSON.stringify(j.error || "").slice(0, 160); } catch (e) { last = e.message; } await new Promise(r => setTimeout(r, 5000 * (i + 1))); } throw new Error("failed " + last); }
async function scan(id, fields, on) { let t = 0; for (let off = 0; ; off += PAGE) { const r = await call({ resource_id: id, limit: String(PAGE), offset: String(off), sort: "_id", fields }); on(r.records); t += r.records.length; if (r.records.length < PAGE) break; } return t; }
const N = v => Number(String(v ?? "").replace(/,/g, "").trim()), P = v => { const n = Number(String(v ?? "").replace(/\D/g, "")); return n > 0 ? n : 0; };
const ym = v => { const m = String(v ?? "").match(/^(\d{4})-?(\d{2})/); return m ? +m[1] * 12 + (+m[2] - 1) : null; };
const kind = t => { t = String(t || ""); return /סוחר|יבואן/.test(t) ? "dealer" : /החכר|ליסינג|חכיר/.test(t) ? "lease" : /השכר/.test(t) ? "rental" : /חברה|חברת|תאגיד/.test(t) ? "company" : /פרטי/.test(t) ? "private" : "other"; };
const KS = ["private", "dealer", "lease", "rental", "company", "other"];
// 1. ownership log: per plate, records [month, kind]
const own = new Map(); const kinds = new Map();
log("owners rows " + await scan(ID.owners, "mispar_rechev,baalut_dt,baalut", rows => { for (const r of rows) { const p = P(r.mispar_rechev), m = ym(r.baalut_dt); if (!p || m == null) continue; const b = String(r.baalut || "").trim(); kinds.set(b, (kinds.get(b) || 0) + 1); const k = KS.indexOf(kind(b)); const a = own.get(p); if (a) a.push(m * 8 + k); else own.set(p, [m * 8 + k]); } }));
console.log("log owner words:", [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, n]) => `${k}=${n}`).join(", "));
// 2. active register: first road month, last test date
const act = new Map();
log("active rows " + await scan(ID.active, "mispar_rechev,moed_aliya_lakvish,mivchan_acharon_dt,shnat_yitzur", rows => { for (const r of rows) { const p = P(r.mispar_rechev); if (!own.has(p)) continue; const road = ym(r.moed_aliya_lakvish), t = String(r.mivchan_acharon_dt || "").match(/^(\d{4})-(\d{2})-(\d{2})/); act.set(p, [road ?? -1, t ? Date.UTC(+t[1], +t[2] - 1, +t[3]) / 864e5 : -1, N(r.shnat_yitzur)]); } }));
// 3. km at the last test
const km = new Map();
log("tech rows " + await scan(ID.tech, "mispar_rechev,kilometer_test_aharon", rows => { for (const r of rows) { const p = P(r.mispar_rechev), k = N(r.kilometer_test_aharon); if (k > 0 && act.has(p)) km.set(p, k); } }));
// first ownership: kind and months until the next record of a different month; only cars whose log starts within 1 month of the first road month
// (the log covers the car's whole life) and that went on the road from 3.2017 on
const BUCKETS = [0, 1, 2, 3, 4, 6, 9, 12, 18, 24, 36, 60, 999], bl = b => BUCKETS.findIndex(x => b <= x);
const hist = {}, still = {}, kmg = {}, med = a => { if (!a.length) return "-"; a.sort((x, y) => x - y); return Math.round(a[a.length >> 1]); };
for (const k of KS) { hist[k] = new Array(BUCKETS.length).fill(0); still[k] = 0; }
let cars = 0;
for (const [p, a] of own) {
  const A = act.get(p); if (!A || A[0] < 2017 * 12 + 2) continue;
  a.sort((x, y) => x - y); const m0 = Math.floor(a[0] / 8), k0 = KS[a[0] % 8];
  if (Math.abs(m0 - A[0]) > 1) continue;
  cars++;
  const nx = a.find(x => Math.floor(x / 8) > m0), dur = nx ? Math.floor(nx / 8) - m0 : null;
  if (dur == null) still[k0]++; else hist[k0][bl(dur)]++;
  // km per year: last test km over years on the road (at least 2 years on the road at the test)
  const K = km.get(p); if (!K || A[1] < 0) continue;
  const roadDay = Date.UTC(Math.floor(A[0] / 12), A[0] % 12, 15) / 864e5, yrs = (A[1] - roadDay) / 365.25; if (yrs < 2) continue;
  const kys = K / yrs, kinds2 = new Set(a.map(x => KS[x % 8]));
  const g = k0 === "private" && !kinds2.has("lease") && !kinds2.has("rental") && !kinds2.has("company") ? "private all along"
    : (k0 === "lease" || k0 === "dealer" || k0 === "company" || k0 === "rental") && dur != null ? `${k0} first, ${dur <= 1 ? "<=1" : dur <= 2 ? "2" : dur <= 3 ? "3" : dur <= 6 ? "4-6" : dur <= 12 ? "7-12" : dur <= 24 ? "13-24" : ">24"} mo` : null;
  if (g) (kmg[g] = kmg[g] || []).push(kys);
}
console.log(`\ncars whose log starts at the first road month (road from 3.2017): ${cars}`);
console.log("first owner kind: months until the next owner (bucket = up to N months) | still the first owner");
for (const k of KS) console.log(k.padEnd(8), BUCKETS.map((b, i) => `${b === 999 ? ">60" : "<=" + b}:${hist[k][i]}`).join(" "), "| still:" + still[k]);
console.log("\nkm per year at the last test (cars 2+ years on the road at the test): group, cars, median, p25, p75");
const q = (a, f) => Math.round(a[Math.floor(a.length * f)]);
for (const [g, a] of Object.entries(kmg).sort()) { a.sort((x, y) => x - y); if (a.length >= 30) console.log(g.padEnd(24), a.length, q(a, .5), q(a, .25), q(a, .75)); }
