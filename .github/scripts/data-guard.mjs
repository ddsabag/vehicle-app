// Data-integrity guard: compares the column list and column types of every ministry dataset the app and its monthly builders read
// with a saved baseline (orphan branch "guard-baseline", file schema.json). A removed or retyped column the code depends on is BREAKING:
// the Android build gate stops on it. Other changes (extra columns, unused columns removed) are only reported. A dataset that does not
// answer is "inconclusive": it never stops a build (the health check and the own-data fallback cover outages, this guard covers schema changes).
//   node data-guard.mjs            compute, write out/guard.json + out/schema.json + out/sig.txt
//   node data-guard.mjs --gate     same, exit code 3 on a breaking change (unless GUARD_SKIP=1)
//   node data-guard.mjs --send     send the Telegram alert for out/guard.json (DRY_RUN=1 prints it)
//   node data-guard.mjs --selftest offline check of the comparison logic
import fs from "node:fs";
import { SETS } from "./datasets.mjs";

const API = "https://data.gov.il/api/3/action/datastore_search";
const BASELINE_URL = "https://raw.githubusercontent.com/ddsabag/vehicle-app/guard-baseline/schema.json";

// Columns the code reads, per dataset (index.html lookups plus market.mjs, modelstats.mjs, own-build.mjs). Extra datasets the monthly builders use are listed with their own columns.
const USED = {
  "053cea08-09bc-40ec-8f7a-156f0677aff3": ["mispar_rechev", "tozeret_cd", "tozeret_nm", "kinuy_mishari", "degem_cd", "shnat_yitzur", "baalut", "mkoriut_nm", "moed_aliya_lakvish", "tokef_dt", "sug_delek_nm"],
  "56063a99-8a3e-4ff4-912e-5966c0279bad": ["mispar_rechev", "kilometer_test_aharon"],
  "bb2355dc-9ec7-4f06-9c3f-3344672171da": ["mispar_rechev", "baalut_dt", "baalut"],
  "36bf1404-0be4-49d2-82dc-2f1ead4a8b93": ["MISPAR_RECHEV"],
  "2c33523f-87aa-44ec-a736-edbb0a82975e": ["TOZAR_CD"],
  "142afde2-6228-49f9-8a29-9b6c3a0cbe40": ["tozeret_cd", "degem_cd", "shnat_yitzur", "merkav", "kosher_grira_im_blamim", "kosher_grira_bli_blamim"],
};
const EXTRA = [
  { key: "deliveries", id: "602ac32d-19c0-4b41-88e0-e3ce8a7e80b7", title: "מסירות רכבים חדשים", impact: "סטטיסטיקות השוק והתגיות החודשיות לא יתעדכנו", use: ["sgira_month", "tozeret_cd", "degem_cd", "tozeret_nm", "kinuy_mishari", "car_num", "sug_degem"] },
  { key: "counts", id: "5e87a7a1-2f6f-41c1-8aec-7216d52a6cf6", title: "ספירת רכבים לפי דגם", impact: "שמות היצרנים בסטטיסטיקות השוק לא יתקבלו", use: ["tozeret_cd", "tozar"] },
  { key: "cancel1", id: "851ecab1-0622-4dbe-a6c7-f950cf82abf9", title: "רכבים שירדו מהכביש (1)", impact: "שיעור הירידה מהכביש לדגם לא יתעדכן", use: ["tozeret_cd", "kinuy_mishari", "shnat_yitzur"] },
  { key: "cancel2", id: "4e6b9724-4c1e-43f0-909a-154d4cc4e046", title: "רכבים שירדו מהכביש (2)", impact: "שיעור הירידה מהכביש לדגם לא יתעדכן", use: ["tozeret_cd", "kinuy_mishari", "shnat_yitzur"] },
  { key: "cancel3", id: "ec8cbc34-72e1-4b69-9c48-22821ba0bd6c", title: "רכבים שירדו מהכביש (3)", impact: "שיעור הירידה מהכביש לדגם לא יתעדכן", use: ["tozeret_cd", "kinuy_mishari", "shnat_yitzur"] },
  { key: "disabled", id: "c8b9f9c8-4612-4068-934f-d4acd2e3c06e", title: "תו נכה", impact: "חיווי תו נכה לא יוצג", use: ["MISPAR RECHEV", "TAARICH HAFAKAT TAG"] },
];
const DATASETS = [...SETS.map(s => ({ key: s.key, id: s.id, title: s.title, impact: s.impact, use: USED[s.id] || s.fields })), ...EXTRA];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchJson(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(25000), headers: { "user-agent": "luchit-data-guard/1.0" } }); if (r.ok) return await r.json(); last = new Error("HTTP " + r.status); }
    catch (e) { last = e; }
    await sleep(2500 * (i + 1));
  }
  throw last;
}
const columns = async id => {
  const j = await fetchJson(`${API}?resource_id=${id}&limit=0`);
  if (!j.success || !Array.isArray(j.result?.fields)) throw new Error("no field list");
  return Object.fromEntries(j.result.fields.filter(f => f.id !== "_id").map(f => [f.id, f.type]));
};

// pure comparison, used by the live run and by the self-test
export function compare(datasets, now, baseline) {
  const findings = [];
  for (const d of datasets) {
    const cur = now[d.key], old = baseline && baseline[d.key];
    if (!cur) { findings.push({ key: d.key, title: d.title, level: "inconclusive", text: "לא הצלחנו לקרוא את רשימת העמודות" }); continue; }
    const used = new Set(d.use);
    // breaking only when the column was there before; a column that was never in the baseline is a mistake in USED, not a ministry change
    for (const c of d.use) if (!(c in cur)) findings.push(old && c in old
      ? { key: d.key, title: d.title, impact: d.impact, level: "breaking", text: `העמודה ${c} נעלמה מהמאגר, והאפליקציה קוראת אותה` }
      : { key: d.key, title: d.title, level: "warn", text: `העמודה ${c} לא נמצאה ולא הייתה בבסיס ההשוואה, כדאי לבדוק את רשימת העמודות בקוד` });
    if (!old) continue;
    for (const [c, t] of Object.entries(old)) {
      if (!(c in cur)) { if (!used.has(c)) findings.push({ key: d.key, title: d.title, level: "warn", text: `העמודה ${c} הוסרה (האפליקציה לא משתמשת בה)` }); }
      else if (cur[c] !== t) findings.push({ key: d.key, title: d.title, impact: used.has(c) ? d.impact : undefined, level: used.has(c) ? "breaking" : "warn", text: `סוג העמודה ${c} השתנה מ-${t} ל-${cur[c]}` });
    }
    const added = Object.keys(cur).filter(c => !(c in old));
    if (added.length) findings.push({ key: d.key, title: d.title, level: "info", text: `עמודות חדשות: ${added.join(", ")}` });
  }
  return findings;
}

function selftest() {
  const ds = [{ key: "a", title: "A", impact: "x", use: ["p", "q"] }];
  const base = { a: { p: "text", q: "int", z: "text" } };
  const t = (now, want) => { const lv = compare(ds, now, base).map(f => f.level).sort().join(","); if (lv !== want) { console.log("selftest FAILED", JSON.stringify(now), lv, "!=", want); process.exit(1); } };
  t({ a: { p: "text", q: "int", z: "text" } }, "");
  t({ a: { p: "text", q: "int" } }, "warn");
  t({ a: { p: "text", z: "text" } }, "breaking");
  t({ a: { p: "numeric", q: "int", z: "text" } }, "breaking");
  const lv0 = compare([{ ...ds[0], use: ["p", "q", "n"] }], base.a ? { a: base.a } : {}, base).map(f => f.level).join(",");
  if (lv0 !== "warn") { console.log("selftest FAILED unknown column", lv0); process.exit(1); }
  t({ a: { p: "text", q: "int", z: "text", n: "int" } }, "info");
  t({}, "inconclusive");
  console.log("selftest ok");
}

const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
async function telegram(text, silent = false) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (process.env.DRY_RUN === "1" || !token || !chat) { console.log("--- Telegram (dry run) ---\n" + text); return true; }
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, disable_notification: silent }) });
  if (!r.ok) console.log("telegram failed", r.status);
  return r.ok;
}

async function main() {
  const gate = process.argv.includes("--gate");
  const now = {};
  for (const d of DATASETS) { try { now[d.key] = await columns(d.id); } catch (e) { console.log(d.key, "unreadable:", e.message); } }
  let baseline = null, freshBaseline = false;
  try { baseline = await fetchJson(BASELINE_URL, 1); } catch { freshBaseline = true; }
  const findings = compare(DATASETS, now, baseline);
  const breaking = findings.filter(f => f.level === "breaking"), warn = findings.filter(f => f.level === "warn");
  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync("out/schema.json", JSON.stringify(Object.keys(now).length ? { ...(baseline || {}), ...now } : baseline || {}));   // a dataset that did not answer keeps its old baseline
  fs.writeFileSync("out/guard.json", JSON.stringify({ checked: new Date().toISOString(), freshBaseline, findings }));
  fs.writeFileSync("out/sig.txt", findings.filter(f => f.level !== "inconclusive").map(f => f.key + f.level + f.text).sort().join("|") || "clean");
  for (const f of findings) console.log(f.level.padEnd(12), f.key.padEnd(10), f.text);
  console.log(freshBaseline ? "no baseline yet: this run becomes the baseline" : `${breaking.length} breaking, ${warn.length} warnings`);
  if (gate && breaking.length && process.env.GUARD_SKIP !== "1") {
    console.log("::error::A ministry dataset changed in a way the app depends on. Fix the code, then accept the new schema (Data guard workflow, accept=true), or re-run with skip_guard.");
    process.exit(3);
  }
}

async function send() {
  const g = JSON.parse(fs.readFileSync("out/guard.json", "utf8")), bad = g.findings.filter(f => f.level === "breaking"), warn = g.findings.filter(f => f.level === "warn");
  if (!bad.length && !warn.length) return console.log("nothing to send");
  const line = f => `• <b>${esc(f.title)}</b>: ${esc(f.text)}${f.impact ? `\nהשפעה: ${esc(f.impact)}.` : ""}`;
  const text = bad.length
    ? `⛔ <b>לוחית: משרד התחבורה שינה מבנה של מאגר</b>\nהשינוי פוגע בעמודות שהאפליקציה קוראת. בניית גרסה חדשה לאנדרואיד נעצרת עד שייבדק.\n\n${bad.map(line).join("\n")}${warn.length ? `\n\nבנוסף:\n${warn.map(line).join("\n")}` : ""}`
    : `ℹ️ <b>לוחית: שינוי קטן במבנה מאגר</b>\nהאפליקציה לא נפגעת, רק לידיעה.\n\n${warn.map(line).join("\n")}`;
  process.exit((await telegram(text, !bad.length)) ? 0 : 1);
}

if (process.argv.includes("--selftest")) selftest();
else if (process.argv.includes("--send")) await send();
else if (process.argv[1] && process.argv[1].endsWith("data-guard.mjs")) await main();
