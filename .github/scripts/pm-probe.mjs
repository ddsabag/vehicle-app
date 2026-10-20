// models.json (the free-text model matcher, budget search and SEO model pages) takes a model name's "from" price as the lowest list price of
// its newest year over the price list's rows of every type: how many names get a commercial (M) row's price where a private (P) one exists (20.10).
// Read-only, prints aggregates and model names only (no plates).
const API = "https://data.gov.il/api/3/action/datastore_search", PRICE = "39f455bf-6db0-4926-859d-017f34eacbcb", PAGE = 30000;
import fs from "node:fs";
// the same name rules as models.mjs, read from it
const src = fs.readFileSync(".github/scripts/models.mjs", "utf8");
const COUNTRY = (0, eval)(src.match(/^const COUNTRY = (.*);$/m)[1]), NOISE = (0, eval)(src.match(/^const NOISE = (.*);$/m)[1]);
const norm = m => { const t = String(m || "").trim().toUpperCase().replace(/\s+/g, " ").split(" "); const k = t.filter(x => !NOISE.has(x)); return (k.length ? k : t).join(" "); };
const rows = [];
for (let off = 0; ; off += PAGE) {
  let j = null;
  for (let i = 0; i < 4 && !j; i++) { try { const r = await (await fetch(`${API}?` + new URLSearchParams({ resource_id: PRICE, limit: String(PAGE), offset: String(off), fields: "tozeret_nm,tozeret_eretz_nm,kinuy_mishari,degem_nm,shnat_yitzur,mehir,sug_degem" }), { signal: AbortSignal.timeout(120000) })).json(); if (r.success) j = r.result; } catch {} if (!j) await new Promise(r => setTimeout(r, 5000 * (i + 1))); }
  if (!j) { console.log("price list read failed at", off); process.exit(0); }
  rows.push(...j.records); if (j.records.length < PAGE) break;
  await new Promise(r => setTimeout(r, 2000));
}
console.log("price list rows", rows.length, "types", JSON.stringify(rows.reduce((o, r) => { const t = String(r.sug_degem || "").trim().toUpperCase() || "-"; o[t] = (o[t] || 0) + 1; return o; }, {})));
const per = new Map();
for (const x of rows) {
  let mk = String(x.tozeret_nm || "").trim(); const c = String(x.tozeret_eretz_nm || "").trim();
  if (c && mk.endsWith(" " + c)) mk = mk.slice(0, -c.length - 1);
  mk = mk.replace(COUNTRY, "");
  const md = norm(x.kinuy_mishari || x.degem_nm), y = Number(x.shnat_yitzur) || 0, mh = Number(x.mehir) || 0; if (!mk || !md || !y || !(mh > 0)) continue;
  const o = per.get(mk + "|" + md) || { top: 0, list: [] }; o.top = Math.max(o.top, y); o.list.push({ y, mh, t: String(x.sug_degem || "").trim().toUpperCase() }); per.set(mk + "|" + md, o);
}
let names = 0, mixed = 0, differ = 0; const ex = [];
for (const [k, o] of per) {
  names++;
  const top = o.list.filter(r => r.y === o.top), all = Math.min(...top.map(r => r.mh)), p = top.filter(r => r.t === "P");
  if (!p.length || p.length === top.length) continue;
  mixed++;
  const priv = Math.min(...p.map(r => r.mh));
  if (priv !== all) { differ++; ex.push([k, o.top, all, priv]); }
}
console.log(`model names with a price: ${names}; newest year has private and other rows: ${mixed}; the "from" price comes from a non-private row: ${differ}`);
ex.sort((a, b) => (b[3] - b[2]) - (a[3] - a[2]));
for (const [k, y, all, priv] of ex.slice(0, 15)) console.log(`  ${k} ${y}: from ${all} today, private from ${priv} (${Math.round(100 * (priv - all) / priv)}% lower today)`);
console.log("done", new Date().toISOString());
