// Data truth, daily: does what the app shows still match the Ministry of Transport's registers, car by car?
// Runs site-data-audit.mjs (the checkout's index.html opened like a user, every tab read and compared with the audit's own raw reads of
// the ministry's rows) on a fresh sample every day (the seed is the date), and keeps only what may be public: totals per checked field,
// case ids, and the shown/expected values with anything plate-like removed. The audit's own output (it masks plates, but still) stays in
// the runner's temp folder and is never printed or published.
//   out/latest.json   today: cars read, totals per field, every mismatch (case id, field, shown, expected, the car's make/model/year)
//   out/history.json  the last 120 days of totals (read back from the data-truth branch, where Data truth publishes out/)
// One Telegram line through the alert router when a field that has to match did not (key truth:<groups>), or when too few cars could
// be read to call it a check (truth:fail). Fields that depend on the ministry answering at that moment (the partial-data message) and
// the monthly model counts go to the files only.
//   node site-data-truth.mjs               QUERIES optional, e.g. "n=30;rare=10;minutes=55" (seed= replaces the date)
//   node site-data-truth.mjs --selftest    offline: parsing, privacy scrub, wording, history
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ministryDown } from "./datasets.mjs";
import { msg } from "./tg-text.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IO = { env: process.env, out: s => console.log(s), fetch: (u, o) => fetch(u, o) };
const HISTORY_URL = "https://raw.githubusercontent.com/ddsabag/vehicle-app/data-truth/history.json";
const LATEST_URL = "https://github.com/ddsabag/vehicle-app/blob/data-truth/latest.json";
export const KEEP_DAYS = 120, MIN_CARS = 10;
// field family -> the words the alert uses (also the ids of the "truth" label in alert.mjs)
export const GROUPS = { page: "איתור הרכב", identity: "פרטי הרכב", status: "סטטוס הרכב", test: "טסט", road: "עלייה לכביש", owners: "בעלויות", km: "ק״מ",
  recalls: "ריקולים", settlements: "הסדרי פשרה", tow: "גרירה", specs: "מפרט", mods: "שינויים ברכב", fee: "אגרת רישוי", price: "מחיר מחירון",
  value: "שווי", tag: "תג נכה", insight: "תובנות", counts: "ספירת רכבים", message: "הודעות" };
// the partial-data message follows whether the ministry answered the app at that second; the model-year counts are monthly: files only
export const SOFT = new Set(["message.partial_data", "counts.model_year_active"]);
const ilDay = d => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(d);

// anything that could be a plate or a VIN goes: masked plates (12xxx67), dashed plates, bare 7-8 digit runs, 17-character VINs
export const scrub = s => String(s ?? "").replace(/\b\d{2}x{2,5}\d{2}\b/g, "<plate>").replace(/\b\d{2,3}-\d{2,3}-\d{2,3}\b/g, "<plate>")
  .replace(/(?<![\d,.])\d{7,8}(?![\d,.])/g, "<n>").replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, "<vin>");

export function parse(txt) {
  const r = { cars: 0, sampled: 0, mism: 0, skipped: [], refused: [], fields: {}, cases: {}, list: [], done: false };
  for (const line of String(txt).split("\n")) {
    let m;
    if ((m = line.match(/^SAMPLE (c\d+) \S+ (\S+)/))) { r.sampled++; (r.cases[m[1]] ||= {}).from = m[2]; }
    else if ((m = line.match(/^CASE (c\d+) \S+ (\S+) [^|]*\| ([^|]*?) \| fuel=/))) { const c = r.cases[m[1]] ||= {}; c.primary = m[2]; c.car = scrub(m[3]).replace(/\s+/g, " ").trim(); }
    else if ((m = line.match(/^MISMATCH (c\d+) \S+ \| ([^|]+?) \| shown="(.*?)" \| expected="(.*?)"(?: \| evidence: (.*))?$/)))
      r.list.push({ id: m[1], field: m[2].trim(), shown: scrub(m[3]), expected: scrub(m[4]), evidence: scrub(m[5] || "").slice(0, 200) });
    else if ((m = line.match(/^===== SUMMARY: (\d+) cars audited, (\d+) mismatches/))) {
      r.done = true; r.cars = +m[1]; r.mism = +m[2];
      const sk = line.match(/skipped for time: ([c\d,]+)/), rf = line.match(/refused the app: ([c\d,]+)/);
      if (sk) r.skipped = sk[1].split(","); if (rf) r.refused = rf[1].split(",");
    }
    else if ((m = line.match(/^FIELD (\S+)\s+checked=(\d+) mismatched=(\d+)/))) r.fields[m[1]] = [+m[2], +m[3]];
  }
  for (const x of r.list) { const c = r.cases[x.id] || {}; x.car = c.car || ""; x.from = c.from || ""; }
  return r;
}

const carsWord = n => n === 1 ? "רכב אחד" : `${n} רכבים`;
// what goes to Telegram: null when every field that has to match did
export function verdict(r, day) {
  if (!r.done || r.cars < MIN_CARS)
    return { key: "truth:fail", title: "בדיקת הנתונים היומית לא הצליחה לקרוא מספיק רכבים", body: `נקראו ${r.cars} מתוך ${r.sampled || "?"} רכבים (${day}). בדרך כלל זה אומר שמאגרי משרד התחבורה לא ענו, והאפליקציה עצמה לא נפגעה.`,
      what: "בדרך כלל כלום. אם זה חוזר מחר, לכתוב לי בשרשור \"נתונים ואמינות\"." , get text() { return msg({ kind: "today", area: "data", title: this.title, text: this.body, what: this.what }); } };
  const hard = Object.entries(r.fields).filter(([f, [, bad]]) => bad > 0 && !SOFT.has(f));
  if (!hard.length) return null;
  const byGroup = new Map(), cars = new Set();
  for (const [f, [, bad]] of hard) {
    const g = f.split(".")[0], ids = new Set(r.list.filter(x => x.field === f).map(x => x.id));
    const set = byGroup.get(g) || new Set(); byGroup.set(g, set);
    if (ids.size) ids.forEach(i => { set.add(i); cars.add(i); });
    else for (let i = 0; i < bad; i++) set.add(`${f}#${i}`);   // a totals-only field (the disability tag): counted, never named
  }
  const k = cars.size || Math.max(...[...byGroup.values()].map(s => s.size));
  const groups = [...byGroup.keys()].sort();
  const lines = groups.map(g => `${GROUPS[g] || g}: ${carsWord(byGroup.get(g).size)}`);
  return { key: "truth:" + groups.join("+"),
    text: msg({ kind: "today", area: "data", title: "האפליקציה הציגה משהו שלא תואם את משרד התחבורה",
      text: `בבדיקה היומית (${day}), ב-${carsWord(k)} מתוך ${r.cars} שנבדקו, משהו שהאפליקציה מציגה לא תאם את מאגרי משרד התחבורה.\n${lines.join(" · ")}\nהפירוט, בלי מספרי רכב, בקובץ היומי.`,
      what: "לכתוב לי בשרשור \"נתונים ואמינות\" כדי שאבדוק ואתקן.", raw: hard.map(([f, [n, bad]]) => `${f} ${bad}/${n}`).join(", ") }) };
}

export function addDay(hist, entry) {
  const days = (hist && Array.isArray(hist.days) ? hist.days : []).filter(d => d.d !== entry.d);
  days.push(entry); days.sort((a, b) => a.d < b.d ? -1 : 1);
  return { v: 1, days: days.slice(-KEEP_DAYS) };
}

async function telegram(text, silent = false) {
  try {
    const r = await IO.fetch(`https://api.telegram.org/bot${IO.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: IO.env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true, ...(silent ? { disable_notification: true } : {}) }), signal: AbortSignal.timeout(20000) });
    IO.out(`telegram ${r.status}`); return r.ok;
  } catch (e) { IO.out(`telegram failed: ${e.message}`); return false; }
}
// too few cars read while Ministry watch found a register the audit reads down this morning: the same outage it already rang for. The line
// says so, and the morning run sends it silently (a run started by a deploy still rings: the new page may be the cause)
const AUDIT_SETS = new Set(["active", "tech", "owners"]);
export async function sameOutage(v) {
  if (v.key !== "truth:fail") return null;
  const down = (await ministryDown(Date.now(), u => IO.fetch(u, { signal: AbortSignal.timeout(10000) })) || []).filter(d => AUDIT_SETS.has(d.key));
  if (!down.length) return null;
  const silent = IO.env.GITHUB_EVENT_NAME === "schedule";
  return { text: msg({ kind: silent ? "info" : "today", area: "data", title: v.title,
    text: `${v.body}\nשומר מאגרי משרד התחבורה כבר דיווח הבוקר שלא ענה: ${down.map(d => d.title).join(", ")}. כנראה זו אותה תקלה.`, what: silent ? "" : v.what }), silent };
}
async function send(v, links) {
  const same = await sameOutage(v);
  if (same) { v = { ...v, text: same.text }; IO.out(`same outage Ministry watch reported${same.silent ? ": sent silently" : ""}`); }
  if (IO.env.DRY_RUN === "1" || !IO.env.TELEGRAM_BOT_TOKEN || !IO.env.TELEGRAM_CHAT_ID) { IO.out(`(no message sent: ${IO.env.DRY_RUN === "1" ? "dry run" : "no Telegram secrets"})\n${v.key}\n${v.text}`); return true; }
  const silent = !!same?.silent;
  let router = null; try { router = await import("./alert.mjs"); } catch { /* legacy below */ }
  // the router rings a "day" item by day whatever `today` says: the same-outage line goes as "summary" (the Sunday block, or a silent line)
  const r = router ? await router.alert(silent ? "summary" : "day", v.key, v.text, links, { today: silent ? "silent" : "loud", legacy: () => telegram(v.text, silent) }) : { delivered: await telegram(v.text, silent) };
  return !!(r && r.delivered);
}

function runAudit(queries, file) {
  return new Promise(res => {
    const fd = fs.openSync(file, "w");
    const p = spawn(process.execPath, [path.join(HERE, "site-data-audit.mjs")], { env: { ...process.env, QUERIES: queries }, stdio: ["ignore", fd, fd] });
    p.on("close", code => { fs.closeSync(fd); res(code); });
    p.on("error", () => { fs.closeSync(fd); res(-1); });
  });
}

async function main() {
  const OPTS = Object.fromEntries(String(IO.env.QUERIES || "").split(/[;,]\s*(?=[a-z]+=)/).map(s => s.split("=")).filter(a => a[0]).map(([k, ...v]) => [k.trim(), v.join("=").trim()]));
  const day = ilDay(new Date()), seed = OPTS.seed || day.replace(/-/g, "");
  const n = Number(OPTS.n || 30), rare = Number(OPTS.rare || 10), minutes = Number(OPTS.minutes || 55);   // a car of another register takes about 2 min, an active one 1: 40 cars fit
  const queries = `seed=${seed};n=${n};rare=${rare};minutes=${minutes};makers=0`;
  const tmp = fs.mkdtempSync(path.join(IO.env.RUNNER_TEMP || os.tmpdir(), "truth-")), file = path.join(tmp, "audit.txt");
  IO.out(`data truth ${day}: auditing ${n} active cars + ${rare} from the other registers (seed ${seed}, up to ${minutes} min); the audit's own output stays in the runner's temp folder`);
  const t0 = Date.now(), code = await runAudit(queries, file);
  const r = parse(fs.readFileSync(file, "utf8"));
  IO.out(`audit exit ${code} after ${Math.round((Date.now() - t0) / 60000)} min: ${r.cars} cars read of ${r.sampled} sampled, ${r.mism} mismatches${r.skipped.length ? `, ${r.skipped.length} skipped for time` : ""}${r.refused.length ? `, ${r.refused.length} refused by the ministry` : ""}`);
  for (const [f, [cnt, bad]] of Object.entries(r.fields).sort()) if (bad) IO.out(`FIELD ${f} checked=${cnt} mismatched=${bad}${SOFT.has(f) ? " (soft)" : ""}`);
  for (const x of r.list) IO.out(`MISMATCH ${x.id} ${x.from} ${x.car} | ${x.field} | shown="${x.shown}" | expected="${x.expected}"`);
  fs.mkdirSync("out", { recursive: true });
  const latest = { v: 1, d: day, seed, cars: r.cars, sampled: r.sampled, mism: r.mism, skipped: r.skipped.length, refused: r.refused.length, fields: r.fields, list: r.list, auditExit: code };
  fs.writeFileSync("out/latest.json", JSON.stringify(latest, null, 1));
  let hist = null; try { const h = await IO.fetch(IO.env.HISTORY_URL || HISTORY_URL, { signal: AbortSignal.timeout(20000) }); if (h.ok) hist = await h.json(); } catch {}
  const hard = Object.entries(r.fields).filter(([f, [, bad]]) => bad > 0 && !SOFT.has(f)).reduce((s, [, [, bad]]) => s + bad, 0);
  fs.writeFileSync("out/history.json", JSON.stringify(addDay(hist, { d: day, seed, cars: r.cars, sampled: r.sampled, mism: r.mism, hard, f: Object.fromEntries(Object.entries(r.fields).filter(([, [, bad]]) => bad)) })));
  const v = verdict(r, day);
  if (!v) { IO.out("every field that has to match did"); return 0; }
  const links = [IO.env.RUN_URL, LATEST_URL].filter(Boolean);
  return (await send(v, links)) ? 0 : 1;
}

async function selftest() {
  const fake = [
    "site-data-audit seed=20261021 n=30 rare=10 index.html 600 KB, datasets 16",
    "SAMPLE c001 12xxx67 active y=2005 own=פרטי fuel=petrol of 1234",
    "SAMPLE c002 34xxxx78 cancel cancel of 99",
    "CASE c001 12xxx67 active 9s/8req | טויוטה יפן COROLLA 2005 | fuel=בנזין own=פרטי | owners=2 | errs=- | mismatches=1",
    'MISMATCH c001 12xxx67 | test.pill | shown="טסט לא בתוקף" | expected="טסט בתוקף (exp 2026-10-25)" | evidence: tokef_dt=2026-10-25 mivchan_acharon_dt=2025-10-20 plate 1234567 vin JTDBR32E720123456',
    "CASE c002 34xxxx78 cancel 7s/14req | פיג'ו צרפת 206 2003 | fuel=בנזין own=פרטי | owners=0 | errs=- | mismatches=0",
    "===== SUMMARY: 12 cars audited, 2 mismatches, 900 requests by the harness (0 refused and retried), 30 min",
    "FIELD message.partial_data         checked=12 mismatched=1 [c009]",
    "FIELD tag.insight                  checked=3 mismatched=1 (totals only)",
    "FIELD test.pill                    checked=12 mismatched=1 [c001]",
    "FIELD tow.limits                   checked=10 mismatched=0",
  ].join("\n");
  const ok = (c, m) => { if (!c) { console.log("FAIL " + m); process.exitCode = 1; } else console.log("ok   " + m); };
  const r = parse(fake);
  ok(r.done && r.cars === 12 && r.sampled === 2 && r.list.length === 1, "summary, samples and mismatches parsed");
  ok(r.list[0].car === "טויוטה יפן COROLLA 2005" && r.list[0].from === "active", "the case's car and register are attached");
  const pub = JSON.stringify(r.list);
  ok(!/\d{2}x+\d{2}|1234567|JTDBR32E720123456/.test(pub), "no plate, masked plate or VIN in what is published");
  const v = verdict(r, "2026-10-21");
  ok(v && v.key === "truth:tag+test", "key names the groups, soft fields left out: " + (v && v.key));
  ok(v && /ב-רכב אחד מתוך 12/.test(v.text) && /טסט: רכב אחד/.test(v.text) && /תג נכה: רכב אחד/.test(v.text) && v.text.startsWith("<b>🟠 לטיפול היום · נתונים</b>") && v.text.includes("👉 מה לעשות"), "wording");
  try { const { validKey, label } = await import("./alert.mjs"); ok(validKey(v.key) && validKey("truth:fail"), "keys are valid router keys");
    ok(/תג נכה/.test(label(v.key).he) && !/^התראה:/.test(label("truth:fail").he), "the router has labels for them: " + label(v.key).he); }
  catch (e) { ok(false, "alert.mjs import: " + e.message); }
  ok(verdict(parse(fake.replace("12 cars audited", "3 cars audited")), "x").key === "truth:fail", "too few cars -> truth:fail");
  ok(verdict(parse(fake.replace(/mismatched=1/g, "mismatched=0")), "x") === null, "nothing to say when every field matched");
  const h = addDay({ v: 1, days: Array.from({ length: 130 }, (_, i) => ({ d: `2026-0${1 + Math.floor(i / 28)}-${String(1 + i % 28).padStart(2, "0")}` })) }, { d: "2026-10-21" });
  ok(h.days.length === KEEP_DAYS && h.days.at(-1).d === "2026-10-21", "history keeps the last 120 days");
  ok(addDay({ v: 1, days: [{ d: "2026-10-21", cars: 1 }] }, { d: "2026-10-21", cars: 2 }).days.length === 1, "a second run the same day replaces the entry");
  // Ministry watch's morning reading (status.json), mocked
  const keep = { fetch: IO.fetch, env: IO.env };
  const status = (sets, checked = new Date(Date.now() - 36e5).toISOString()) => { IO.fetch = async () => ({ ok: true, json: async () => ({ checked, sets }) }); };
  const fail = verdict(parse(fake.replace("12 cars audited", "3 cars audited")), "x");
  IO.env = { GITHUB_EVENT_NAME: "schedule" };
  status({ active: { ok: false }, tech: { ok: true }, wltp: { ok: true } });
  let s = await sameOutage(fail);
  ok(s && s.silent && /שומר מאגרי משרד התחבורה כבר דיווח/.test(s.text) && s.text.startsWith("<b>🔵 לידיעה") && s.text.includes("👌") && s.text.includes("רכב פרטי ומסחרי"), "active register down this morning: same outage, silent");
  ok(await sameOutage(v) === null, "a field mismatch is never put down to an outage");
  IO.env = { GITHUB_EVENT_NAME: "workflow_dispatch" };
  s = await sameOutage(fail);
  ok(s && !s.silent, "a run started by a deploy still rings, with the line");
  IO.env = { GITHUB_EVENT_NAME: "schedule" };
  status({ active: { ok: true }, wltp: { ok: false } });
  ok(await sameOutage(fail) === null, "a register the audit does not read being down explains nothing");
  status({ active: { ok: false } }, new Date(Date.now() - 13 * 36e5).toISOString());
  ok(await sameOutage(fail) === null, "a reading older than 12 hours is not used");
  IO.fetch = async () => { throw new Error("offline"); };
  ok(await sameOutage(fail) === null, "status.json unreadable: rings as before");
  Object.assign(IO, keep);
}

if (process.argv.includes("--selftest")) await selftest();
else process.exitCode = await main();
