// The recall watchdog: after every catalogue build it mends what the build lost, checks that the app's recall answers still hold, and writes a
// Telegram line only when something needs a person (state next to the catalogue on the catalog-data branch, as catalog-rules.mjs keeps its own):
//  0. mends, from the catalogue published the day before (the catalog-data branch): a day the ministry's per-car list could not be read (no meta.recHz),
//     its reach, the recalls it holds (recIn) and what it ties to models (l, and the recalls only it holds, in x) are taken from the files of the day
//     before; a maker that had a recall file and has none today keeps the one of the day before. The app answers as the day before; a line comes only
//     when that lasts MEND_DAYS builds.
//  1. how far the ministry's per-car list of unfixed cars reaches (meta.recHz, recall-percar.mjs). In 10/2026 it stood at recalls opened up to 14.4.2026
//     while the recall list went on; the app then says "not yet known" for the newer recalls. A line when it stalls or moves on.
//  2. every recall row new since the last run, run through the app's own matcher (app-matcher.mjs, from index.html) against every catalogue model-year
//     of the makers that read it: a row that matches no model at all is a recall the app shows to no car (a typo, a new model name, a code). Left out of
//     the line: a row the per-car list ties to models (the app shows it through that link); a variant the catalogue does not hold, which matches once the
//     drive is ignored (F-150 BEV against the petrol F-150s); a model the catalogue does not hold at all (no model of those makers shares a word with it:
//     a personal import, a motorcycle), which the app matches against the car's own record. What is left needs a matching rule, and the line names the
//     catalogue models that share a word with it. On the recalls of 19.10.2026 none of the 216 newer than the per-car list was left.
//  3. a maker that had a recall file and has none today: mended in 0 (a line when that lasts MEND_DAYS builds), or a line at once when it cannot be.
//   OUT       catalogue directory written by catalog-build.mjs (default out)
//   PREV      previous recall-state.json (default: fetched from the catalog-data branch; missing = first run, no alert)
//   PREV_CAT  the catalogue of the day before, as a directory (tests; default: the catalog-data branch)
import fs from "node:fs";
import {appMatcher} from "./app-matcher.mjs";
import {msg, heError} from "./tg-text.mjs";
const OUT = process.env.OUT || "out", PREV = process.env.PREV || "", PREV_CAT = process.env.PREV_CAT || "";
const CAT = "https://raw.githubusercontent.com/ddsabag/vehicle-app/catalog-data/";
const STALL = 20;   // recalls in the recall list newer than the per-car list's newest before the list counts as stalled
const MEND_DAYS = 3;   // builds in a row on the day before's copy before a line says so
// the line again every 7 builds while it lasts, so a mend that never ends is not told once and then forgotten
const due = n => n === MEND_DAYS || n > MEND_DAYS && (n - MEND_DAYS) % 7 === 0;
async function prevCat(p){   // a file of the catalogue published the day before; null when it has none or cannot be read
  if (PREV_CAT) { const f = `${PREV_CAT}/${p}`; return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; }
  for (let i = 0; i < 3; i++) { try { const r = await fetch(CAT + p, {signal: AbortSignal.timeout(30000)}); if (r.status === 404) return null; if (r.ok) return await r.json(); } catch {} }
  return null;
}
let prev = null;
if (PREV && fs.existsSync(PREV)) prev = JSON.parse(fs.readFileSync(PREV, "utf8"));
else if (!PREV) prev = await prevCat("recall-state.json").catch(() => null);
const first = !prev, seen = new Set(prev ? prev.seen : []);
// a failure here never blocks the catalogue: yesterday's state is kept and the alert says the check did not run
let checked = false, acts = 0;
try { acts = await check(); checked = true; } catch (e) {
  console.log("recall check FAILED: " + (e && e.stack || e));
  try {
    if (prev) fs.writeFileSync(`${OUT}/recall-state.json`, JSON.stringify(prev));
    fs.writeFileSync(`${OUT}/recall-alert.txt`, msg({kind: "today", area: "data", title: "בדיקת הריקולים היומית לא רצה", text: `${heError(String(e && e.message || e)).split("\n<blockquote")[0]} הקטלוג פורסם כרגיל, והאפליקציה מציגה ריקולים כמו אתמול.`,
      what: "כלום. אם זה חוזר, זה עובר לבד לטיפול בשרשור \"נתונים ואמינות\".", raw: String(e && e.stack || e)}));
  } catch (w) { console.log("could not write the alert: " + w.message); }
}
// a check with nothing for a person closes the open recall alert; the router tells it once ("✅ בוצע · חזר לתקין") and the morning ledger lists it
if (checked && !acts && process.env.GITHUB_TOKEN && process.env.DRY_RUN !== "1")
  try { const n = await (await import("./alert.mjs")).resolve(["recalls"]); if (n) console.log(`closed ${n} recall alert(s)`); } catch { /* the morning ledger still lists it */ }

async function check(){
const meta = JSON.parse(fs.readFileSync(`${OUT}/meta.json`, "utf8"));
const {matchModelRecalls, brandModels} = appMatcher();
const fmt = d => { const m = String(d || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(d || "?"); };
const files = new Map(), all = j => j.x ? j.rows.concat(j.x) : j.rows;   // maker code -> its recall file; its rows + x, as the app reads them
for (const cd of meta.rec || []) files.set(cd, JSON.parse(fs.readFileSync(`${OUT}/r/${cd}.json`, "utf8")));
const lines = [], act = [], raw = [], need = t => { lines.push(t); act.push(t); }, nm = cd => (meta.makers[cd] && meta.makers[cd].n) || cd, few = (xs, f) => xs.slice(0, 6).map(f).join(", ") + (xs.length > 6 ? ` ועוד ${xs.length - 6}` : "");

// 0. what today's build lost, from the catalogue of the day before
const pm = await prevCat("meta.json"), was = (prev && prev.carry) || {hz: 0, makers: {}}, carry = {hz: 0, makers: {}}, hzRead = !!meta.recHz;
if (!pm) console.log("the catalogue of the day before could not be read: nothing mended");
else {
  let changed = false;
  for (const cd of pm.rec || []) {   // a maker whose brand's rows could not be read or named today
    if (files.has(cd) || !meta.makers[cd]) continue;
    const j = await prevCat(`r/${cd}.json`); if (!j || !j.rows) continue;
    fs.writeFileSync(`${OUT}/r/${cd}.json`, JSON.stringify(j)); files.set(cd, j); (meta.rec = meta.rec || []).push(cd); changed = true;
    carry.makers[cd] = (was.makers[cd] || 0) + 1;
  }
  if (Object.keys(carry.makers).length) console.log("recall files kept from the day before: " + Object.keys(carry.makers).map(nm).join(", "));
  if (!hzRead && pm.recHz) {   // the per-car list could not be read today: its reach, links and own recalls of the day before
    const todo = [...files].filter(([cd]) => !carry.makers[cd]); let mended = 0;
    for (let i = 0; i < todo.length; i += 16) await Promise.all(todo.slice(i, i + 16).map(async ([cd, j]) => {
      const y = await prevCat(`r/${cd}.json`); if (!y || !y.l) return;
      const have = new Set(all(j).map(r => Number(r.RECALL_ID))), more = (y.x || []).filter(r => !have.has(Number(r.RECALL_ID)));
      j.l = y.l; if (more.length) j.x = (j.x || []).concat(more);
      fs.writeFileSync(`${OUT}/r/${cd}.json`, JSON.stringify(j)); mended++;
    }));
    const max = [...files.values()].reduce((m, j) => all(j).reduce((a, r) => Math.max(a, Number(r.RECALL_ID) || 0), m), pm.recHz.max || 0);
    meta.recHz = {...pm.recHz, max, u: pm.recHz.u || pm.u}; changed = true;
    if (pm.recIn && !meta.recIn) meta.recIn = pm.recIn;   // which recalls the list holds at all, as read that day
    carry.hz = (was.hz || 0) + 1;
    console.log(`per-car list not read in this build: its reach and links as read on ${meta.recHz.u} (${mended} recall files mended)`);
  }
  if (changed) fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta));
}

// 1. the per-car list's reach
const hz = meta.recHz || null, ids = new Set();   // every recall id in the recall files
for (const j of files.values()) for (const r of all(j)) ids.add(Number(r.RECALL_ID));
const newer = hz ? [...ids].filter(id => id > hz.id).length : null;
const status = !hzRead ? "unread" : newer >= STALL ? "stalled" : "ok";
console.log(hzRead ? `per-car list: newest recall ${hz.id} opened ${hz.d}; ${newer} recalls of the recall list are newer (${status})` : "per-car list: not read in this build");
const known = status === "unread" ? (prev && prev.known) || null : status;   // the last state that was read, so a day the list could not be read changes nothing
if (!first) {
  if (status === "unread") {
    if (!hz) { if (prev.status !== "unread") lines.push("רשימת משרד התחבורה של רכבים שלא תוקנו לא נקראה בבנייה של היום, ואין עותק קודם שלה. האפליקציה ממשיכה עם הגבול האחרון שידוע לה."); }
    else if (due(carry.hz)) need(`רשימת משרד התחבורה של רכבים שלא תוקנו לא נקראה ${carry.hz} ימים ברצף. האפליקציה ממשיכה לשייך ריקולים לדגמים לפי העותק מ-${fmt(hz.u)}, וזה בסדר לכמה ימים. אם זה נמשך, צריך לבדוק למה הקריאה נכשלת.`);
  }
  else if (prev.id && hz.id !== prev.id) lines.push(status === "ok" ? `רשימת משרד התחבורה של רכבים שלא תוקנו התעדכנה: היא כוללת עכשיו ריקולים עד ${fmt(hz.d)}, ואין פער מול רשימת הריקולים.` : `רשימת משרד התחבורה של רכבים שלא תוקנו התקדמה לריקולים שנפתחו עד ${fmt(hz.d)}, ועדיין יש ${newer} ריקולים חדשים יותר.`);
  else if (prev.known && status !== prev.known) lines.push(status === "stalled" ? `רשימת משרד התחבורה של רכבים שלא תוקנו נעצרה בריקולים שנפתחו עד ${fmt(hz.d)}, וברשימת הריקולים יש ${newer} ריקולים חדשים יותר. האפליקציה מציגה אותם כ"עוד לא ידוע אם כולל את הרכב".` : `רשימת משרד התחבורה של רכבים שלא תוקנו השלימה את הפער: היא כוללת ריקולים עד ${fmt(hz.d)}.`);
}

// 2. new recall rows that match no model-year of any maker that reads them
const rowKey = r => `${r.RECALL_ID}|${String(r.TOZAR_TEUR || "").trim()}|${String(r.DEGEM || "").trim()}`;
const fresh = new Map();   // row key -> {row, makers: [cd], hit, variant, near}
for (const [cd, j] of files) for (const r of all(j)) { const k = rowKey(r); if (seen.has(k)) continue; const e = fresh.get(k) || {row: r, makers: [], hit: false}; e.makers.push(cd); if (j.l && j.l[r.RECALL_ID]) e.hit = true; fresh.set(k, e); }
// a word of a model name; the drive words say nothing about which model it is
const DRIVE = /^(BEV|PHEV|MHEV|HEV|HYBRID|PLUG|ELECTRIC|DIESEL|PETROL|GASOLINE|TURBO|AWD|4WD|2WD|4X4|4X2)$/;
const words = s => String(s || "").toUpperCase().split(/[^A-Z0-9א-ת]+/).filter(t => t.length >= 3 && !DRIVE.test(t));
if (!first && fresh.size) {
  const byMaker = new Map(); for (const e of fresh.values()) if (!e.hit) for (const cd of e.makers) { if (!byMaker.has(cd)) byMaker.set(cd, new Set()); byMaker.get(cd).add(Number(e.row.RECALL_ID)); }
  for (const [cd, want] of byMaker) {
    const idx = JSON.parse(fs.readFileSync(`${OUT}/c/${cd}.json`, "utf8")), C = Object.fromEntries(idx.cols.map((c, i) => [c, i])), rows = all(files.get(cd)), vs = new Map();
    for (const [, [f]] of Object.entries(idx.models)) for (const a of JSON.parse(fs.readFileSync(`${OUT}/c/${cd}/${f}.json`, "utf8")).rows) {
      const k = [a[C.kinuy_mishari], a[C.degem_nm], a[C.shnat_yitzur], a[C.technologiat_hanaa_nm], a[C.delek_nm], a[C.merkav]].join("|");
      if (!vs.has(k)) vs.set(k, {v: {kinuy_mishari: a[C.kinuy_mishari], degem_nm: a[C.degem_nm], shnat_yitzur: a[C.shnat_yitzur], sug_degem: a[C.sug_degem], tozeret_nm: idx.n, tozeret_cd: cd},
        w: {technologiat_hanaa_nm: a[C.technologiat_hanaa_nm], delek_nm: a[C.delek_nm], merkav: a[C.merkav]}});
    }
    const mark = (w, f) => { for (const {v, w: vw} of vs.values()) for (const h of matchModelRecalls(rows, v, brandModels(meta, v), w || vw)) if (want.has(Number(h.RECALL_ID))) { const e = fresh.get(rowKey(h)); if (e) f(e); } };
    mark(null, e => { e.hit = true; });
    const left = e => !e.hit && !e.variant && e.makers.includes(cd);
    if ([...fresh.values()].some(left)) mark({}, e => { if (!e.hit) e.variant = true; });   // the same model-years with the drive left out
    const names = Object.keys(idx.models).map(n => [n, words(n)]);
    for (const e of fresh.values()) if (left(e)) { const ws = words(e.row.DEGEM); for (const [n, nw] of names) if (nw.some(t => ws.includes(t))) (e.near = e.near || new Set()).add(n); }
  }
}
// 3. makers that lost their recall file: kept from the day before (0), or gone when there was none to keep
const lost = first || !prev.rec ? [] : prev.rec.filter(cd => !(meta.rec || []).includes(cd));
if (lost.length) { console.log("makers that lost their recall file: " + lost.map(nm).join(", "));
  need(lost.length === 1 ? `קובץ הריקולים של היצרן ${few(lost, nm)} לא נבנה היום (בבדיקה הקודמת היה), ולכן הרכבים שלו מוצגים בלי ריקולים לדגם.`
    : `קובצי הריקולים של ${lost.length} יצרנים לא נבנו היום (בבדיקה הקודמת היו), ולכן הרכבים שלהם מוצגים בלי ריקולים לדגם: ${few(lost, nm)}.`); }
const long = Object.keys(carry.makers).filter(cd => due(carry.makers[cd])), most = Math.max(0, ...long.map(cd => carry.makers[cd]));
if (!first && long.length) need(`${long.length === 1 ? `קובץ הריקולים של היצרן ${few(long, nm)} לא נבנה` : `קובצי הריקולים של ${long.length} יצרנים לא נבנו`} ${most} ימים ברצף. האפליקציה מציגה את העותק האחרון שנבנה, בלי ריקולים שנוספו מאז, וצריך לבדוק למה${long.length === 1 ? "" : `: ${few(long, nm)}`}.`);
// motorcycles and heavy trucks filed under a car brand (BMW Motorrad, Mercedes Actros, Ford F-250 and up, RAM 2500 and up) are not in the catalogue,
// which holds the WLTP models; such a row matches no model by design and is left out of the alert
const NOT_CARS = /MOTOR+A?D|\bK-?1[0-6]?00(?:[A-Z]{1,3})?\b|\b[RSM]\s?1[0-3]00(?:[A-Z]{1,3})?\b|\bGL\s?1800\b|\bNC\s*7[05]0|ACTROS|AROCS|ATEGO|ECONIC|UNIMOG|\bTG[LMSX]\b|\bF-?(2|3|4|5|6|7)50\b|\bF-?600\b|\b[2-5]500\b|SAVANA/;
const orphans = first ? [] : [...fresh.values()].filter(e => !e.hit && !NOT_CARS.test(String(e.row.DEGEM || "").toUpperCase()));
const gaps = orphans.filter(e => !e.variant && e.near);
console.log(`recall rows new since the last run: ${first ? "first run, none compared" : fresh.size}; matching no model: ${first ? "-" : orphans.length}, of them needing a matching rule: ${first ? "-" : gaps.length}`);
for (const e of orphans) { const r = e.row; console.log(`  ${r.RECALL_ID} ${String(r.TOZAR_TEUR || "").trim()} "${String(r.DEGEM || "").trim()}" built ${r.BUILD_BEGIN_A || "?"}..${r.BUILD_END_A || "?"}: ${e.variant ? "a variant the catalogue does not hold (matches with the drive left out)" : e.near ? "like " + [...e.near].slice(0, 4).join(" | ") : "a model the catalogue does not hold"}`); }
if (gaps.length) { need(`${gaps.length === 1 ? "ריקול חדש שלא נמצא לו דגם" : `${gaps.length} ריקולים חדשים שלא נמצא להם דגם`} באפליקציה, אף שיש דגם בשם דומה. צריך להוסיף כלל התאמה, ועד אז האפליקציה לא מציגה אותם לאף רכב.`);
  raw.push(few(gaps, e => `${e.row.RECALL_ID} ${String(e.row.TOZAR_TEUR || "").trim()} "${String(e.row.DEGEM || "").trim()}" ~ ${[...e.near].slice(0, 2).join(", ")}`)); }

fs.writeFileSync(`${OUT}/recall-state.json`, JSON.stringify({u: meta.u, status, known, id: hz ? hz.id : (prev && prev.id) || null, rec: meta.rec || [], carry, seen: [...new Set([...seen, ...fresh.keys()])]}));
if (lines.length) {
  // the Telegram standard (tg-text.mjs, HTML): to do today when a line needs a person, else for information (sent without a ring)
  const text = msg({kind: act.length ? "today" : "info", area: "data", title: act.length ? "בדיקת הריקולים מצאה משהו שצריך לבדוק" : "עדכון ברשימת הריקולים של משרד התחבורה",
    text: `${lines.join("\n")}\n(${fmt(meta.u)})`, what: act.length ? "כלום. זה עובר לבד לטיפול בשרשור \"נתונים ואמינות\", ועדכון יגיע כשזה מטופל." : "", raw: raw.join("; ")});
  fs.writeFileSync(`${OUT}/recall-alert.txt`, text);
  console.log("\n" + text);
}
return act.length;
}
