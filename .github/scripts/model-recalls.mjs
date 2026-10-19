// The "recalls published for the model" section of the static model pages (pages.mjs): the Ministry of Transport's recall list rows that
// the app's own matcher ties to the model's commercial names, limited to recalls whose build years overlap the vintages on the page.
// Matcher: .github/scripts/app-matcher.mjs when the repo has it (the full matcher with every helper it calls, from next d51617b5 on), else the
// four functions of the older index.html (as recall-probe.mjs read them). Rows come from the catalog-data branch (r/<maker code>.json, rebuilt
// daily by catalog.yml): "rows" (the maker's own brands) always, "x" (sister brands, recalls only the per-car list has) only with the full
// matcher, as the app does. The workflows put that branch's r/ folder and meta.json in CAT_DIR (default cat-data). When the files or the
// matcher are missing, recallBuilder says why and pages.mjs builds the pages without the section, so a page run never fails for it.
// Text only, no links (links are under the 21-day rule, see analytics/seo-changes.json).
//   node .github/scripts/model-recalls.mjs selftest      offline
import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";

const num = v => Number(String(v).replace(/,/g, ""));
const norm = s => String(s || "").toUpperCase().replace(/[^A-Z0-9\u0590-\u05FF]/g, "");
const recallYear = x => { const m = String(x || "").match(/(19|20)\d{2}/); return m ? +m[0] : null; };

export async function loadMatcher(dir = ".github/scripts", html = "index.html") {
  try {
    if (fs.existsSync(`${dir}/app-matcher.mjs`)) {
      const a = (await import(pathToFileURL(path.resolve(dir, "app-matcher.mjs")).href)).appMatcher(html);
      return {kind: "app-matcher.mjs", extra: true, match: (rows, v, models) => a.matchModelRecalls(rows, v, models, null), brandModels: a.brandModels};
    }
    const src = fs.readFileSync(html, "utf8"), part = k => {
      const i = src.indexOf(k); if (i < 0) throw new Error("not in index.html: " + k);
      if (k.startsWith("const")) return src.slice(i, src.indexOf("\n", i));
      let d = 0, j = src.indexOf("{", i);
      for (; j < src.length; j++) { if (src[j] === "{") d++; else if (src[j] === "}" && --d === 0) break; }
      return src.slice(i, j + 1);
    };
    const o = new Function(["const num =", "const norm =", "function recallYear", "function matchModelRecalls"].map(part).join("\n") + "\nreturn {matchModelRecalls};")();
    o.matchModelRecalls([], {kinuy_mishari: "X", degem_nm: "", shnat_yitzur: ""}, null);   // throws now, not mid-run, if it needs a helper it was not given
    return {kind: "index.html", extra: false, match: (rows, v, models) => o.matchModelRecalls(rows, v, models), brandModels: null};
  } catch (e) { return {error: e.message || String(e)}; }
}

const ROOT = () => process.env.CAT_DIR || "cat-data";
export const haveRecalls = (root = ROOT()) => { try { return fs.readdirSync(`${root}/r`).some(f => f.endsWith(".json")); } catch { return false; } };
// the catalogue's maker index (meta.json: maker code -> {n: registry name, m: model names, y: their years}), or null
export const catMeta = (root = ROOT()) => { try { const j = JSON.parse(fs.readFileSync(`${root}/meta.json`, "utf8")); return j && j.makers ? j : null; } catch { return null; } };
// one maker's recall rows, the same array every time (the full matcher caches its parse of a list by the array)
export function makerFiles(root = ROOT(), extra = false) {
  const memo = new Map();
  return cd => {
    if (!memo.has(cd)) { let rows = null; try { const j = JSON.parse(fs.readFileSync(`${root}/r/${cd}.json`, "utf8")); rows = j.rows ? (extra && Array.isArray(j.x) ? j.rows.concat(j.x) : j.rows) : null; } catch {} memo.set(cd, rows); }
    return memo.get(cd);
  };
}

// cds: the maker codes of the model's rows; names: its commercial names as registered (COROLLA, COROLLA HSD SDN); lo/hi: the page's vintages;
// make: the registry maker name (טויוטה יפן); models: every model name of the brand, normalised (the matcher keeps a short name only when the
// brand has no model of exactly that name); M: loadMatcher(); read: cd -> rows
export function recallsFor({cds, names, lo, hi, make = "", models = null}, M, read) {
  const seen = new Map(), ids = new Set();
  for (const cd of cds) {
    const rows = read(cd); if (!rows) continue;
    for (const n of names) for (const r of M.match(rows, {kinuy_mishari: n, degem_nm: "", shnat_yitzur: "", tozeret_nm: make}, models)) {
      const from = recallYear(r.BUILD_BEGIN_A), to = recallYear(r.BUILD_END_A);
      if (from && to && (to < lo || from > hi)) continue;   // built outside the vintages on the page
      // the ministry often files one campaign under several recall numbers (one per variant): the same year, text and build years count once
      const k = [r.SHNAT_RECALL, clean(r.TEUR_TAKALA), from, to].join("|");
      if (!seen.has(k) && !ids.has(r.RECALL_ID)) { seen.set(k, {...r, from, to}); ids.add(r.RECALL_ID); }
    }
  }
  return [...seen.values()].sort((a, b) => (num(b.SHNAT_RECALL) || 0) - (num(a.SHNAT_RECALL) || 0) || (num(b.RECALL_ID) || 0) - (num(a.RECALL_ID) || 0));
}

// what pages.mjs calls: {build({cds, names, lo, hi, make, label, name}) -> html, kind} or {why}. brandOf maps a registry maker name to the page's
// brand label, for the brand model names the older matcher needs; fallbackMakers ([{n, m}]) stand in for meta.json when it is missing
export async function recallBuilder({root = ROOT(), brandOf = n => n, fallbackMakers = [], matcher = null} = {}) {
  if (!haveRecalls(root)) return {why: `no recall files in ${root}/r (catalog-data)`};
  const M = matcher || await loadMatcher(); if (M.error) return {why: "the app's recall matcher did not load: " + M.error};
  const meta = catMeta(root), read = makerFiles(root, M.extra);
  let modelsOf;
  if (M.brandModels && meta) modelsOf = make => M.brandModels(meta, {tozeret_nm: make});
  else {
    const by = new Map();
    for (const x of meta ? Object.values(meta.makers) : fallbackMakers) { const l = brandOf(x.n), set = by.get(l) || by.set(l, new Set()).get(l); for (const n of x.m || []) set.add(norm(n)); }
    modelsOf = (make, label) => by.get(label) || null;
  }
  return {kind: M.kind, build: ({cds, names, lo, hi, make, label, name}) => recallSection(recallsFor({cds, names, lo, hi, make, models: modelsOf(make, label)}, M, read), name)};
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const clean = s => String(s || "").replace(/\s+/g, " ").trim();
// the ministry's field holds 120 characters, so a long description arrives cut mid-word: end it at the last whole word with "…"
export const CAP = 119;
const cut = s => { s = clean(s).slice(0, CAP + 1); if (s.length < CAP || /[.!?)]$/.test(s)) return s; const sp = s.lastIndexOf(" "); return (sp > CAP * 0.6 ? s.slice(0, sp) : s).replace(/[\s.,;:(-]+$/, "") + "…"; };
const sys = r => { const t = clean(r.SUG_TAKALA); return t && t !== "אחר" ? t : ""; };
export const SHOW = 10;

export function recallSection(rows, name) {
  if (!rows.length) return "";
  const yrs = rows.flatMap(r => [r.from, r.to]).filter(Boolean), lo = Math.min(...yrs), hi = Math.max(...yrs);
  const by = new Map(); for (const r of rows) { const s = sys(r); if (s) by.set(s, (by.get(s) || 0) + 1); }
  const top = [...by.entries()].sort((a, b) => b[1] - a[1]).filter(([, n]) => n >= 2).slice(0, 2).map(([s]) => s);
  const n = rows.length, first = Math.min(...rows.map(r => Number(r.SHNAT_RECALL)).filter(Boolean));
  const intro = `${n === 1 ? "משרד התחבורה פרסם ריקול אחד" : `משרד התחבורה פרסם ${n} ריקולים`} שמתאימים לשם הדגם ${esc(name)}` +
    (yrs.length ? (lo === hi ? `, לרכבים שיוצרו ב-${lo}` : `, לרכבים שיוצרו בשנים ${lo} עד ${hi}`) : "") + (first ? ` (הראשון פורסם ב-${first})` : "") + "." +
    (top.length ? ` ${top.length === 1 ? `התחום שחוזר הכי הרבה: ${esc(top[0])}.` : `התחומים שחוזרים הכי הרבה: ${esc(top[0])} ו${esc(top[1])}.`}` : "");
  const li = rows.slice(0, SHOW).map(r => {
    const s = sys(r), what = cut(r.TEUR_TAKALA) || "ללא תיאור", how = clean(r.OFEN_TIKUN);
    const built = r.from && r.to ? (r.from === r.to ? `יוצרו ב-${r.from}` : `יוצרו ${r.from} עד ${r.to}`) : "";
    const meta = [built, how ? `טיפול: ${how}` : ""].filter(Boolean).join(" · ");
    return `<li><b>${esc(clean(r.SHNAT_RECALL) || "–")}</b> · ${s ? esc(s) + ": " : ""}${esc(what)}${meta ? ` <span class="muted">(${esc(meta)})</span>` : ""}</li>`;
  }).join("");
  return `<h2>ריקולים שפורסמו ל${esc(name)}</h2><p>${intro}</p><ul class="g">${li}</ul>` +
    (n > SHOW ? `<p class="muted">ועוד ${n - SHOW} ריקולים מוקדמים יותר.</p>` : "") +
    `<p class="muted">לפי רשימת הריקולים של משרד התחבורה, לפי שם הדגם ושנות הייצור. ריקול הוא תיקון שהיבואן מבצע בדרך כלל ללא עלות. ריקול לדגם לא אומר שרכב מסוים כלול בו: זה תלוי בתאריך הייצור ולפעמים במספר השלדה. בבדיקה לפי מספר רישוי רואים אם נשאר לרכב עצמו ריקול פתוח.</p>`;
}

if (process.argv[1] && process.argv[1].endsWith("model-recalls.mjs") && process.argv[2] === "selftest") {
  let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.log("FAIL", m); } };
  const M = await loadMatcher(process.env.MATCHER_DIR || ".github/scripts", process.env.MATCHER_HTML || "index.html");
  if (M.error) { console.log("FAIL the matcher did not load: " + M.error); process.exit(1); }
  console.log("matcher: " + M.kind);
  const R = (id, degem, yr, b, e, sug = "מערכת הבלמים", teur = "החלפת צינור בלם", tikun = "החלפה") =>
    ({RECALL_ID: id, TOZAR_TEUR: "TOYOTA", DEGEM: degem, SHNAT_RECALL: yr, BUILD_BEGIN_A: b ? b + "-01-01" : "", BUILD_END_A: e ? e + "-12-31" : "", SUG_TAKALA: sug, TEUR_TAKALA: teur, OFEN_TIKUN: tikun});
  const data = {1: [R(1, "COROLLA", 2024, 2019, 2022), R(2, "COROLLA,C-HR", 2023, 2018, 2019, "מערכת הדלק", "משאבת דלק"), R(3, "COROLLA", 2010, 2001, 2004), R(4, "COROLLA CROSS", 2024, 2021, 2024), R(5, "YARIS", 2024, 2020, 2022)],
    2: [R(1, "COROLLA", 2024, 2019, 2022), R(6, "COROLLA", 2025, null, null, "אחר", "x".repeat(400))]};
  const read = cd => data[cd] || null;
  const brand = new Set(["COROLLA", "COROLLACROSS", "YARIS", "CHR"]);
  const rows = recallsFor({cds: [1, 2, 3], names: ["COROLLA"], lo: 2015, hi: 2026, make: "טויוטה יפן", models: brand}, M, read);
  const ids = rows.map(r => r.RECALL_ID);
  ok(ids.includes(1) && ids.includes(2) && ids.includes(6), "matches the model, a multi-model row and a row without build years: " + ids);
  ok(!ids.includes(3), "a recall built before the page's vintages is left out");
  ok(!ids.includes(4) && !ids.includes(5), "another model (COROLLA CROSS, YARIS) is left out");
  ok(ids.filter(i => i === 1).length === 1, "the same recall in two maker files counts once");
  const twinRows = [R(1, "COROLLA", 2024, 2019, 2022), R(7, "COROLLA HSD", 2024, 2019, 2022), R(8, "COROLLA", 2024, 2016, 2018)];
  const twin = recallsFor({cds: [1], names: ["COROLLA"], lo: 2015, hi: 2026, make: "טויוטה יפן", models: brand}, M, () => twinRows);
  ok(twin.length === 2, "one campaign under two numbers counts once, other build years stay: " + twin.map(r => r.RECALL_ID));
  ok(ids[0] === 6 && ids.at(-1) === 2, "newest first");
  const html = recallSection(rows, "טויוטה קורולה (COROLLA)");
  ok(html.includes("<h2>ריקולים שפורסמו לטויוטה קורולה (COROLLA)</h2>") && html.includes("3 ריקולים") && html.includes("2018 עד 2022"), "heading and summary");
  ok(!html.includes("<a ") && !/href=/.test(html), "no links (21-day rule)");
  ok(html.includes("…") && !html.includes("x".repeat(200)), "long descriptions are cut");
  const capped = recallSection([{...R(9, "COROLLA", 2020, 2019, 2019, "בלמים", ("קיים חשש שלחץ נוזל הבלם לא יפוקח כפי שתוכנן על ידי מחשב בקרת ההחלקה עקב ליקוי בתוכנה. המשתמש ברכב עלול לחוות דוושת בלם " + "קשה").slice(0, CAP + 1)), from: 2019, to: 2019}], "x");
  ok(capped.includes("דוושת בלם…") && !capped.includes("ק…"), "a description cut by the ministry ends at a whole word");
  ok(recallSection([{...R(9, "COROLLA", 2020, 2019, 2019, "בלמים", "קצר."), from: 2019, to: 2019}], "x").includes("קצר. <span"), "short text unchanged");
  ok(!html.includes("אחר:"), "the system 'אחר' is not shown");
  ok(recallSection([], "x") === "", "no recalls: no section");
  const many = Array.from({length: 14}, (_, k) => ({...R(100 + k, "COROLLA", 2010 + k, 2015, 2020), from: 2015, to: 2020}));
  ok(recallSection(many, "x").includes("ועוד 4 ריקולים"), "more than 10: the rest is counted");
  ok(recallSection([{...R(9, "COROLLA", 2020, 2019, 2019), from: 2019, to: 2019}], "x").includes("ריקול אחד") , "one recall wording");
  ok(recallSection([{...R(9, "A<b>", 2020, 2019, 2019, "מערכת <x>", "<script>"), from: 2019, to: 2019}], "x").includes("&lt;script&gt;"), "escaped");
  // the builder: no recall files means no section and a reason, never a throw
  const none = await recallBuilder({root: "/nonexistent-cat-data", matcher: M});
  ok(!none.build && /no recall files/.test(none.why), "no catalog-data: a reason, no builder");
  const tmp = fs.mkdtempSync("/tmp/mr-"); fs.mkdirSync(tmp + "/r");
  fs.writeFileSync(tmp + "/r/1.json", JSON.stringify({u: "x", rows: data[1], x: [R(20, "COROLLA", 2024, 2019, 2022, "בלמים", "שורה של מותג אחות")]}));
  const b1 = await recallBuilder({root: tmp, fallbackMakers: [{n: "טויוטה", m: ["COROLLA", "COROLLA CROSS", "YARIS", "C-HR"]}], brandOf: () => "טויוטה", matcher: M});
  const page = b1.build({cds: [1], names: ["COROLLA"], lo: 2015, hi: 2026, make: "טויוטה יפן", label: "טויוטה", name: "קורולה"});
  ok(page.includes("<h2>ריקולים שפורסמו לקורולה</h2>"), "builder makes the section from the files");
  ok(M.extra ? page.includes("שורה של מותג אחות") : !page.includes("שורה של מותג אחות"), "the x rows are read with the full matcher only");
  fs.rmSync(tmp, {recursive: true, force: true});
  console.log(bad ? `${bad} failed` : "selftest ok");
  process.exit(bad ? 1 : 0);
}
