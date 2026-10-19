// The recall watchdog: after every catalogue build it checks that the app's recall answers still hold, and writes a Telegram line only when something
// changed (state next to the catalogue on the catalog-data branch, as catalog-rules.mjs keeps its own):
//  1. how far the ministry's per-car list of unfixed cars reaches (meta.recHz, recall-percar.mjs). In 10/2026 it stood at recalls opened up to 14.4.2026
//     while the recall list went on; the app then says "not yet known" for the newer recalls. A line when it stalls, moves on, or could not be read.
//  2. every recall row new since the last run, run through the app's own matcher (app-matcher.mjs, from index.html) against every catalogue model-year
//     of the makers that read it: a row that matches no model at all is a recall the app shows to no car (a typo, a new model name, a code). A line per run
//     with those rows, so a matching rule can be added. A row the per-car list ties to models is shown by the app through that link, and is not flagged.
//   OUT   catalogue directory written by catalog-build.mjs (default out)
//   PREV  previous recall-state.json (default: fetched from the catalog-data branch; missing = first run, no alert)
import fs from "node:fs";
import {appMatcher} from "./app-matcher.mjs";
const OUT = process.env.OUT || "out", PREV = process.env.PREV || "";
const RAW = "https://raw.githubusercontent.com/ddsabag/vehicle-app/catalog-data/recall-state.json";
const STALL = 20;   // recalls in the recall list newer than the per-car list's newest before the list counts as stalled
let prev = null;
if (PREV && fs.existsSync(PREV)) prev = JSON.parse(fs.readFileSync(PREV, "utf8"));
else if (!PREV) { try { const r = await fetch(RAW, {signal: AbortSignal.timeout(30000)}); if (r.ok) prev = await r.json(); } catch {} }
const first = !prev, seen = new Set(prev ? prev.seen : []);
// a failure here never blocks the catalogue: yesterday's state is kept and the alert says the check did not run
try { await check(); } catch (e) {
  console.log("recall check FAILED: " + (e && e.stack || e));
  try {
    if (prev) fs.writeFileSync(`${OUT}/recall-state.json`, JSON.stringify(prev));
    fs.writeFileSync(`${OUT}/recall-alert.txt`, `לוחית · בדיקת ריקולים\nהבדיקה היומית לא רצה (${String(e && e.message || e).slice(0, 160)}). הקטלוג פורסם כרגיל.`);
  } catch (w) { console.log("could not write the alert: " + w.message); }
}

async function check(){
const meta = JSON.parse(fs.readFileSync(`${OUT}/meta.json`, "utf8"));
const {matchModelRecalls, brandModels} = appMatcher();
const fmt = d => { const m = String(d || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(d || "?"); };

// 1. the per-car list's reach
const hz = meta.recHz || null, lines = [];
const ids = new Set(), rowsOf = new Map();   // every recall id in the recall files; maker code -> its rows
for (const cd of meta.rec || []) { const j = JSON.parse(fs.readFileSync(`${OUT}/r/${cd}.json`, "utf8")); rowsOf.set(cd, j); for (const r of j.rows) ids.add(Number(r.RECALL_ID)); }
const newer = hz ? [...ids].filter(id => id > hz.id).length : null;
const status = !hz ? "unread" : newer >= STALL ? "stalled" : "ok";
console.log(hz ? `per-car list: newest recall ${hz.id} opened ${hz.d}; ${newer} recalls of the recall list are newer (${status})` : "per-car list: not read in this build");
const known = status === "unread" ? (prev && prev.known) || null : status;   // the last state that was read, so a day the list could not be read changes nothing
if (!first) {
  if (status === "unread") { if (prev.status !== "unread") lines.push("רשימת משרד התחבורה של רכבים שלא תוקנו לא נקראה בבנייה של היום. האפליקציה ממשיכה עם הגבול האחרון שידוע לה."); }
  else if (prev.id && hz.id !== prev.id) lines.push(status === "ok" ? `רשימת משרד התחבורה של רכבים שלא תוקנו התעדכנה: היא כוללת עכשיו ריקולים עד ${fmt(hz.d)}, ואין פער מול רשימת הריקולים.` : `רשימת משרד התחבורה של רכבים שלא תוקנו התקדמה לריקולים שנפתחו עד ${fmt(hz.d)}, ועדיין יש ${newer} ריקולים חדשים יותר.`);
  else if (prev.known && status !== prev.known) lines.push(status === "stalled" ? `רשימת משרד התחבורה של רכבים שלא תוקנו נעצרה בריקולים שנפתחו עד ${fmt(hz.d)}, וברשימת הריקולים יש ${newer} ריקולים חדשים יותר. האפליקציה מציגה אותם כ"עוד לא ידוע אם כולל את הרכב".` : `רשימת משרד התחבורה של רכבים שלא תוקנו השלימה את הפער: היא כוללת ריקולים עד ${fmt(hz.d)}.`);
}

// 2. new recall rows that match no model-year of any maker that reads them
const rowKey = r => `${r.RECALL_ID}|${String(r.TOZAR_TEUR || "").trim()}|${String(r.DEGEM || "").trim()}`;
const fresh = new Map();   // row key -> {row, makers: [cd], hit: false}
for (const [cd, j] of rowsOf) for (const r of j.rows) { const k = rowKey(r); if (seen.has(k)) continue; const e = fresh.get(k) || {row: r, makers: [], hit: !!(j.l && j.l[r.RECALL_ID])}; e.makers.push(cd); if (j.l && j.l[r.RECALL_ID]) e.hit = true; fresh.set(k, e); }
if (!first && fresh.size) {
  const byMaker = new Map(); for (const e of fresh.values()) if (!e.hit) for (const cd of e.makers) { if (!byMaker.has(cd)) byMaker.set(cd, new Set()); byMaker.get(cd).add(Number(e.row.RECALL_ID)); }
  for (const [cd, want] of byMaker) {
    const idx = JSON.parse(fs.readFileSync(`${OUT}/c/${cd}.json`, "utf8")), C = Object.fromEntries(idx.cols.map((c, i) => [c, i])), rows = rowsOf.get(cd).rows, vs = new Map();
    for (const [, [f]] of Object.entries(idx.models)) for (const a of JSON.parse(fs.readFileSync(`${OUT}/c/${cd}/${f}.json`, "utf8")).rows) {
      const k = [a[C.kinuy_mishari], a[C.degem_nm], a[C.shnat_yitzur], a[C.technologiat_hanaa_nm], a[C.delek_nm], a[C.merkav]].join("|");
      if (!vs.has(k)) vs.set(k, {v: {kinuy_mishari: a[C.kinuy_mishari], degem_nm: a[C.degem_nm], shnat_yitzur: a[C.shnat_yitzur], sug_degem: a[C.sug_degem], tozeret_nm: idx.n, tozeret_cd: cd},
        w: {technologiat_hanaa_nm: a[C.technologiat_hanaa_nm], delek_nm: a[C.delek_nm], merkav: a[C.merkav]}});
    }
    for (const {v, w} of vs.values()) for (const h of matchModelRecalls(rows, v, brandModels(meta, v), w)) if (want.has(Number(h.RECALL_ID))) { const e = fresh.get(rowKey(h)); if (e) e.hit = true; }
  }
}
// motorcycles and heavy trucks filed under a car brand (BMW Motorrad, Mercedes Actros, Ford F-250 and up, RAM 2500 and up) are not in the catalogue,
// which holds the WLTP models; such a row matches no model by design and is left out of the alert
const NOT_CARS = /MOTOR+AD|\bK-?1[2-6]00\b|\b[RSM]\s?1[0-3]00\b|\bGL\s?1800\b|ACTROS|AROCS|ATEGO|ECONIC|UNIMOG|\bTG[LMSX]\b|\bF-?(2|3|4|5|6|7)50\b|\bF-?600\b|\b[2-5]500\b|SAVANA/;
const orphans = first ? [] : [...fresh.values()].filter(e => !e.hit && !NOT_CARS.test(String(e.row.DEGEM || "").toUpperCase())).map(e => e.row);
console.log(`recall rows new since the last run: ${first ? "first run, none compared" : fresh.size}; matching no model: ${first ? "-" : orphans.length}`);
for (const r of orphans) console.log(`  ${r.RECALL_ID} ${String(r.TOZAR_TEUR || "").trim()} "${String(r.DEGEM || "").trim()}" built ${r.BUILD_BEGIN_A || "?"}..${r.BUILD_END_A || "?"}`);
if (!first && orphans.length) lines.push(`${orphans.length === 1 ? "ריקול חדש שלא נמצא לו דגם" : `${orphans.length} ריקולים חדשים שלא נמצא להם דגם`} באפליקציה (צריך כלל התאמה): ` + orphans.slice(0, 6).map(r => `${r.RECALL_ID} ${String(r.TOZAR_TEUR || "").trim()} "${String(r.DEGEM || "").trim()}"`).join(", ") + (orphans.length > 6 ? ` ועוד ${orphans.length - 6}` : "") + ".");

fs.writeFileSync(`${OUT}/recall-state.json`, JSON.stringify({u: meta.u, status, known, id: hz ? hz.id : (prev && prev.id) || null, seen: [...new Set([...seen, ...fresh.keys()])]}));
if (lines.length) {
  const msg = [`לוחית · בדיקת ריקולים ${meta.u}`, ...lines].join("\n");
  fs.writeFileSync(`${OUT}/recall-alert.txt`, msg);
  console.log("\n" + msg);
}
}
