// The ministry's per-car list of unfixed cars (36bf1404) read two ways, for catalog-build.mjs (the app reads both from the catalogue) and recall-health.mjs:
//  1. how far it reaches into the recall list (2c33523f). It can lag: in 10/2026 it held recalls opened up to 14.4.2026 (RECALL_ID 16576) while the recall
//     list ran to 16821, and a recall opened in the months before that was often not in it yet (2026 recalls: 37% in it, 2024 and 2025: 55-57%). For such a
//     recall the list says nothing about a plate: the app says "not yet known if this car is included", never "not open on this car".
//  2. which models and years each recall holds: every plate in it looked up in the active and inactive registers. A recall that holds cars of a model and
//     year applies to that year whatever the recall list's free text says (the text often leaves a model out, or gives a build range that misses years),
//     and 411 of its 1,916 recalls were not in the recall list at all (19.10.2026). Counts only; no plate leaves this module.
//   hz    {id: newest RECALL_ID in the list, d: its opening date, from: the first RECALL_ID opened in the 90 days before it, ids: the list's RECALL_IDs from
//          `from` on, n: recalls in the list, rows}
//   info  Map RECALL_ID -> {n: plates, d: opening date, SUG_RECALL, SUG_TAKALA, TEUR_TAKALA}
//   links Map register maker code -> Map RECALL_ID -> Map linkKey -> cars;  found: plates found in a register, plates: plates in the list
export const PER_CAR = "36bf1404-0be4-49d2-82dc-2f1ead4a8b93";
const REGISTERS = {active: "053cea08-09bc-40ec-8f7a-156f0677aff3", inactive: "f6efe89a-fb3d-43a4-bb61-9bf12a9b9099"};
export const LAG_DAYS = 90;
// model + production year of a register row; index.html keys the car the same way (linkKey there)
export const linkKey = r => String(r.kinuy_mishari || r.degem_nm || "").trim().toUpperCase().replace(/\s+/g, " ") + "|" + (Number(r.shnat_yitzur) || "");
const s = v => v === null || v === undefined ? "" : String(v).trim();
const day = v => {
  const t = s(v); let m;
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})/))) return m[0];
  if ((m = t.match(/^(\d{4})(\d{2})(\d{2})$/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return "";
};
// scan(resourceId, fields, onRows) is the calling script's own pager; log(message) its log
export async function perCarRecalls(scan, log = () => {}) {
  const byPlate = new Map(), info = new Map(); let rows = 0;
  await scan(PER_CAR, "MISPAR_RECHEV,RECALL_ID,SUG_RECALL,SUG_TAKALA,TEUR_TAKALA,TAARICH_PTICHA", recs => {
    for (const r of recs) {
      rows++; const id = Number(r.RECALL_ID), p = Number(s(r.MISPAR_RECHEV).replace(/\D/g, "")); if (!id) continue;
      const d = day(r.TAARICH_PTICHA), e = info.get(id);
      if (!e) info.set(id, {n: 0, d, SUG_RECALL: s(r.SUG_RECALL), SUG_TAKALA: s(r.SUG_TAKALA), TEUR_TAKALA: s(r.TEUR_TAKALA)}); else if (d && (!e.d || d < e.d)) e.d = d;
      if (!p) continue;
      let ids = byPlate.get(p); if (!ids) byPlate.set(p, ids = new Set());
      if (!ids.has(id)) { ids.add(id); info.get(id).n++; }
    }
  });
  if (rows < 1000 || info.size < 100) throw new Error(`per-car recall list implausibly small: ${rows} rows, ${info.size} recalls`);
  const id = Math.max(...info.keys()), d = info.get(id).d;
  if (!d) throw new Error(`per-car recall list: no opening date for RECALL_ID ${id}`);
  const cut = new Date(Date.parse(d) - LAG_DAYS * 864e5).toISOString().slice(0, 10);
  const from = Math.min(id, ...[...info.entries()].filter(([, e]) => e.d && e.d >= cut).map(([k]) => k));
  const hz = {id, d, from, ids: [...info.keys()].filter(k => k >= from).sort((a, b) => a - b), n: info.size, rows};
  log(`per-car list: ${rows} rows, ${byPlate.size} plates, ${info.size} recalls, newest ${id} opened ${d}`);

  const links = new Map(), found = new Set();
  for (const [name, res] of Object.entries(REGISTERS)) {
    let hit = 0;
    const n = await scan(res, "mispar_rechev,tozeret_cd,degem_nm,kinuy_mishari,shnat_yitzur", recs => {
      for (const r of recs) {
        const p = Number(s(r.mispar_rechev).replace(/\D/g, "")), ids = byPlate.get(p); if (!ids || found.has(p)) continue;
        found.add(p); hit++;
        const cd = s(r.tozeret_cd), key = linkKey(r); if (!cd || key.startsWith("|")) continue;
        let m = links.get(cd); if (!m) links.set(cd, m = new Map());
        for (const rid of ids) { let k = m.get(rid); if (!k) m.set(rid, k = new Map()); k.set(key, (k.get(key) || 0) + 1); }
      }
    });
    log(`${name} register: ${n} rows, ${hit} plates of the per-car list`);
    if (name === "active" && n < 1e6) throw new Error(`active register implausibly small: ${n}`);
  }
  return {hz, info, links, found: found.size, plates: byPlate.size};
}
