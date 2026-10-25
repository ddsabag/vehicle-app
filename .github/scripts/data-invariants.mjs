// Data truth, weekly: the facts the app's rules rest on, read from the Ministry of Transport's registers in full and held against fixed
// limits. The daily audit (site-data-truth.mjs) checks a sample of cars on screen; this checks the whole data for the conditions under which
// a correct rule would start giving wrong answers (measured 20.10.2026; each check says what it protects):
//   fresh    the active register's newest last-test date is at most 3 days old            (the test and licence lines read current data)
//   tests    tests recorded per day last week are at least half the usual rate            (test dates still arrive)
//   renewal  cars whose last test is after their licence end: at most 5,000 (1,082)       (the "renewal not in the data yet" state stays rare)
//   dates    active rows whose licence date is empty or not a date: at most 2,000         (the licence state reads real dates)
//   reuse    plates in the active register and in a cancel register: at most 100 (5)      (the app ranks registers; a reused number stays rare)
//   owners   active cars whose current owner type (register) is in none of the ownership log's records of its latest month: at most 0.5%
//            of the cars with a log (about 0.07%)                                           (the register is the current owner, the log the history)
//   km       tech rows (km at the last test) at least 2,000,000 (2,488,584), with km on at least 60% (70%)
//   hook     2008+ active cars with a towing hook fitted whose own-year model row says 0/0: at most 2,000 (461)   (the ban yields to the hook)
//   price    maker+code+type+year groups with more than one list price: at most 100 (0)  (the catalogue joins the price list and the counts by
//            maker|code|type|year; by maker+code+year alone 893 groups have two prices, a private and a commercial model under one code)
//   wltp     the largest maker+code group of model rows: at most 250 (16)                 (the app's live query reads 300 rows)
//   recalls  (plate, recall) pairs on several rows of the per-car recall list: at most 100 (0)
//   pubcancel public vehicles cancelled for good (bitul 2/3/5/6/8) that no cancel register lists: at most 50 (0 of 3,298)
//            (a cancel register outranks the public register, so such a vehicle reads as off the road)
//   lend     a plate in two registers where one lends the other its dates (moto + import, heavy + public) with another maker,
//            or (import) another model year: at most 50 (0 of 1,808 and 0 of 36,422)  (dates come from the same vehicle)
// Totals only, never a plate. out/invariants.json = this week's values, limits and verdicts; out/inv-history.json = the last 60 weeks
// (read back from the data-truth branch). One Telegram line through the alert router when a limit breaks (key truth:inv:<ids>).
//   node data-invariants.mjs              read everything (about 40 min on a GitHub runner), write, alert
//   node data-invariants.mjs --selftest   offline: every check on small made-up registers
import fs from "node:fs";
import { msg, heError } from "./tg-text.mjs";

const API = "https://data.gov.il/api/3/action/";
const ID = { active: "053cea08-09bc-40ec-8f7a-156f0677aff3", cancel: "851ecab1-0622-4dbe-a6c7-f950cf82abf9", cancel2010: "4e6b9724-4c1e-43f0-909a-154d4cc4e046",
  cancel2000: "ec8cbc34-72e1-4b69-9c48-22821ba0bd6c", cont: "0866573c-40cd-4ca8-91d2-9dd2d7a492e5", tech: "56063a99-8a3e-4ff4-912e-5966c0279bad",
  owners: "bb2355dc-9ec7-4f06-9c3f-3344672171da", recall: "36bf1404-0be4-49d2-82dc-2f1ead4a8b93", wltp: "142afde2-6228-49f9-8a29-9b6c3a0cbe40",
  price: "39f455bf-6db0-4926-859d-017f34eacbcb", moto: "bf9df4e2-d90d-4c0a-a400-19e15af8e95f", heavy: "cd3acc5c-03c3-4c89-9c54-d40f93c0d790",
  public: "cf29862d-ca25-4691-84f6-1be60dcb4a1e", import: "03adc637-b6fe-402b-9937-7c3d3afc9140" };
const HISTORY_URL = "https://raw.githubusercontent.com/ddsabag/vehicle-app/data-truth/inv-history.json";
const LATEST_URL = "https://github.com/ddsabag/vehicle-app/blob/data-truth/invariants.json";
export const TOW_BAN_FROM = 2008;   // index.html: a 0/0 model row bans towing from this model year on
// id -> [Hebrew name for the alert, test(value) -> ok, limit as words]
export const CHECKS = {
  fresh:   ["תאריכי הטסט במאגר לא מתעדכנים", v => v <= 3, "עד 3 ימים"],
  tests:   ["נרשמו מעט מדי טסטים בשבוע האחרון", v => v >= 0.5, "לפחות מחצית מהקצב הרגיל"],
  renewal: ["רכבים רבים עברו טסט בלי חידוש רישיון במאגר", v => v <= 5000, "עד 5,000"],
  dates:   ["תאריכי רישיון חסרים או לא תקינים", v => v <= 2000, "עד 2,000"],
  reuse:   ["מספרי רכב במאגר הפעיל וגם במאגר שירד מהכביש", v => v <= 100, "עד 100"],
  owners:  ["סוג הבעלות הנוכחי לא תואם את היסטוריית הבעלויות", v => v <= 0.005, "עד 0.5%"],
  km:      ["נתוני הק״מ בטסט חסרים", v => v.rows >= 2e6 && v.share >= 0.6, "לפחות 2 מיליון שורות, 60% עם ק״מ"],
  hook:    ["וו גרירה רשום ברכבים שנתוני הדגם שלהם אוסרים גרירה", v => v <= 2000, "עד 2,000"],
  price:   ["דגם עם כמה מחירי מחירון באותה שנה", v => v <= 100, "עד 100"],
  wltp:    ["יותר מדי שורות לקוד דגם אחד", v => v <= 250, "עד 250"],
  recalls: ["כפילויות ברשימת הריקולים לפי רכב", v => v <= 100, "עד 100"],
  pubcancel: ["רכב ציבורי שבוטל לצמיתות ולא מופיע במאגר הרכבים שירדו מהכביש", v => v <= 50, "עד 50"],
  lend:    ["אותו מספר בשני מאגרים עם יצרן או שנת ייצור שונים", v => v <= 50, "עד 50"],
};
// public register cancellation codes that end the vehicle's registration (the others, C/S deposit and A/B/Z/R police or safety patrol, are temporary)
export const PUB_FOR_GOOD = r => /^[23568]$/.test(String(r.bitul_cd ?? "").trim()) || /בטול|אובדן|פרוק|העברה ל/.test(String(r.bitul_nm || ""));

const T0 = Date.now(), log = m => console.log(`[${Math.round((Date.now() - T0) / 1000)}s] ${m}`);
const IO = { env: process.env, out: s => console.log(s), fetch: (u, o) => fetch(u, o), now: () => new Date() };
async function call(params, tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await IO.fetch(API + "datastore_search?" + new URLSearchParams(params), { headers: { Accept: "application/json", "User-Agent": "luchit-data-truth/1.0" }, signal: AbortSignal.timeout(180000) });
      const j = await r.json(); if (j.success) return j.result; last = JSON.stringify(j.error || "").slice(0, 160);
    } catch (e) { last = e.message; }
    await new Promise(r => setTimeout(r, 5000 * (i + 1)));
  }
  throw new Error("failed " + last);
}
const PAGE = 32000;
// every row of a dataset, in _id order; a read that ends early is an error (no check runs on half a register). A short page is the end only
// when no row lies past it: the dataset's own total is no measure, since for the price list it is an estimate (130,885 on 24.10.2026, while
// every read ends at its 102,116 rows), and holding the read to it would fail the whole weekly check
async function scanLive(id, fields, onRows) {
  let total = 0;
  for (let off = 0; ; off += PAGE) {
    const r = await call({ resource_id: id, limit: String(PAGE), offset: String(off), sort: "_id", fields });
    onRows(r.records); total += r.records.length;
    if (r.records.length < PAGE) {
      const more = await call({ resource_id: id, limit: "1", offset: String(total), sort: "_id", fields: "_id" });
      if (more.records.length) throw new Error(`${id}: the read stopped after ${total} rows, and the dataset goes on`);
      break;
    }
  }
  return total;
}

const E = v => v === null || v === undefined || String(v).trim() === "";
const N = v => Number(String(v ?? "").replace(/,/g, "").trim());
const plateOf = v => { const n = Number(String(v ?? "").replace(/\D/g, "")); return n > 0 ? n : null; };
const dayOf = s => { const m = String(s ?? "").match(/^(\d{4})-?(\d{2})-?(\d{2})/); if (!m || +m[1] < 1950 || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) return null; return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5; };
// the ownership log and the register name owner types differently; company, leasing and rental are one family (the register and the log mix them)
const KIND = { private: 1, dealer: 2, fleet: 4, other: 8 };
export const kindOf = t => { t = String(t || ""); return /סוחר|יבואן/.test(t) ? KIND.dealer : /השכר|ליסינג|החכר|חכיר|חברה|חברת|תאגיד/.test(t) ? KIND.fleet : /פרטי/.test(t) ? KIND.private : KIND.other; };
const hookOf = v => { const t = String(v || "").trim(); return t !== "" && !/^אין/.test(t); };
const ilToday = d => { const s = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(d); return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5; };

export async function measure(scan, today) {
  const v = {}, info = {};
  // model rows: towing per maker|code|type|year, the largest maker+code group
  const tow = new Map(), groups = new Map();
  await scan(ID.wltp, "tozeret_cd,degem_cd,sug_degem,shnat_yitzur,kosher_grira_im_blamim,kosher_grira_bli_blamim", rows => { for (const r of rows) {
    const g = `${N(r.tozeret_cd)}|${N(r.degem_cd)}`; groups.set(g, (groups.get(g) || 0) + 1);
    const zero = !(N(r.kosher_grira_im_blamim) > 0) && !(N(r.kosher_grira_bli_blamim) > 0) && !E(r.kosher_grira_im_blamim) && !E(r.kosher_grira_bli_blamim);
    tow.set(`${g}|${String(r.sug_degem || "").trim().toUpperCase()}|${N(r.shnat_yitzur)}`, zero ? 0 : 1);
  } });
  v.wltp = 0; for (const n of groups.values()) if (n > v.wltp) v.wltp = n;
  const prices = new Map();
  await scan(ID.price, "tozeret_cd,degem_cd,sug_degem,shnat_yitzur,mehir", rows => { for (const r of rows) { if (!(N(r.mehir) > 0)) continue; const k = `${N(r.tozeret_cd)}|${N(r.degem_cd)}|${String(r.sug_degem || "").trim().toUpperCase()}|${N(r.shnat_yitzur)}`; (prices.get(k) || prices.set(k, new Set()).get(k)).add(N(r.mehir)); } });
  v.price = [...prices.values()].filter(s => s.size > 1).length;
  // per-car recall list: duplicate pairs
  const pairs = new Set(); let dup = 0;
  await scan(ID.recall, "MISPAR_RECHEV,RECALL_ID", rows => { for (const r of rows) { const k = `${plateOf(r.MISPAR_RECHEV)}|${N(r.RECALL_ID)}`; if (pairs.has(k)) dup++; else pairs.add(k); } });
  v.recalls = dup; pairs.clear();
  // towing hook per plate (cont), then the active register
  const hooked = new Set();
  await scan(ID.cont, "mispar_rechev,grira_nm", rows => { for (const r of rows) if (hookOf(r.grira_nm)) { const p = plateOf(r.mispar_rechev); if (p) hooked.add(p); } });
  const own = new Map();   // plate -> the register's owner kind
  let fresh = -Infinity, renewal = 0, dates = 0, hook = 0, cars = 0; const perDay = new Map();
  await scan(ID.active, "mispar_rechev,tokef_dt,mivchan_acharon_dt,baalut,tozeret_cd,degem_cd,sug_degem,shnat_yitzur", rows => { for (const r of rows) {
    cars++; const p = plateOf(r.mispar_rechev), e = dayOf(r.tokef_dt), t = dayOf(r.mivchan_acharon_dt);
    if (e === null) dates++;
    if (t !== null) { if (t <= today) fresh = Math.max(fresh, t); if (t >= today - 63) perDay.set(t, (perDay.get(t) || 0) + 1); if (e !== null && t > e) renewal++; }
    if (p) { own.set(p, kindOf(r.baalut)); if (hooked.has(p) && N(r.shnat_yitzur) >= TOW_BAN_FROM && tow.get(`${N(r.tozeret_cd)}|${N(r.degem_cd)}|${String(r.sug_degem || "").trim().toUpperCase()}|${N(r.shnat_yitzur)}`) === 0) hook++; }
  } });
  hooked.clear();
  v.fresh = fresh === -Infinity ? 999 : today - fresh;
  const sumDays = (a, b) => { let s = 0; for (let d = a; d <= b; d++) s += perDay.get(d) || 0; return s; };
  const week = sumDays(today - 8, today - 2) / 7, usual = sumDays(today - 63, today - 9) / 55;
  v.tests = usual > 0 ? Math.round(week / usual * 100) / 100 : 0;
  v.renewal = renewal; v.dates = dates; v.hook = hook; info.activeCars = cars; info.testsPerDayLastWeek = Math.round(week); info.testsPerDayUsual = Math.round(usual);
  // the public and import registers: who lends dates to whom, and which public vehicles were cancelled for good
  const pub = new Map(), imp = new Map();   // plate -> maker (public, 0 when cancelled for good) / maker|year (import)
  await scan(ID.public, "mispar_rechev,bitul_cd,bitul_nm,tozeret_cd", rows => { for (const r of rows) { const p = plateOf(r.mispar_rechev); if (p) pub.set(p, PUB_FOR_GOOD(r) ? 0 : N(r.tozeret_cd)); } });
  await scan(ID.import, "mispar_rechev,tozeret_cd,shnat_yitzur", rows => { for (const r of rows) { const p = plateOf(r.mispar_rechev); if (p) imp.set(p, `${N(r.tozeret_cd)}|${N(r.shnat_yitzur)}`); } });
  // plates in active and in a cancel register (the number reused, or a register that did not drop a car); public vehicles cancelled for good that a cancel register lists
  let reuse = 0; const listed = new Set();
  for (const k of ["cancel", "cancel2010", "cancel2000"]) await scan(ID[k], "mispar_rechev", rows => { for (const r of rows) { const p = plateOf(r.mispar_rechev); if (own.has(p)) reuse++; if (pub.get(p) === 0) listed.add(p); } });
  v.reuse = reuse;
  let forGood = 0; for (const m of pub.values()) if (m === 0) forGood++;
  v.pubcancel = forGood - listed.size; info.publicCancelledForGood = forGood; listed.clear();
  // the registers that lend dates: moto takes them from import, heavy from public (index.html), so both rows must be the same vehicle
  let lend = 0, motoImport = 0, heavyPublic = 0;
  await scan(ID.moto, "mispar_rechev,tozeret_cd,shnat_yitzur", rows => { for (const r of rows) { const x = imp.get(plateOf(r.mispar_rechev)); if (x === undefined) continue; motoImport++; if (x !== `${N(r.tozeret_cd)}|${N(r.shnat_yitzur)}`) lend++; } });
  await scan(ID.heavy, "mispar_rechev,tozeret_cd", rows => { for (const r of rows) { const x = pub.get(plateOf(r.mispar_rechev)); if (!x) continue; heavyPublic++; if (x !== N(r.tozeret_cd)) lend++; } });
  v.lend = lend; info.motoInImport = motoImport; info.heavyInPublic = heavyPublic; pub.clear(); imp.clear();
  // the ownership log's latest month per active plate: which owner kinds it holds
  const last = new Map();   // plate -> month * 16 + kinds
  await scan(ID.owners, "mispar_rechev,baalut_dt,baalut", rows => { for (const r of rows) {
    const p = plateOf(r.mispar_rechev); if (!own.has(p)) continue; const m = N(r.baalut_dt); if (!(m > 190000)) continue;
    const cur = last.get(p), cm = cur === undefined ? -1 : Math.floor(cur / 16);
    if (m > cm) last.set(p, m * 16 + kindOf(r.baalut)); else if (m === cm) last.set(p, cur | kindOf(r.baalut));
  } });
  let withLog = 0, off = 0;
  for (const [p, x] of last) { withLog++; const k = own.get(p); if (k !== KIND.other && !((x % 16) & k)) off++; }
  v.owners = withLog ? Math.round(off / withLog * 1e5) / 1e5 : 0; info.carsWithOwnershipLog = withLog; info.ownerTypeNotInLatestMonth = off;
  own.clear(); last.clear();
  // km at the last test
  let techRows = 0, withKm = 0;
  await scan(ID.tech, "kilometer_test_aharon", rows => { for (const r of rows) { techRows++; if (N(r.kilometer_test_aharon) > 0) withKm++; } });
  v.km = { rows: techRows, share: techRows ? Math.round(withKm / techRows * 1000) / 1000 : 0 };
  return { v, info };
}

export function judge(v) { return Object.entries(CHECKS).map(([id, [he, ok, limit]]) => ({ id, he, value: v[id], limit, ok: v[id] === undefined ? null : !!ok(v[id]) })); }
export function message(res, day) {
  const bad = res.filter(r => r.ok === false);
  if (!bad.length) return null;
  const val = r => typeof r.value === "object" ? `${r.value.rows.toLocaleString("en-US")} שורות, ${Math.round(r.value.share * 100)}% עם ק״מ` : r.id === "owners" ? `${(r.value * 100).toFixed(2)}%` : r.id === "tests" ? `${Math.round(r.value * 100)}% מהקצב הרגיל` : Number(r.value).toLocaleString("en-US");
  return { key: "truth:inv:" + bad.map(r => r.id).join("+"),
    text: msg({ kind: "today", area: "data", title: "הבדיקה השבועית מצאה שינוי במאגרי משרד התחבורה",
      text: `בבדיקה של ${day} נמצא שינוי שיכול להטעות את האפליקציה:\n${bad.map(r => `• ${r.he}: ${val(r)} (הגבול: ${r.limit})`).join("\n")}\nהאפליקציה ממשיכה לעבוד.`,
      what: "לכתוב לי בשרשור \"נתונים ואמינות\", כדי שאבדוק לפני שזה מגיע למשתמשים.", raw: bad.map(r => `${r.id}=${JSON.stringify(r.value)}`).join(", ") }) };
}
export const addWeek = (hist, e) => { const w = (hist && Array.isArray(hist.weeks) ? hist.weeks : []).filter(x => x.d !== e.d); w.push(e); w.sort((a, b) => a.d < b.d ? -1 : 1); return { v: 1, weeks: w.slice(-60) }; };

async function telegram(text) {
  try { const r = await IO.fetch(`https://api.telegram.org/bot${IO.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: IO.env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }), signal: AbortSignal.timeout(20000) }); IO.out(`telegram ${r.status}`); return r.ok; }
  catch (e) { IO.out(`telegram failed: ${e.message}`); return false; }
}
async function send(m, links) {
  if (IO.env.DRY_RUN === "1" || !IO.env.TELEGRAM_BOT_TOKEN || !IO.env.TELEGRAM_CHAT_ID) { IO.out(`(no message sent: ${IO.env.DRY_RUN === "1" ? "dry run" : "no Telegram secrets"})\n${m.key}\n${m.text}`); return true; }
  let router = null; try { router = await import("./alert.mjs"); } catch { /* legacy below */ }
  const r = router ? await router.alert("day", m.key, m.text, links, { today: "loud", legacy: () => telegram(m.text) }) : { delivered: await telegram(m.text) };
  return !!(r && r.delivered);
}

async function main() {
  const now = IO.now(), today = ilToday(now), day = new Date(today * 864e5).toISOString().slice(0, 10);
  log(`data invariants ${day}: reading the registers in full`);
  let got;
  try { got = await measure(scanLive, today); }
  catch (e) { log("read failed: " + e.message); return (await send({ key: "truth:fail", text: msg({ kind: "today", area: "data", title: "הבדיקה השבועית של מאגרי משרד התחבורה לא הצליחה לקרוא את המאגרים",
    text: `${heError(e.message).split("\n<blockquote")[0]} הבדיקה של ${day} לא רצה, והאפליקציה עצמה לא נפגעה.`, what: "בדרך כלל כלום. אם זה חוזר בשבוע הבא, לכתוב לי בשרשור \"נתונים ואמינות\".", raw: e.message }) }, [IO.env.RUN_URL].filter(Boolean))) ? 0 : 1; }
  const res = judge(got.v);
  for (const r of res) IO.out(`${r.ok ? "ok  " : "FAIL"} ${r.id.padEnd(8)} ${JSON.stringify(r.value)} (limit ${r.limit})`);
  IO.out("info " + JSON.stringify(got.info));
  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync("out/invariants.json", JSON.stringify({ v: 1, d: day, checks: res, info: got.info }, null, 1));
  let hist = null; try { const h = await IO.fetch(IO.env.HISTORY_URL || HISTORY_URL, { signal: AbortSignal.timeout(20000) }); if (h.ok) hist = await h.json(); } catch {}
  fs.writeFileSync("out/inv-history.json", JSON.stringify(addWeek(hist, { d: day, v: got.v, info: got.info })));
  const m = message(res, day);
  if (!m) { log("every invariant holds"); return 0; }
  return (await send(m, [IO.env.RUN_URL, LATEST_URL].filter(Boolean))) ? 0 : 1;
}

async function selftest() {
  const ok = (c, m) => { if (!c) { console.log("FAIL " + m); process.exitCode = 1; } else console.log("ok   " + m); };
  const today = Date.UTC(2026, 9, 20) / 864e5, iso = d => new Date(d * 864e5).toISOString().slice(0, 10);
  const A = [], O = [], C = [], T = [];
  // 60 days of tests, 10 a day; 3 cars tested after their licence end; one empty licence date; one hook against a 0/0 2015 row
  for (let d = 1; d <= 63; d++) for (let i = 0; i < 10; i++) { const p = d * 100 + i; A.push({ mispar_rechev: p, tokef_dt: iso(today + 300), mivchan_acharon_dt: iso(today - d), baalut: "פרטי", tozeret_cd: 1, degem_cd: 1, sug_degem: "P", shnat_yitzur: 2019 }); }
  for (let i = 0; i < 3; i++) A[i].tokef_dt = iso(today - 40);
  A[5].tokef_dt = "0000-00-00T00:00:00";
  A[6].shnat_yitzur = 2015; C.push({ mispar_rechev: A[6].mispar_rechev, grira_nm: "וו גרירה קבוע" }, { mispar_rechev: A[7].mispar_rechev, grira_nm: "אין וו גרירה" });
  // ownership: a dealer and a private owner in the latest month of a private car (fine), a leasing car whose log ends with a private owner (off)
  O.push({ mispar_rechev: A[10].mispar_rechev, baalut_dt: 202501, baalut: "סוחר" }, { mispar_rechev: A[10].mispar_rechev, baalut_dt: 202501, baalut: "פרטי" }, { mispar_rechev: A[10].mispar_rechev, baalut_dt: 202402, baalut: "פרטי" });
  A[11].baalut = "ליסינג"; O.push({ mispar_rechev: A[11].mispar_rechev, baalut_dt: 202301, baalut: "החכר" }, { mispar_rechev: A[11].mispar_rechev, baalut_dt: 202406, baalut: "פרטי" });
  for (let i = 0; i < 10; i++) T.push({ kilometer_test_aharon: i < 7 ? 1000 : 0 });
  const D = { [ID.active]: A, [ID.owners]: O, [ID.cont]: C, [ID.tech]: T, [ID.recall]: [{ MISPAR_RECHEV: 5, RECALL_ID: 9 }, { MISPAR_RECHEV: "5", RECALL_ID: 9 }],
    [ID.wltp]: [{ tozeret_cd: 1, degem_cd: 1, sug_degem: "P", shnat_yitzur: 2015, kosher_grira_im_blamim: 0, kosher_grira_bli_blamim: 0 }, { tozeret_cd: 1, degem_cd: 1, sug_degem: "P", shnat_yitzur: 2019, kosher_grira_im_blamim: 1500, kosher_grira_bli_blamim: 750 }],
    // two prices for one maker, code and year (counts); a private and a commercial model under one code, each with its price (fine)
    [ID.price]: [{ tozeret_cd: 1, degem_cd: 1, shnat_yitzur: 2019, mehir: 100000 }, { tozeret_cd: 1, degem_cd: 1, shnat_yitzur: 2019, mehir: 120000 },
      { tozeret_cd: 2, degem_cd: 5, sug_degem: "P", shnat_yitzur: 2015, mehir: 102950 }, { tozeret_cd: 2, degem_cd: 5, sug_degem: "M", shnat_yitzur: 2015, mehir: 79950 }],
    [ID.cancel]: [{ mispar_rechev: A[20].mispar_rechev }, { mispar_rechev: 9001 }], [ID.cancel2010]: [{ mispar_rechev: "00000001" }], [ID.cancel2000]: [],
    // public: 9001 scrapped and listed in cancel (fine), 9002 total loss and listed nowhere (counts), 9003 deposited (temporary, fine), 9004 a bus of maker 7
    [ID.public]: [{ mispar_rechev: 9001, bitul_cd: "3", bitul_nm: "פרוק", tozeret_cd: 5 }, { mispar_rechev: 9002, bitul_cd: "8", bitul_nm: "אובדן גמור", tozeret_cd: 5 },
      { mispar_rechev: 9003, bitul_cd: "C", bitul_nm: "הפקדה", tozeret_cd: 5 }, { mispar_rechev: 9004, bitul_cd: "0", bitul_nm: "לא מבוטל", tozeret_cd: 7 }],
    // moto 9101 matches its import row; moto 9102 has another model year; heavy 9004 has another maker than its public row; heavy 9001 is ignored (cancelled for good)
    [ID.import]: [{ mispar_rechev: 9101, tozeret_cd: 3, shnat_yitzur: 2018 }, { mispar_rechev: 9102, tozeret_cd: 3, shnat_yitzur: 2018 }],
    [ID.moto]: [{ mispar_rechev: 9101, tozeret_cd: 3, shnat_yitzur: 2018 }, { mispar_rechev: 9102, tozeret_cd: 3, shnat_yitzur: 2019 }, { mispar_rechev: 9200, tozeret_cd: 3, shnat_yitzur: 2019 }],
    [ID.heavy]: [{ mispar_rechev: 9004, tozeret_cd: 8 }, { mispar_rechev: 9001, tozeret_cd: 9 }] };
  const fake = async (id, fields, onRows) => { onRows(D[id] || []); return (D[id] || []).length; };
  const { v, info } = await measure(fake, today);
  ok(v.fresh === 1, "fresh: newest test yesterday -> 1 day (" + v.fresh + ")");
  ok(v.tests === 1, "tests: the same rate as usual (" + v.tests + ")");
  ok(v.renewal === 3, "renewal: 3 cars tested after their licence end (" + v.renewal + ")");
  ok(v.dates === 1, "dates: the zero date counts as not a date (" + v.dates + ")");
  ok(v.hook === 1, "hook: a fitted hook on a 2015 car whose own-year row is 0/0 (" + v.hook + ")");
  ok(v.reuse === 1, "reuse: one active plate in a cancel register (" + v.reuse + ")");
  ok(info.carsWithOwnershipLog === 2 && info.ownerTypeNotInLatestMonth === 1, "owners: same-month dealer+private is fine, leasing car with a private latest month is off");
  ok(v.km.rows === 10 && v.km.share === 0.7, "km: rows and share with km");
  ok(v.price === 1 && v.wltp === 2 && v.recalls === 1, "price groups (a private and a commercial model under one code are two), largest code group, duplicate recall pairs (" + v.price + ")");
  ok(v.pubcancel === 1 && info.publicCancelledForGood === 2, "pubcancel: a total loss no cancel register lists; a deposit is temporary (" + v.pubcancel + ")");
  ok(v.lend === 2 && info.motoInImport === 2 && info.heavyInPublic === 1, "lend: another model year (moto+import), another maker (heavy+public) (" + v.lend + ")");
  const res = judge({ ...v, owners: 0.5, renewal: 9000, km: { rows: 2.5e6, share: 0.7 } }), m = message(res, "2026-10-25");
  ok(m && m.key === "truth:inv:renewal+owners", "the key names the broken checks: " + (m && m.key));
  ok(m && /50\.00%/.test(m.text) && /9,000/.test(m.text) && /הגבול: עד 5,000/.test(m.text) && m.text.startsWith("<b>🟠 לטיפול היום · נתונים</b>") && m.text.includes("👉 מה לעשות"), "wording");
  try { const { validKey, label } = await import("./alert.mjs"); ok(validKey(m.key) && !/^התראה:/.test(label(m.key).he), "a valid router key with a label: " + label(m.key).he); }
  catch (e) { ok(false, "alert.mjs import: " + e.message); }
  ok(message(judge({ fresh: 1, tests: 1, renewal: 1, dates: 0, reuse: 0, owners: 0, km: { rows: 2.5e6, share: 0.7 }, hook: 0, price: 0, wltp: 16, recalls: 0, pubcancel: 0, lend: 0 }), "x") === null, "nothing to say when every check holds");
  ok(addWeek({ v: 1, weeks: Array.from({ length: 70 }, (_, i) => ({ d: `2025-${String(1 + i % 12).padStart(2, "0")}-${String(1 + Math.floor(i / 12)).padStart(2, "0")}` })) }, { d: "2026-10-25" }).weeks.length === 60, "history keeps 60 weeks");
}

if (process.argv.includes("--selftest")) await selftest();
else process.exitCode = await main();
