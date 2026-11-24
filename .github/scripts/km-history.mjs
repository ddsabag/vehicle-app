// Km history (data thread, 24.11.2026; Dudu "כן, להתחיל עכשיו" on the km card): the ministry's tech register keeps only each car's LAST test
// reading (kilometer_test_aharon), so a reading is lost the day the next test replaces it. This step of the vanished-cars run (vanished.yml)
// keeps every reading: one baseline, then the readings that changed since the run before. MOT data only, joined only with the MOT active
// register's last-test day, never with anything that identifies a person (data.gov.il terms of use; scoping note reports/km-history/).
// Plates never reach the public repository, its branches, artifacts or run logs (constitution rules 10-11): the readings go to the PRIVATE
// repository ddsabag/luchit-history (cloned by vanished.yml with the HISTORY_TOKEN secret), and the log prints counts only.
//   REPO (the private clone)   base/YYYY-MM-DD.bin.gz      every car's reading on the baseline day
//                              changes/YYYY-MM-DD.bin.gz   the readings that are new or changed on that run (append-only, never rewritten)
//                              meta.json  README.md
//   DIR (the vanished Actions cache)  km-latest.bin.gz + km-last.json: the newest reading per car, a shortcut only; when it is missing or
//                              does not match the repository's meta.json it is rebuilt from base + changes
// One record = REC bytes: plate u32, km u32, last test day u16 (days from 1990-01-01, 0 = none), sorted by plate.
//   node km-history.mjs                       DIR, REPO (KM_DRY=1: reads and counts, writes nothing anywhere)
//   node km-history.mjs tell token|fail|done  the router line for vanished.yml (done reads km-note.txt)
//   node km-history.mjs resolve               a good run closes open km items
//   node km-history.mjs selftest              offline
import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
import { REC as AREC } from "./vanished.mjs";
const API = "https://data.gov.il/api/3/action/datastore_search", PAGE = 30000, T0 = Date.now();
const TECH = "56063a99-8a3e-4ff4-912e-5966c0279bad";
const log = m => console.log(`[${Math.round((Date.now() - T0) / 1000)}s] ${m}`);
export const REC = 10;
const MAX_KM = 3e6, MIN_READINGS = 1e6, MAX_CHANGE = 0.25;   // a run that changes over a quarter of the cars is a broken read, not news

// ---- records ----
export function encode(map) {   // Map plate -> [km, day]  ->  Buffer sorted by plate
  const keys = [...map.keys()].sort((a, b) => a - b), b = Buffer.alloc(keys.length * REC);
  keys.forEach((p, i) => { const [km, d] = map.get(p); b.writeUInt32LE(p, i * REC); b.writeUInt32LE(km, i * REC + 4); b.writeUInt16LE(d, i * REC + 8); });
  return b;
}
export function decode(buf, map = new Map()) {   // later records replace earlier ones: replaying base + changes in date order gives the latest
  for (let o = 0; o + REC <= buf.length; o += REC) map.set(buf.readUInt32LE(o), [buf.readUInt32LE(o + 4), buf.readUInt16LE(o + 8)]);
  return map;
}
// this run's readings: the tech register's km for each car on the active register, with the active register's last-test day
export function join(kmByPlate, active) {   // active: vanished's details buffer (sorted, AREC bytes, last test day u16 at 14)
  const cur = new Map();
  for (let o = 0; o + AREC <= active.length; o += AREC) {
    const p = active.readUInt32LE(o), km = kmByPlate.get(p);
    if (p && km > 0) cur.set(p, [km, active.readUInt16LE(o + 14)]);
  }
  return cur;
}
// what changed: a car with no reading yet, or a different km or test day; `latest` is updated in place (a car missing today keeps its reading)
export function diff(latest, cur) {
  const ch = new Map();
  for (const [p, v] of cur) { const o = latest.get(p); if (!o || o[0] !== v[0] || o[1] !== v[1]) { ch.set(p, v); latest.set(p, v); } }
  return ch;
}
// the repository's files in replay order: the newest base, then every change file after it
export function replayList(repo) {
  const ls = d => { try { return fs.readdirSync(path.join(repo, d)).filter(f => /^\d{4}-\d\d-\d\d(-\d+)?\.bin\.gz$/.test(f)).sort(); } catch { return []; } };
  const bases = ls("base"); if (!bases.length) return [];
  const b = bases.at(-1);
  return [path.join("base", b), ...ls("changes").filter(f => f.slice(0, 10) >= b.slice(0, 10)).map(f => path.join("changes", f))];
}
const freeName = (dir, d) => { let n = `${d}.bin.gz`; for (let i = 2; fs.existsSync(path.join(dir, n)); i++) n = `${d}-${i}.bin.gz`; return n; };
const mb = n => (n / 1048576).toFixed(1) + " MB";

// ---- the run ----
async function call(params, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(API + "?" + new URLSearchParams(params), { signal: AbortSignal.timeout(120000) }); const j = await r.json(); if (j.success) return j.result; } catch {}
    await new Promise(r => setTimeout(r, 4000 * (i + 1)));
  }
  throw new Error("failed " + JSON.stringify(params).slice(0, 100));
}
async function scanTech() {
  const km = new Map(); let n = 0;
  for (let off = 0; ; off += PAGE) {
    const r = await call({ resource_id: TECH, limit: String(PAGE), offset: String(off), sort: "_id", fields: "mispar_rechev,kilometer_test_aharon" });
    for (const x of r.records) { const p = Number(x.mispar_rechev), k = Number(x.kilometer_test_aharon); if (p > 0 && k > 0 && k <= MAX_KM) km.set(p, Math.round(k)); }
    n += r.records.length;
    if (r.records.length < PAGE) {   // as in vanished.mjs: a short page ends the read only when nothing lies past it
      const more = await call({ resource_id: TECH, limit: "1", offset: String(n), sort: "_id", fields: "_id" });
      if (more.records.length) throw new Error(`tech register: the read stopped after ${n} rows, and the register goes on`);
      break;
    }
  }
  return { km, rows: n };
}

export async function run() {
  const DIR = process.env.DIR || "vanished-state", REPO = process.env.REPO || "km-repo", DRY = process.env.KM_DRY === "1", today = new Date().toISOString().slice(0, 10);
  const rd = (d, f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), "utf8")); } catch { return null; } };
  // 1. the active register as vanished.mjs left it in DIR this morning (no second read of 3.9M rows)
  const last = rd(DIR, "last.json");
  if (!last || !fs.existsSync(path.join(DIR, "details.bin.gz"))) throw new Error("no active-register records in " + DIR);
  if (!DRY && last.date !== today) throw new Error(`the active-register records are from ${last.date}, not today`);
  const active = zlib.gunzipSync(fs.readFileSync(path.join(DIR, "details.bin.gz")));
  log(`active records ${active.length / AREC} (${last.date})`);
  // 2. the tech register's km
  const { km, rows } = await scanTech();
  const cur = join(km, active); km.clear();
  log(`tech rows ${rows}, readings joined ${cur.size}`);
  if (cur.size < MIN_READINGS) throw new Error(`only ${cur.size} readings, not trusting this run`);
  // 3. the newest reading per car: the cache when it matches the repository, else a replay of the repository
  const meta = DRY ? null : rd(REPO, "meta.json"), kl = rd(DIR, "km-last.json");
  let latest = null, from = "";
  if (fs.existsSync(path.join(DIR, "km-latest.bin.gz")) && kl && (DRY || (meta && kl.date === meta.updated && kl.files === meta.files))) {
    latest = decode(zlib.gunzipSync(fs.readFileSync(path.join(DIR, "km-latest.bin.gz")))); from = "cache";
  } else if (!DRY) {
    const list = replayList(REPO);
    if (list.length) { latest = new Map(); for (const f of list) decode(zlib.gunzipSync(fs.readFileSync(path.join(REPO, f))), latest); from = `repository (${list.length} files)`; }
  }
  log(latest ? `last readings ${latest.size}, from the ${from}` : "no readings yet: this run writes the baseline");
  // 4. the change, guarded
  const base = !latest, ch = base ? cur : diff(latest, cur);
  if (!base && ch.size > MAX_CHANGE * latest.size) throw new Error(`${ch.size} of ${latest.size} readings changed since the last run, not trusting this run`);
  const file = base ? "base" : "changes", buf = encode(ch), gz = zlib.gzipSync(buf, { level: 9 });
  log(`${base ? "baseline readings" : "new or changed readings"} ${ch.size}, ${mb(gz.length)} compressed`);
  if (DRY) { log("dry run: nothing written"); return; }
  // 5. write the repository, then the cache shortcut
  let name = "";
  if (ch.size) { fs.mkdirSync(path.join(REPO, file), { recursive: true }); name = freeName(path.join(REPO, file), today); fs.writeFileSync(path.join(REPO, file, name), gz); }
  const files = replayList(REPO).length, total = base ? cur : latest;
  const m = { updated: today, files, readings: total.size, lastRun: { date: today, kind: file, changed: ch.size, bytes: gz.length },
    format: `records of ${REC} bytes sorted by plate: plate u32 LE, km u32 LE, last test day u16 LE (days from 1990-01-01, 0 = none); replay the newest base/ then changes/ in name order, a later record replaces an earlier one` };
  m.firstBase = (meta && meta.firstBase) || today;
  fs.writeFileSync(path.join(REPO, "meta.json"), JSON.stringify(m, null, 1) + "\n");
  if (!fs.existsSync(path.join(REPO, "README.md"))) fs.writeFileSync(path.join(REPO, "README.md"), README);
  fs.writeFileSync(path.join(DIR, "km-latest.bin.gz"), zlib.gzipSync(encode(total), { level: 6 }));
  fs.writeFileSync(path.join(DIR, "km-last.json"), JSON.stringify({ date: today, files }));
  if (base) fs.writeFileSync("km-note.txt", `ארכיון הק״מ התחיל: ${cur.size.toLocaleString("en-US")} קריאות ק״מ נשמרו כבסיס במאגר הפרטי (${mb(gz.length)}). מעכשיו נשמרים רק השינויים, פעמיים בשבוע.`);
  log(`written ${name ? file + "/" + name : "(no change file)"}, meta.json`);
}
const README = `# luchit-history (private)

Odometer readings from the Israeli Ministry of Transport's open data (data.gov.il, tech register 56063a99, field kilometer_test_aharon),
with the last-test day from the active register 053cea08. Collected by vanished.yml in ddsabag/vehicle-app.

Source: data.gov.il, Ministry of Transport. Use under the data.gov.il terms of use: keep the source line, never join with data that
identifies a person, never present this as official ministry data.

Format: see meta.json. Files are append-only; nothing is ever rewritten.
`;

// ---- router lines ----
async function tell(kind) {
  let router = null; try { router = await import("./alert.mjs"); } catch {}
  if (!router) return;
  const link = process.env.RUN_URL || "";
  try {
    if (kind === "token") await router.alert("day", "km:token", "ארכיון הק״מ לא נשמר: אין גישה למאגר הפרטי ddsabag/luchit-history. כנראה שהטוקן HISTORY_TOKEN חסר או שפג תוקפו. צריך ליצור טוקן חדש רק לאותו מאגר (Contents: קריאה וכתיבה) ולהדביק אותו בסוד HISTORY_TOKEN. בוט הנעלמים עצמו רץ כרגיל.", link, { today: "loud", legacy: () => false });
    else if (kind === "fail") await router.alert("summary", "km:fail", "ארכיון הק״מ לא נשמר בריצה הזאת. בוט הנעלמים עצמו רץ כרגיל, והריצה הבאה משלימה את מה שחסר מהמאגר הפרטי.", link, { today: "silent", legacy: () => false });
    else if (kind === "done") { const t = fs.readFileSync("km-note.txt", "utf8"); await router.resolve(["km:token", "km:fail"]); await router.alert("summary", "km:done", t, link, { today: "silent", legacy: () => false }); }
    else if (kind === "resolve") await router.resolve(["km:token", "km:fail"]);
  } catch (e) { console.log("router: " + e.message); }
}

function selftest() {
  let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  // vanished's active records: plate @0, last test day @14
  const act = Buffer.alloc(4 * AREC); [[1000001, 12000], [2000002, 12500], [3000003, 0], [4000004, 13000]].forEach(([p, d], i) => { act.writeUInt32LE(p, i * AREC); act.writeUInt16LE(d, i * AREC + 14); });
  const cur = join(new Map([[1000001, 50000], [3000003, 120000], [9000009, 7]]), act);
  ok(cur.size === 2 && cur.get(1000001)[1] === 12000 && cur.get(3000003)[0] === 120000 && !cur.has(9000009) && !cur.has(2000002), "only cars on both registers with km, with the active register's test day");
  const b = encode(new Map([[3, [30, 3]], [1, [10, 1]], [2, [20, 2]]]));
  ok(b.length === 3 * REC && b.readUInt32LE(0) === 1 && b.readUInt32LE(2 * REC) === 3 && decode(b).get(2)[0] === 20, "records sorted by plate and read back");
  const latest = decode(b), ch = diff(latest, new Map([[1, [10, 1]], [2, [25, 9]], [4, [40, 4]]]));
  ok(ch.size === 2 && ch.has(2) && ch.has(4) && !ch.has(1) && latest.get(2)[0] === 25 && latest.get(3)[0] === 30, "a new car and a new reading change; the same reading does not; a car missing today keeps its reading");
  ok(diff(latest, new Map([[2, [20, 9]]])).size === 1, "a lower km is kept (a rollback is the point of the archive)");
  // a repository on disk: base, two change files, an older base and a stray file; the replay gives the cache's answer
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "km-")), w = (d, f, m) => { fs.mkdirSync(path.join(tmp, d), { recursive: true }); fs.writeFileSync(path.join(tmp, d, f), zlib.gzipSync(encode(m))); };
  w("base", "2026-11-01.bin.gz", new Map([[1, [1, 1]]])); w("base", "2026-11-25.bin.gz", new Map([[1, [10, 1]], [2, [20, 2]]]));
  w("changes", "2026-11-20.bin.gz", new Map([[1, [999, 9]]])); w("changes", "2026-11-29.bin.gz", new Map([[2, [21, 3]]])); w("changes", "2026-11-29-2.bin.gz", new Map([[3, [30, 3]]]));
  fs.writeFileSync(path.join(tmp, "changes", "notes.txt"), "x");
  const list = replayList(tmp), rep = new Map(); for (const f of list) decode(zlib.gunzipSync(fs.readFileSync(path.join(tmp, f))), rep);
  ok(list.length === 3 && list[0] === path.join("base", "2026-11-25.bin.gz") && rep.get(1)[0] === 10 && rep.get(2)[0] === 21 && rep.get(3)[0] === 30, "replay: the newest base, then the change files after it, in order");
  ok(freeName(path.join(tmp, "changes"), "2026-11-29") === "2026-11-29-3.bin.gz" && freeName(path.join(tmp, "changes"), "2026-12-02") === "2026-12-02.bin.gz", "a second run on one day never overwrites a file");
  ok(replayList(path.join(tmp, "none")).length === 0, "an empty repository means a baseline");
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(bad ? `selftest: ${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith("km-history.mjs")) {
  const a = process.argv[2];
  if (a === "selftest") selftest();
  else if (a === "tell") await tell(process.argv[3]);
  else if (a === "resolve") await tell("resolve");
  else await run();
}
