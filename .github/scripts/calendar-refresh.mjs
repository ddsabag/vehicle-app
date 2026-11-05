// The /live calendar's daily upkeep (branch "calendar", calendar.json), the mechanical part of the measurement thread's morning refresh, as a bot
// (Dudu 1.11.2026 21:40 UTC: "כן, לבנות בוט"; Claude comes in only for new items). Runs in Live watch after the bots board:
//   - the ids Dudu marked «בוצע» on /live (metrics.json "calDone", copied there by bots-status.mjs) leave "open" and "items" for good;
//   - a past day's items leave the calendar; one that needed Dudu (me=1) and was not marked done moves to "open", so nothing of his is lost;
//   - the release guard's days follow its own log line ("release guard <day>: <state> <version> from <D0>, day N vs <base>", the latest
//     run on main that judged today, whoever started it): days 1, 3 and 7 are judged on D0+2, D0+4 and D0+8 at 06:23 Israel; a new version
//     replaces the old one's days still ahead.
// Only fixed Hebrew text is written (no numbers, no ids beyond the item ids), and only when something changed: a commit on top of the branch
// through the contents API (never a force push). New items, and items whose outcome is visible elsewhere, stay with the measurement thread.
//   node calendar-refresh.mjs            needs GITHUB_TOKEN, GITHUB_REPOSITORY; DRY=1 prints what would change
//   node calendar-refresh.mjs selftest   offline
import { getMetric } from "./flash.mjs";

const API = "https://api.github.com", BR = "calendar", FILE = "calendar.json";
export const GUARD_AT = "06:23", GUARD_DAYS = { 1: 2, 3: 4, 7: 8 };
const GUARD_WHAT = { 1: "בדיקה אוטומטית של הגרסה החדשה, יום אחרי", 3: "בדיקה אוטומטית של הגרסה החדשה, שלושה ימים אחרי", 7: "בדיקה אוטומטית של הגרסה החדשה, שבוע אחרי" };
const addD = (d, k) => new Date(Date.parse(d + "T12:00:00Z") + k * 864e5).toISOString().slice(0, 10);
export const ilDay = (now = new Date()) => now.toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });

// "release guard 2026-11-01: wait 1.38.3 from 2026-10-27, day 4 vs 1.37" -> { vn, d0 }; a line without a version (no data) -> null
export function guardLine(log) {
  const m = /release guard (\d{4}-\d\d-\d\d): (\w+) (\d+(?:\.\d+)+) from (\d{4}-\d\d-\d\d), day (-?\d+)/.exec(String(log || ""));
  return m ? { day: m[1], state: m[2], vn: m[3], d0: m[4] } : null;
}
// the line only counts for the day it judged: a dry run by hand "as if today were" another day is skipped
export const guardToday = (log, today) => { const g = guardLine(log); return g && g.day === today ? g : null; };

export function refresh(cal, { today, done = [], guard = null }) {
  const c = JSON.parse(JSON.stringify(cal)), gone = new Set(done), log = [];
  c.open = Array.isArray(c.open) ? c.open : []; c.items = Array.isArray(c.items) ? c.items : [];
  const nO = c.open.length, nI = c.items.length;
  c.open = c.open.filter(x => !gone.has(x.id)); c.items = c.items.filter(x => !gone.has(x.id));
  if (c.open.length + c.items.length < nO + nI) log.push(`done marks: ${nO + nI - c.open.length - c.items.length}`);
  // a past day: out; Dudu's own item that he did not mark moves to "open"
  const keep = [];
  for (const x of c.items) {
    if (!x.d || x.d >= today) { keep.push(x); continue; }
    if (x.me === 1 && !c.open.some(o => o.id === x.id)) { c.open.push({ id: x.id, what: x.what, owner: x.owner, me: 1, ...(x.ask ? { ask: x.ask } : {}) }); log.push("to open: " + x.id); }
    else log.push("past: " + x.id);
  }
  c.items = keep;
  if (guard && guard.vn && guard.d0) {
    const pre = "relguard-" + guard.vn.replace(/\D/g, "") + "-d";
    c.items = c.items.filter(x => { const old = /^relguard-/.test(x.id) && !x.id.startsWith(pre); if (old) log.push("old version: " + x.id); return !old; });
    for (const [n, k] of Object.entries(GUARD_DAYS)) {
      const id = pre + n, d = addD(guard.d0, k);
      const it = c.items.find(x => x.id === id);
      if (d < today || gone.has(id)) { if (it) { c.items = c.items.filter(x => x !== it); log.push("guard day passed: " + id); } continue; }
      if (!it) { c.items.push({ id, d, t: GUARD_AT, what: GUARD_WHAT[n], owner: "מדידה", me: 0 }); log.push("guard day: " + id + " " + d); }
      else if (it.d !== d || it.t !== GUARD_AT) { it.d = d; it.t = GUARD_AT; log.push("guard day moved: " + id + " " + d); }
    }
  }
  c.items.sort((a, b) => (a.d || "").localeCompare(b.d || "") || (a.t ? 0 : 1) - (b.t ? 0 : 1) || (a.t || "").localeCompare(b.t || ""));
  return { cal: c, changed: log.length > 0, log };
}

async function gh(path, opt = {}) {
  const h = { authorization: "Bearer " + process.env.GITHUB_TOKEN, accept: "application/vnd.github+json", "user-agent": "luchit-calendar", "content-type": "application/json", ...(opt.headers || {}) };
  return fetch(API + path, { ...opt, headers: h, signal: AbortSignal.timeout(20000) });
}

// the newest Release guard run on main that judged today (Israel), whoever started it: GitHub's schedule, or the backup clock's dispatch
// when GitHub is late (4-5.11: the schedule ran at 12:15 UTC and the clock's 06:21 run was the only one by the morning, so a reader of
// scheduled runs between 04 and 09 UTC alone never saw the new version and its days never reached the calendar). Newest first; stops at
// yesterday's runs, so a quiet day costs one request.
async function readGuard(repo, now) {
  const today = ilDay(now);
  const r = await gh(`/repos/${repo}/actions/workflows/release-guard.yml/runs?branch=main&status=completed&per_page=5`);
  if (!r.ok) throw new Error("guard runs " + r.status);
  for (const run of (await r.json()).workflow_runs || []) {
    if (ilDay(new Date(run.created_at)) < today) break;
    const jobs = await (await gh(`/repos/${repo}/actions/runs/${run.id}/jobs`)).json();
    for (const j of jobs.jobs || []) {
      const l = await gh(`/repos/${repo}/actions/jobs/${j.id}/logs`);
      const g = l.ok ? guardToday(await l.text(), today) : null;
      if (g) return g;
    }
  }
  return null;
}

if (process.argv[1] && process.argv[1].endsWith("calendar-refresh.mjs") && process.argv[2] !== "selftest") {
  const repo = process.env.GITHUB_REPOSITORY, now = new Date(), today = ilDay(now);
  try {
    if (!process.env.GITHUB_TOKEN || !repo) throw new Error("no token");
    const r = await gh(`/repos/${repo}/contents/${FILE}?ref=${BR}`);
    if (!r.ok) throw new Error("read " + r.status);
    const j = await r.json(), cal = JSON.parse(Buffer.from(j.content, "base64").toString("utf8"));
    const done = ((await getMetric("calDone")) || {}).ids || [];
    let guard = null;
    guard = await readGuard(repo, now).catch(e => { console.log("calendar: guard not read,", e.message); return null; });   // every run: GitHub starts the guard hours late
    const R = refresh(cal, { today, done: Array.isArray(done) ? done : [], guard });
    console.log("calendar " + today + ": " + (R.changed ? R.log.join("; ") : "no change") + (guard ? `, guard ${guard.vn} from ${guard.d0}` : ""));
    if (R.changed && process.env.DRY !== "1") {
      R.cal.at = now.toISOString().replace(/\.\d+Z$/, "Z");
      const w = await gh(`/repos/${repo}/contents/${FILE}`, { method: "PUT", body: JSON.stringify({ message: "calendar: daily upkeep " + today + " (bot)", branch: BR, sha: j.sha,
        content: Buffer.from(JSON.stringify(R.cal, null, 1) + "\n").toString("base64") }) });
      console.log(w.ok ? "calendar written" : "calendar not written " + w.status + " (another write came first; the next run retries)");
    }
  } catch (e) { console.log("calendar skipped:", e.message || e); }
}

if (process.argv[2] === "selftest") {
  let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  const cal = { at: "x", open: [{ id: "a-open", what: "w", owner: "מדידה", me: 1 }], weekly: [{ when: "ראשון", what: "w", owner: "מדידה" }], items: [
    { id: "old0", d: "2026-10-31", t: "09:00", what: "w", owner: "מדידה", me: 0 },
    { id: "old1", d: "2026-10-31", what: "לקרוא", owner: "מוצר ושחרורים", me: 1, ask: "למה" },
    { id: "relguard-1383-d7", d: "2026-11-04", t: "06:23", what: "w", owner: "מדידה", me: 0 },
    { id: "late", d: "2026-11-02", what: "w", owner: "SEO", me: 0 },
    { id: "early", d: "2026-11-02", t: "08:00", what: "w", owner: "SEO", me: 1 },
    { id: "today", d: "2026-11-01", t: "07:00", what: "w", owner: "SEO", me: 0 } ] };
  let R = refresh(cal, { today: "2026-11-01", done: ["a-open", "early"] });
  ok(!R.cal.open.some(o => o.id === "a-open") && !R.cal.items.some(x => x.id === "early"), "done marks leave open and items");
  ok(!R.cal.items.some(x => x.id === "old0") && R.cal.open.some(o => o.id === "old1" && o.me === 1 && o.ask === "למה" && !o.d), "a past day out; Dudu's unmarked item moves to open");
  ok(R.cal.items.some(x => x.id === "today") && R.cal.weekly.length === 1, "today stays; weekly untouched");
  ok(R.cal.items.map(x => x.id).join() === "today,relguard-1383-d7,late".replace("relguard-1383-d7,late", "late,relguard-1383-d7") || R.cal.items.map(x => x.id).join() === "today,late,relguard-1383-d7", "sorted by day, untimed last in its day: " + R.cal.items.map(x => x.id).join());
  R = refresh(cal, { today: "2026-11-01", guard: guardLine("x\nrelease guard 2026-11-01: wait 1.38.3 from 2026-10-27, day 4 vs 1.37\n") });
  ok(R.cal.items.filter(x => /^relguard/.test(x.id)).map(x => x.id + " " + x.d).join() === "relguard-1383-d7 2026-11-04" && !R.log.some(l => /guard day:/.test(l)), "same version: days already passed are not added, day 7 stays: " + R.log.join("; "));
  R = refresh(cal, { today: "2026-11-02", guard: guardLine("release guard 2026-11-02: wait 1.38.4 from 2026-11-01, day 0 vs 1.38.3") });
  const g = R.cal.items.filter(x => /^relguard/.test(x.id));
  ok(g.map(x => x.id + " " + x.d + " " + x.t).join() === "relguard-1384-d1 2026-11-03 06:23,relguard-1384-d3 2026-11-05 06:23,relguard-1384-d7 2026-11-09 06:23", "a new version: its days at D0+2, +4, +8, the old one's out: " + g.map(x => x.id + " " + x.d).join());
  ok(g.every(x => x.owner === "מדידה" && x.me === 0 && !/\d/.test(x.what)), "fixed text, no numbers");
  R = refresh(cal, { today: "2026-11-02", guard: guardLine("release guard 2026-11-02: wait 1.38.3 from 2026-10-28, day 4 vs 1.37") });
  ok(R.cal.items.find(x => x.id === "relguard-1383-d7").d === "2026-11-05", "D0 moved: the date follows");
  ok(guardToday("release guard 2026-11-05: wait 1.38.4 from 2026-11-04, day 0 vs 1.38.3", "2026-11-05")?.vn === "1.38.4" && guardToday("release guard 2026-11-03: wait 1.38.4 from 2026-11-04, day -1 vs 1.38.3", "2026-11-05") === null, "only a line that judged today counts (a dry run as if another day is skipped)");
  ok(guardLine("release guard 2026-11-02: no data") === null && guardLine("release guard 2026-11-02: find 1.38.3 from 2026-10-27, day 3 vs 1.37, findings: silent").vn === "1.38.3", "lines without a version are ignored");
  R = refresh(R.cal, { today: "2026-11-02", guard: guardLine("release guard 2026-11-02: wait 1.38.3 from 2026-10-28, day 4 vs 1.37") });
  ok(!R.changed, "a second run changes nothing (idempotent): " + R.log.join("; "));
  ok(ilDay(new Date("2026-11-01T22:30:00Z")) === "2026-11-02", "the day is Israel's");
  console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
}
