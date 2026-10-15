// Quarterly "new models" data for the magazine: models whose first delivery in Israel fell in a calendar quarter (history from 2022-01 is only used to
// tell new from old), split into brand-new models and new versions of models already on sale, with each version's trim name, engine and list price.
// Sources (all Ministry of Transport open data): deliveries register (units per catalogue code and month), WLTP catalogue (trim name ramat_gimur, power, drive), price list (mehir).
// Exports newModels(quarter?) (needs network: runs on a GitHub runner) and the pure helpers used by the self-test: node new-models.mjs --selftest
const API = "https://data.gov.il/api/3/action/datastore_search";
const DELIV = "602ac32d-19c0-4b41-88e0-e3ce8a7e80b7", COUNTS = "5e87a7a1-2f6f-41c1-8aec-7216d52a6cf6", WLTP = "142afde2-6228-49f9-8a29-9b6c3a0cbe40", PRICE = "39f455bf-6db0-4926-859d-017f34eacbcb";
const PAGE = 30000, MIN_UNITS = 25;
const ORD = ["הראשון", "השני", "השלישי", "הרביעי"];

async function call(id, params, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(API + "?" + new URLSearchParams({ resource_id: id, ...params }), { signal: AbortSignal.timeout(90000) }); const j = await r.json(); if (j.success) return j.result; } catch {}
    await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }
  throw new Error("failed " + id + " " + JSON.stringify(params).slice(0, 100));
}
async function scan(id, extra, onRows) {
  for (let off = 0; ; off += PAGE) {
    const r = await call(id, { limit: String(PAGE), offset: String(off), ...extra });
    if (!r.records.length) break;
    if (onRows(r.records) === false || r.records.length < PAGE) break;
  }
}

// catalogue spelling folded to comparable tokens: upper case, "JAECOO7" and "JAECOO 7" the same, spaces collapsed
export const tokens = s => String(s || "").toUpperCase().replace(/([A-Z])(\d)/g, "$1 $2").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
// a name is a version of an older model when it shares all but its last word with it ("TIGGO 7 HEV" and "TIGGO 7 PRO"), or, for a one-word name, its first word ("BIGSTER" and "BIGSTER HYBRID"); returns the shared base name
export function versionOf(name, olderNames) {
  const t = tokens(name), need = Math.max(1, t.length - 1);
  for (const o of olderNames) { const u = tokens(o); if (u.length >= need && t.slice(0, need).every((w, i) => u[i] === w) && u.join(" ") !== t.join(" ")) return t.slice(0, need).join(" "); }
  return null;
}
export const quarterOf = m => String(m).slice(0, 4) + "Q" + Math.ceil(Number(String(m).slice(4)) / 3);
export const cleanTrim = s => String(s || "").replace(/\s+/g, " ").trim();
// the catalogue cuts some trim names to a fixed width ("TERRAMA 204", "ERRAMAR 1.5"): a first word that is a fragment of the model's first word is completed
export function fixTrim(trim, model) { const t = tokens(trim), m = tokens(model)[0]; if (t[0] && m && t[0] !== m && t[0].length >= 4 && m.includes(t[0])) t[0] = m; return t.join(" "); }
const driveLabel = (tech, fuel) => ({ "רכב חשמלי": "חשמלי", "היברידי רגיל": "היברידי", "PLUG IN": "פלאג-אין היברידי" }[String(tech).trim()] || String(fuel || "").trim());

export async function newModels(quarterArg) {
  const brand = {};
  await scan(COUNTS, { fields: "tozeret_cd,tozar" }, rows => { for (const r of rows) if (r.tozar) brand[r.tozeret_cd] = String(r.tozar).trim(); });
  const models = {}; let latest = 0;
  await scan(DELIV, { sort: "sgira_month desc", filters: JSON.stringify({ sug_degem: "P" }), fields: "sgira_month,tozeret_cd,degem_cd,tozeret_nm,kinuy_mishari,car_num" }, rows => {
    let go = true;
    for (const r of rows) {
      if (r.sgira_month < 202201) { go = false; continue; }
      latest = Math.max(latest, r.sgira_month);
      const mk = brand[r.tozeret_cd] || String(r.tozeret_nm).split(" ")[0], nm = tokens(r.kinuy_mishari).join(" "); if (!nm) continue;
      const k = mk + "|" + nm, m = String(r.sgira_month), n = Number(r.car_num) || 0, o = (models[k] ||= { brand: mk, name: nm, months: {}, codes: {} });
      o.months[m] = (o.months[m] || 0) + n; ((o.codes[r.tozeret_cd + "|" + r.degem_cd] ||= {})[m] = ((o.codes[r.tozeret_cd + "|" + r.degem_cd] || {})[m] || 0) + n);
    }
    return go;
  });
  // the quarter: given (2026Q2) or the latest one that is fully in the data
  let Y, Q;
  if (quarterArg) { Y = Number(quarterArg.slice(0, 4)); Q = Number(quarterArg.slice(5)); }
  else { const lq = quarterOf(latest); Y = Number(lq.slice(0, 4)); Q = Number(lq.slice(5)); if (latest % 100 < Q * 3) { Q--; if (!Q) { Q = 4; Y--; } } }
  const qm = [0, 1, 2].map(i => String(Y * 100 + (Q - 1) * 3 + 1 + i));
  if (latest < Number(qm[2])) return { Y, Q, closed: false, latest };
  const first = o => Object.keys(o.months).filter(m => o.months[m] > 0).sort()[0];
  const sum = (o, ms) => ms.reduce((t, m) => t + (o[m] || 0), 0);
  const detect = qs => {
    const older = {};   // brand -> names that were already on sale before the quarter
    for (const o of Object.values(models)) if ((first(o) || "9") < qs[0]) (older[o.brand] ||= []).push(o.name);
    const out = [];
    for (const o of Object.values(models)) {
      const f = first(o); if (!f || f < qs[0] || f > qs[2]) continue;
      const units = sum(o.months, qs); if (units < MIN_UNITS) continue;
      out.push({ ...o, first: f, units, versionOf: versionOf(o.name, older[o.brand] || []) });
    }
    return out;
  };
  const found = detect(qm);
  // the quarter before, for a comparison line (only when the register has at least two quarters of history before it)
  const pY = Q === 1 ? Y - 1 : Y, pQ = Q === 1 ? 4 : Q - 1, pm = [0, 1, 2].map(i => String(pY * 100 + (pQ - 1) * 3 + 1 + i));
  let prev = null;
  if (pm[0] >= "202207") { const pf = detect(pm); prev = { label: `הרבעון ${ORD[pQ - 1]} של ${pY}`, fresh: pf.filter(m => !m.versionOf).length, vers: pf.filter(m => m.versionOf).length }; }
  for (const m of found) {
    const byTrim = new Map(), importers = new Set();
    for (const [code, mo] of Object.entries(m.codes)) {
      if (!Object.values(mo).some(v => v > 0)) continue;
      const [t, g] = code.split("|"), flt = JSON.stringify({ tozeret_cd: t, degem_cd: g });
      const [w, p] = await Promise.all([call(WLTP, { filters: flt, limit: "1", sort: "shnat_yitzur desc" }), call(PRICE, { filters: flt, limit: "1", sort: "shnat_yitzur desc" })]);
      const x = w.records[0] || {}, pr = p.records[0] || {}, price = Number(pr.mehir) || 0, imp = String(pr.shem_yevuan || "").replace(/\s*בע"מ\s*$/, "").trim(); if (imp) importers.add(imp);
      const  tn = fixTrim(cleanTrim(x.ramat_gimur), m.name) || "ללא שם";
      const e = byTrim.get(tn) || { name: tn, lo: Infinity, hi: 0, hp: 0, drive: "" };
      if (price) { e.lo = Math.min(e.lo, price); e.hi = Math.max(e.hi, price); }
      e.hp = Math.max(e.hp, Number(x.koah_sus) || 0); e.drive ||= driveLabel(x.technologiat_hanaa_nm, x.delek_nm);
      byTrim.set(tn, e);
    }
    m.importers = [...importers];
    m.trims = [...byTrim.values()].sort((a, b) => (a.lo === Infinity) - (b.lo === Infinity) || a.lo - b.lo);
  }
  found.sort((a, b) => b.units - a.units);
  return { Y, Q, closed: true, latest, label: `הרבעון ${ORD[Q - 1]} של ${Y}`, slug: `newmodels-${Y}-q${Q}`, months: qm, prev, models: found };
}

if (process.argv.includes("--selftest")) {
  const ok = (c, m) => { if (!c) { console.log("selftest FAILED:", m); process.exit(1); } };
  ok(versionOf("FX HEV", ["FX EV", "TIGGO 7 PRO"]) === "FX", "FX HEV is a version of FX EV");
  ok(versionOf("ATTO 3 EVO", ["ATTO 3", "SEAL"]) === "ATTO 3", "ATTO 3 EVO");
  ok(versionOf("TIGGO 7 HEV", ["TIGGO 7 PRO"]) === "TIGGO 7", "TIGGO 7 HEV");
  ok(versionOf("C-HR PLUS", ["C-HR HYBRID"]) === "C-HR", "C-HR PLUS");
  ok(versionOf("BIGSTER", ["BIGSTER HYBRID"]) === "BIGSTER", "one word");
  ok(versionOf("ORA 5 SUV", ["ORA FUNKY CAT"]) === null, "ORA 5 SUV is not a version of ORA FUNKY CAT");
  ok(versionOf("TAYRON", ["TIGUAN", "TOUAREG"]) === null, "TAYRON is new");
  ok(fixTrim("ERRAMAR 1.5", "TERRAMAR") === "TERRAMAR 1.5" && fixTrim("TERRAMA 204", "TERRAMAR") === "TERRAMAR 204" && fixTrim("VIBE", "ORA 5 SUV") === "VIBE", "truncated trim");
  ok(tokens("JAECOO7 PHEV").join(" ") === "JAECOO 7 PHEV", "letter-digit split");
  ok(quarterOf("202609") === "2026Q3" && quarterOf("202601") === "2026Q1", "quarterOf");
  console.log("selftest ok");
}
