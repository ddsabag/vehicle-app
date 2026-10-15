// Probe: does first-registration date (tech rishum_rishon_dt) disagree with first-on-road month (active moed_aliya_lakvish)?
// A car re-registered after being off the road might carry a later registration date.
const API = "https://data.gov.il/api/3/action/datastore_search", PAGE = 30000;
async function call(p, t = 8) { for (let i = 0; i < t; i++) { try { const j = await (await fetch(API + "?" + new URLSearchParams(p), {signal: AbortSignal.timeout(120000)})).json(); if (j.success) return j.result; } catch {} await new Promise(r => setTimeout(r, 4000 * (i + 1))); } throw new Error("fail"); }
async function scan(id, fields, f) { for (let off = 0; ; off += PAGE) { const r = await call({resource_id: id, limit: String(PAGE), offset: String(off), fields}); for (const x of r.records) f(x); if (r.records.length < PAGE) break; } }
const act = new Map();
await scan("053cea08-09bc-40ec-8f7a-156f0677aff3", "mispar_rechev,moed_aliya_lakvish,shnat_yitzur,tozeret_nm,kinuy_mishari,mivchan_acharon_dt,baalut", x => {
  const m = /^(\d{4})-(\d{1,2})$/.exec(String(x.moed_aliya_lakvish || "")); act.set(+x.mispar_rechev, {a: m ? +m[1] * 12 + +m[2] - 1 : null, y: +x.shnat_yitzur, n: `${x.tozeret_nm} ${x.kinuy_mishari}`, t: x.mivchan_acharon_dt, b: x.baalut});
});
console.log("active", act.size);
const hist = new Map(); let n = 0, both = 0, noA = 0; const ex = [];
const bucket = d => d < -24 ? "<-24" : d < -1 ? "-24..-2" : d <= 1 ? "-1..1" : d <= 6 ? "2..6" : d <= 12 ? "7..12" : d <= 24 ? "13..24" : d <= 60 ? "25..60" : ">60";
await scan("56063a99-8a3e-4ff4-912e-5966c0279bad", "mispar_rechev,rishum_rishon_dt,mkoriut_nm", x => {
  n++; const a = act.get(+x.mispar_rechev); if (!a) return; const m = /^(\d{4})-(\d{2})/.exec(String(x.rishum_rishon_dt || "")); if (!m) return;
  if (a.a == null) { noA++; return; }
  both++; const d = (+m[1] * 12 + +m[2] - 1) - a.a; const k = bucket(d); hist.set(k, (hist.get(k) || 0) + 1);
  if (d > 12 && ex.length < 400) ex.push([d, x.mispar_rechev, a.n, a.y, x.rishum_rishon_dt, a.a, x.mkoriut_nm, a.t, a.b]);
});
console.log("tech rows", n, "joined", both, "active w/o moed", noA);
console.log("diff months (registration - on road):", JSON.stringify([...hist]));
ex.sort((p, q) => q[0] - p[0]);
const fmt = m => `${Math.floor(m / 12)}-${m % 12 + 1}`;
for (const e of ex.slice(0, 40)) console.log(`d=${e[0]} plate=${e[1]} ${e[2]} y=${e[3]} reg=${e[4]} road=${fmt(e[5])} mkoriut=${e[6]} test=${e[7]} owner=${e[8]}`);
const byYear = new Map(); for (const e of ex) byYear.set(e[3], (byYear.get(e[3]) || 0) + 1); console.log("examples by model year", JSON.stringify([...byYear].sort()));
