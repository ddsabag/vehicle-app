// The /live calendar's daily upkeep (branch "calendar", calendar.json), the mechanical part of the measurement thread's morning refresh, as a bot
// (Dudu 1.11.2026 21:40 UTC: "כן, לבנות בוט"; Claude comes in only for new items). Runs in Live watch after the bots board:
//   - the ids Dudu marked «בוצע» on /live (metrics.json "calDone", copied there by bots-status.mjs) leave "open" and "items" for good;
//   - a past day's items leave the calendar; one that needed Dudu (me=1) and was not marked done moves to "open", so nothing of his is lost;
//   - the release guard's days follow its own log line ("release guard <day>: <state> <version> from <D0>, day N vs <base>", the latest
//     run on main that judged today, whoever started it): days 1, 3 and 7 are judged on D0+2, D0+4 and D0+8 at 06:23 Israel; a new version
//     replaces the old one's days still ahead.
//   - the publishing board, "pubs" (Dudu 5.11.2026 18:46 UTC: "לוח בדשבורד שמראה לי מתי מתוזמנים ... כתבה במגזין, פוסט בטיקטוק, אינסטגרם,
//     פייסבוק, פרסומים בקבוצות"), rebuilt on every run from what actually schedules each post, never typed by hand: the autopost queue
//     (branch social-queue, Facebook and Instagram, with each target's outcome and link), the magazine's own crons (magazine.yml on main),
//     and "pubrules" in calendar.json for what runs on Dudu's PC (Cowork tasks, which no API shows; the marketing thread owns those lines).
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

export function refresh(cal, { today, done = [], guard = null, pubs = null }) {
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
  if (Array.isArray(pubs) && JSON.stringify(pubs) !== JSON.stringify(c.pubs || [])) { c.pubs = pubs; log.push("pubs: " + pubs.length); }   // null = not read this run: the last board stays
  return { cal: c, changed: log.length > 0, log };
}

// ---- the publishing board: pure parts (selftested) ----
export const PUB_DAYS = 14, PUB_BACK = 2;
const H23 = { timeZone: "Asia/Jerusalem", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" };
export function ilDT(ms) { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", H23).formatToParts(new Date(ms)).map(x => [x.type, x.value])); return { d: `${p.year}-${p.month}-${p.day}`, t: `${p.hour}:${p.minute}` }; }
// Israel wall time -> UTC ms (the offset of that day, so summer and winter both hold)
export function ilMs(d, t) { const guess = Date.parse(`${d}T${t}:00Z`); const g = ilDT(guess), back = Date.parse(`${g.d}T${g.t}:00Z`) - guess; return guess - back; }
// a cron line's times between two moments (UTC; numbers, lists and ranges, which is all the workflows use; dom and dow both set = either)
export function cronTimes(expr, from, to) {
  const f = String(expr).trim().split(/\s+/); if (f.length !== 5) return [];
  const set = (x, lo, hi) => { if (x === "*") return null; const out = new Set(); for (const part of x.split(",")) { const m = /^(\d+)(?:-(\d+))?$/.exec(part); if (!m) return undefined; for (let v = +m[1]; v <= +(m[2] ?? m[1]); v++) if (v >= lo && v <= hi) out.add(v); } return out; };
  const [mi, ho, dom, mon, dow] = [set(f[0], 0, 59), set(f[1], 0, 23), set(f[2], 1, 31), set(f[3], 1, 12), set(f[4], 0, 7)];
  if ([mi, ho, dom, mon, dow].includes(undefined) || !mi || !ho) return [];
  const out = [];
  for (let day = Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), new Date(from).getUTCDate()); day <= to; day += 864e5) {
    const D = new Date(day), wd = D.getUTCDay();
    if (mon && !mon.has(D.getUTCMonth() + 1)) continue;
    const okDom = !dom || dom.has(D.getUTCDate()), okDow = !dow || dow.has(wd) || (wd === 0 && dow.has(7));
    if (dom && dow ? !(okDom || okDow) : !(okDom && okDow)) continue;
    for (const h of [...ho].sort((a, b) => a - b)) for (const m of [...mi].sort((a, b) => a - b)) { const t = day + h * 36e5 + m * 6e4; if (t >= from && t <= to) out.push(t); }
  }
  return out;
}
const TYPE = { image: "פוסט", carousel: "קרוסלה", story: "סטורי", reel: "ריל", video: "סרטון", text: "פוסט" };
const PLURAL = { סטורי: "סטוריז", פוסט: "פוסטים", קרוסלה: "קרוסלות", ריל: "רילים", סרטון: "סרטונים" };
const OK_ST = new Set(["done", "missed", "failed", "unsure"]), RANK_ST = { failed: 5, missed: 4, unsure: 3, planned: 2, wait: 1, done: 0 };
const OK_LINK = /^https:\/\/(www\.)?(facebook|instagram|tiktok)\.com\//;
// kits = [{ kit, items }], state = social-queue state.json, magCrons = the cron strings of magazine.yml, rules = calendar.json "pubrules"
export function buildPubs({ kits = [], state = {}, magCrons = [], rules = [], now = Date.now() }) {
  const from = now - PUB_BACK * 864e5, to = now + PUB_DAYS * 864e5, out = [], posts = (state && state.posts) || {}, grp = new Map();
  for (const k of kits) for (const it of (k && Array.isArray(k.items) ? k.items : [])) {
    const at = Date.parse(it.at || ""); if (!(at >= from && at <= to)) continue;
    const ch = (Array.isArray(it.targets) ? it.targets : []).filter(x => /^(facebook|instagram|tiktok)$/.test(x)); if (!ch.length) continue;
    const label = TYPE[it.type] || "פוסט", key = at + "|" + label + "|" + ch.join(",");
    const st = {}, link = {};
    for (const c of ch) { const p = posts[`${k.kit}/${it.id}/${c}`] || {}; st[c] = OK_ST.has(p.status) ? p.status : p.status === "ready" ? "wait" : "planned"; if (OK_LINK.test(p.link || "")) link[c] = p.link; }
    const g = grp.get(key);
    if (g) { g.n++; for (const c of ch) { if (RANK_ST[st[c]] > RANK_ST[g.st[c]]) g.st[c] = st[c]; if (!g.link[c] && link[c]) g.link[c] = link[c]; } }
    else grp.set(key, { at, label, ch, st, link, n: 1 });
  }
  for (const g of grp.values()) { const { d, t } = ilDT(g.at); out.push({ d, t, ch: g.ch, what: (g.n > 1 ? PLURAL[g.label] || g.label : g.label) + " מהערכה השבועית", src: "auto", st: g.st, ...(Object.keys(g.link).length ? { link: g.link } : {}) }); }
  for (const expr of magCrons) {
    const f = String(expr).trim().split(/\s+/), weekly = f[4] && f[4] !== "*", what = weekly ? "כתבת נתונים שבועית במגזין, כשיש נתון חדש" : "כתבת שוק הרכב החודשית במגזין";
    for (const at of cronTimes(expr, now, to)) { const { d, t } = ilDT(at); out.push({ d, t, ch: ["magazine"], what, src: "mag" }); }
  }
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!r || !Array.isArray(r.dow) || !/^\d\d:\d\d$/.test(r.t || "") || !/^[a-z_]{2,20}$/.test(r.ch || "") || !r.what) continue;
    for (let day = now - 864e5; day <= to; day += 864e5) {
      const { d } = ilDT(day), wd = new Date(d + "T12:00:00Z").getUTCDay();
      if (!r.dow.includes(wd) || (r.from && d < r.from) || (r.until && d > r.until)) continue;
      const at = ilMs(d, r.t); if (at < now || at > to) continue;
      out.push({ d, t: r.t, ch: [r.ch], what: String(r.what).slice(0, 120), src: "cowork" });
    }
  }
  const seen = new Set();
  return out.filter(o => { const k = o.d + o.t + o.ch.join() + o.what; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.d + a.t).localeCompare(b.d + b.t)).slice(0, 80);
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

// the board's sources: the queue's kits of the last three weeks and its state, magazine.yml's crons on main; null when any read fails
async function readPubs(repo, cal, now) {
  const file = async (path, ref) => { const r = await gh(`/repos/${repo}/contents/${path}?ref=${ref}`); if (!r.ok) throw new Error(path.split("/").pop() + " " + r.status); return Buffer.from((await r.json()).content, "base64").toString("utf8"); };
  const ls = await gh(`/repos/${repo}/contents/kits?ref=social-queue`); if (!ls.ok) throw new Error("kits " + ls.status);
  const since = ilDay(new Date(now - 21 * 864e5)), kits = [];
  for (const x of (await ls.json()).filter(x => x.type === "dir" && /^\d{4}-\d\d-\d\d$/.test(x.name) && x.name >= since)) {
    try { kits.push({ kit: x.name, items: (JSON.parse(await file(`kits/${x.name}/autopost.json`, "social-queue")).items) || [] }); } catch (e) { if (!/ 404$/.test(e.message)) throw e; }
  }
  const state = JSON.parse(await file("state.json", "social-queue"));
  const magCrons = [...(await file(".github/workflows/magazine.yml", "main")).matchAll(/cron:\s*["']([^"']+)["']/g)].map(m => m[1]);
  return buildPubs({ kits, state, magCrons, rules: cal.pubrules, now });
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
    const pubs = await readPubs(repo, cal, now.getTime()).catch(e => { console.log("calendar: publishing board not read,", e.message); return null; });
    const R = refresh(cal, { today, done: Array.isArray(done) ? done : [], guard, pubs });
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
  // the publishing board
  ok(cronTimes("7 8 6 * *", Date.parse("2026-11-01T00:00:00Z"), Date.parse("2026-12-10T00:00:00Z")).map(x => new Date(x).toISOString()).join() === "2026-11-06T08:07:00.000Z,2026-12-06T08:07:00.000Z", "monthly cron on the 6th");
  ok(cronTimes("30 5 * * 4", Date.parse("2026-11-05T06:00:00Z"), Date.parse("2026-11-20T00:00:00Z")).map(x => new Date(x).toISOString().slice(0, 10)).join() === "2026-11-12,2026-11-19", "weekly cron on Thursdays, after now only");
  ok(ilDT(Date.parse("2026-11-08T06:30:00Z")).t === "08:30" && ilMs("2026-11-08", "19:30") === Date.parse("2026-11-08T17:30:00Z") && ilMs("2026-07-01", "19:30") === Date.parse("2026-07-01T16:30:00Z"), "Israel time both ways, winter and summer");
  const NOW = Date.parse("2026-11-05T18:50:00Z");
  const P = buildPubs({ now: NOW, magCrons: ["7 8 6 * *", "30 5 * * 4"],
    kits: [{ kit: "2026-11-05", items: [{ id: "dealer", type: "image", at: "2026-11-08T06:30:00.000Z", targets: ["facebook", "instagram"] },
      { id: "story-1", type: "story", at: "2026-11-10T06:15:00.000Z", targets: ["facebook", "instagram"] }, { id: "story-2", type: "story", at: "2026-11-10T06:15:00.000Z", targets: ["facebook", "instagram"] }] },
      { kit: "2026-11-01", items: [{ id: "reel", type: "reel", at: "2026-11-04T18:30:00.000Z", targets: ["facebook", "instagram"] }, { id: "old", type: "image", at: "2026-10-30T06:30:00.000Z", targets: ["facebook"] }] }],
    state: { posts: { "2026-11-01/reel/facebook": { status: "done", link: "https://www.facebook.com/x_y" }, "2026-11-01/reel/instagram": { status: "failed" }, "2026-11-05/story-2/instagram": { status: "missed" } } },
    rules: [{ id: "fb-groups", dow: [0, 3], t: "19:30", ch: "fb_groups", what: "פרסום בקבוצות פייסבוק" }, { id: "x", dow: [4], t: "19:30", ch: "fb_groups", what: "חמישי", from: "2026-11-12" }] });
  const row = (d, t) => P.find(x => x.d === d && x.t === t);
  ok(row("2026-11-04", "20:30")?.st.facebook === "done" && row("2026-11-04", "20:30")?.st.instagram === "failed" && row("2026-11-04", "20:30")?.link.facebook && !P.some(x => x.d === "2026-10-30"), "a past post shows each target's outcome and link; older than the window is out");
  ok(row("2026-11-10", "08:15")?.what === "סטוריז מהערכה השבועית" && row("2026-11-10", "08:15")?.st.instagram === "missed" && P.filter(x => x.d === "2026-11-10" && x.t === "08:15").length === 1, "same-time stories are one row, the worst outcome wins");
  ok(row("2026-11-08", "08:30")?.st.facebook === "planned" && row("2026-11-06", "10:07")?.ch[0] === "magazine" && row("2026-11-12", "07:30")?.src === "mag", "planned autopost, the magazine's crons in Israel time");
  ok(row("2026-11-08", "19:30")?.src === "cowork" && row("2026-11-11", "19:30") && !row("2026-11-05", "19:30") && row("2026-11-12", "19:30")?.what === "חמישי" && !P.some(x => x.what === "חמישי" && x.d < "2026-11-12"), "Cowork rules: their days ahead only, from a start day");
  ok(P.every((x, i) => !i || (P[i - 1].d + P[i - 1].t) <= (x.d + x.t)) && P.every(x => !/\d/.test(x.what)), "sorted, no numbers in the text");
  { const c0 = { open: [], items: [], weekly: [], pubs: P }; ok(!refresh(c0, { today: "2026-11-05", pubs: P }).changed && refresh(c0, { today: "2026-11-05", pubs: P.slice(1) }).changed && !refresh(c0, { today: "2026-11-05", pubs: null }).changed && refresh(c0, { today: "2026-11-05", pubs: null }).cal.pubs.length === P.length, "the board is written only when it changed; a failed read keeps the last one"); }
  console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
}
