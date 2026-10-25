// Sunday block on top of the weekly brief (analytics/run.py): "מחכה לך", dead-man (workflows, data files, the router itself),
// this week's failures, FYI items and alert counts. Plain text (notify.py sends without parse_mode), at most 1,800 characters.
// Reads the router state (alert-state, through alert.mjs), open PRs, scheduled workflow runs, the data files the app reads and
// luchit-uptime's /health. Every source is fetched in parallel with its own timeout; a failing source gives one line, the rest stays.
//   node .github/scripts/waiting.mjs <out file>   writes the block to the file, never to stdout (the public job log gets no numbers)
//                                                 exit 0; 3 = written, but the state was not read while summary/silent are routed
//                                                 (run.py then does not mark the summary as sent, so nothing queued is skipped)
//   node .github/scripts/waiting.mjs --selftest   offline (mocked fetch, fixtures, fixed clock)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEVELS, LABELS, label, routed, ilTime, readState } from "./alert.mjs";
import { SETS } from "./datasets.mjs";

const SELF = fileURLToPath(import.meta.url), WF_DIR = path.resolve(path.dirname(SELF), "../workflows");
const H = 36e5, D = 864e5;
export const T = { req: 10000, all: 40000 };   // per request; whole collect (run.py allows 120 s)
const CAP = { lines: 6, block: 1800, line: 300 };
const RAW = "https://raw.githubusercontent.com/ddsabag/vehicle-app/";
// the files the app reads, and when each counts as stale (from its writer on main, checked on Sunday at 08:xx Jerusalem time)
export const FILES = [
  // models/market/modelstats.yml run monthly (5th, 5th, 6th) and every run writes today's date: 31 days + a week to fix a failed month
  { url: "https://luchit.app/models.json", name: "models.json", f: "updated", days: 40 },
  { url: "https://luchit.app/market.json", name: "market.json", f: "updated", days: 40 },
  { url: "https://luchit.app/modelstats.json", name: "modelstats.json", f: "updated", days: 40 },
  // fuel.yml runs daily but fuel.mjs writes only on a change, and always on a new month: 31 days + 3 days before the run itself goes red
  // (no price for the month on the 3rd) + a day of deploy lag
  { url: "https://luchit.app/fuel.json", name: "fuel.json", f: "checked", days: 35 },
  // data-status.yml: daily 05:40 UTC, force-pushed every run with an ISO time: 2 x 24 h + 6 h, the workflow rule (one dropped run passes)
  { url: RAW + "data-status/status.json", name: "status.json (מצב המאגרים)", f: "checked", hours: 54 },
  // catalog.yml: daily 09:20 UTC, force-pushed every run with the UTC date; on Sunday morning the newest is Saturday's,
  // so more than 2 days back = two dropped runs
  { url: RAW + "catalog-data/meta.json", name: "meta.json (הקטלוג)", f: "u", days: 2 },
];
const OFF_HE = { disabled_inactivity: "כבה אחרי 60 יום בלי פעילות במאגר", disabled_manually: "כובה ידנית", disabled_fork: "כבוי בפורק" };
const dm = t => ilTime(new Date(t)).slice(0, 5);                      // DD.MM, Jerusalem
const day = t => Math.floor(t / D);                                  // UTC day number (the files' dates are UTC dates)
const med = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const plural = (n, one, many) => (n === 1 ? one : `${n} ${many}`);

// ---- dead-man rules (pure) ----
// scheduled runs, newest first after sorting; gaps under 2 h are the paired UTC/DST lines. Skips fewer than 3 runs and monthly jobs.
// Late when the newest run is older than the median span of two consecutive gaps + 6 h: for an even cadence that is spec's 2 x median
// (daily: 54 h, one dropped run passes, two do not); for uneven ones (3 a day at 5/6/13 h, twice a day at 6/18 h) it still lets one drop pass.
export function wfLate(times, now) {
  const t = times.map(x => Date.parse(x)).filter(Number.isFinite).sort((a, b) => b - a);
  if (t.length < 3) return null;
  const gaps = t.slice(1).map((x, i) => t[i] - x).filter(g => g >= 2 * H);
  if (!gaps.length || med(gaps) >= 20 * D) return null;
  const span = gaps.length > 1 ? med(gaps.slice(1).map((g, i) => g + gaps[i])) : 2 * gaps[0];
  return now - t[0] > span + 6 * H ? t[0] : null;
}
// one data file: null when fresh, else the 🪦 line
export function fileStale(F, j, now) {
  const v = j && typeof j === "object" ? j[F.f] : null, t = typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) return `${F.name}: אין תאריך עדכון`;
  const old = F.hours ? now - t > F.hours * H : day(now) - day(t) > F.days;
  return old ? `${F.name} לא עודכן מאז ${F.hours ? ilTime(new Date(t)) : dm(t)}` : null;
}

// ---- sources (network; every request has its own timeout and the whole collect has a deadline) ----
const repo = env => env.GITHUB_REPOSITORY || "ddsabag/vehicle-app";
async function getJSON(url, dl, token) {
  const sig = AbortSignal.any ? AbortSignal.any([AbortSignal.timeout(T.req), dl]) : AbortSignal.timeout(T.req);
  const r = await fetch(url, { signal: sig, headers: { "user-agent": "luchit-waiting", accept: token === undefined ? "application/json" : "application/vnd.github+json",
    ...(token ? { authorization: "Bearer " + token } : {}) } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}
// workflow files on disk: [{file, name, scheduled}] (dynamic, so renamed or merged workflows need no edit here)
export function wfFiles(dir = WF_DIR) {
  return fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort().map(file => {
    const s = fs.readFileSync(path.join(dir, file), "utf8");
    return { file, name: ((/^name:\s*(.+?)\s*$/m.exec(s) || [])[1] || file).replace(/^["']|["']$/g, ""), scheduled: /^\s*schedule:/m.test(s) };
  });
}
async function workflows(env, now, dl, list, late) {
  const api = `https://api.github.com/repos/${repo(env)}/actions/workflows`, tok = env.GITHUB_TOKEN || "";
  const all = (await getJSON(api + "?per_page=100", dl, tok)).workflows || [];
  const byPath = new Map(all.map(w => [w.path, w]));
  const off = [], lateL = [];
  let unchecked = 0;
  await Promise.all(list.map(async w => {
    const a = byPath.get(".github/workflows/" + w.file), name = a?.name || w.name;
    if (a && a.state !== "active") { off.push({ name, state: a.state }); return; }   // GitHub lists deleted files too: only files on disk count
    if (!w.scheduled) return;
    try {
      const r = await Promise.race([getJSON(`${api}/${encodeURIComponent(w.file)}/runs?event=schedule&per_page=6`, dl, tok), late]);
      if (!r) { unchecked++; return; }
      const t = wfLate((r.workflow_runs || []).map(x => x.created_at), now);
      if (t) lateL.push({ name, t });
    } catch { unchecked++; }
  }));
  return { off: off.sort((x, y) => x.name.localeCompare(y.name)), late: lateL.sort((x, y) => x.t - y.t), unchecked };
}
// every source in parallel; a failed or late source is null (files: per file). Never throws.
export async function collect(env = process.env, now = Date.now(), wfs = null) {
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), T.all), dl = ac.signal;
  const late = new Promise(r => dl.addEventListener("abort", () => r(null), { once: true }));
  const one = p => Promise.race([Promise.resolve().then(p).then(v => v ?? null, () => null), late]);
  const tok = env.GITHUB_TOKEN || "", api = `https://api.github.com/repos/${repo(env)}`, up = String(env.ALERT_UPTIME_URL || "").replace(/\/+$/, "");
  try {
    const [state, pulls, wf, files, health] = await Promise.all([
      one(() => readState(dl)),
      one(() => getJSON(api + "/pulls?state=open&per_page=50", dl, tok)),
      Promise.resolve().then(() => workflows(env, now, dl, wfs || wfFiles(), late)).catch(() => null),   // bounded by dl inside, keeps partial results
      Promise.all(FILES.map(F => one(() => getJSON(F.url + "?w=" + now, dl)).then(j => ({ F, j })))),
      up ? one(() => getJSON(up + "/health", dl)) : undefined,
    ]);
    return { state, pulls: Array.isArray(pulls) ? pulls : null, wf, files, health };
  } finally { clearTimeout(timer); ac.abort(); }
}

// ---- layout (pure) ----
const heOf = k => {   // ministry ids are dataset keys: render their titles
  const s = k.split(":");
  return s[0] === "ministry" && s[1] ? LABELS.ministry.he.replace("{ids}", s[1].split("+").map(x => SETS.find(z => z.key === x)?.title || x).join(", ")) : label(k).he;
};
// a waiting item that later events already settled (25.10: "1.36 and 1.37 went to Alpha, promoting is yours" stayed listed after both reached Production):
// an Alpha upload is settled by any later step towards Production (sent, live, 100%) or by a newer Alpha upload
const SETTLED_BY = { "ship:done:": ["prod:sent:", "prod:live:", "prod:full:", "ship:done:"] };
export function settled(k, it, items) {
  const pre = Object.keys(SETTLED_BY).find(p => k.startsWith(p)), t = Date.parse(it?.last);
  return !!pre && Object.entries(items).some(([k2, x]) => k2 !== k && SETTLED_BY[pre].some(p => k2.startsWith(p)) && Date.parse(x?.last) > t);
}
// state items of one section in [from, now], grouped by Hebrew label: count (log occurrences, else n), newest date, up to 2 links
function groups(s, sect, from) {
  const g = new Map();
  for (const [k, it] of Object.entries(s.items || {})) {
    const last = Date.parse(it?.last);
    if (label(k).sect !== sect || !(last >= from) || (sect === "wait" && it.open === false)) continue;   // a resolved decision is done
    if (sect === "wait" && settled(k, it, s.items)) continue;
    const he = heOf(k), x = g.get(he) || { he, keys: new Set(), last: 0, n: 0, its: [] };
    x.keys.add(k); x.last = Math.max(x.last, last); x.n += it.n || 1; x.its.push(it);
    g.set(he, x);
  }
  const log = Array.isArray(s.log) ? s.log : [];
  return [...g.values()].map(x => {
    const c = log.filter(e => x.keys.has(e.k) && e.a !== "ring" && Date.parse(e.t) >= from).length;
    const u = [...new Set(x.its.sort((a, b) => Date.parse(b.last) - Date.parse(a.last)).flatMap(it => (Array.isArray(it.u) ? it.u : [])))].slice(0, 2);
    return { he: x.he, keys: x.keys, n: c || x.n, last: x.last, u };
  });
}
const withLinks = (t, u) => u.reduce((s, l) => (s.length + 3 + l.length <= CAP.line ? s + " · " + l : s), t);
const itemLine = x => withLinks(`• ${x.he}${x.n > 1 ? ` ×${x.n} · אחרון ${dm(x.last)}` : ` · ${dm(x.last)}`}`, x.u);
// 🔔: actual vs would-be messages from the log (td = what the site did, a = the router's action or, in shadow, its would-action)
const KIND = { loud: "loud", remind: "loud", ring: "loud", night: "night", "remind-night": "night", deduped: "none", queued: "none", logged: "none" };
const kind = (a, td) => KIND[a] || (td === "loud" || td === "silent" ? td : "none");   // legacy/failed: today's send ran
function bell(s, from, shadow) {
  const log = (Array.isArray(s.log) ? s.log : []).filter(e => Date.parse(e.t) >= from);
  const act = log.map(e => (e.sh ? kind("legacy", e.td) : kind(e.a, e.td))), would = log.map(e => kind(e.a, e.td));
  const c = (a, k) => a.filter(x => (k ? x === k : x !== "none")).length;
  if (shadow) return `🔔 השבוע בפועל: ${plural(c(act), "הודעה אחת", "הודעות")} (${c(act, "loud")} מצלצלות). ` +
    `עם הנתב: ${plural(c(would), "הודעה אחת", "הודעות")} (${c(would, "loud")} מצלצלות, ${c(would, "night")} בלילה).`;
  const q = c(act, "silent");
  return `🔔 התראות השבוע: ${plural(c(act, "loud"), "1 צלצלה", "צלצלו")} · ${plural(c(act, "night"), "1 נשלחה בשקט בלילה", "נשלחו בשקט בלילה")}` +
    (q ? ` · ${plural(q, "1 נשלחה בשקט", "נשלחו בשקט")}` : "") + ` · ${plural(c(act, "none"), "1 נרשמה בלי הודעה", "נרשמו בלי הודעה")}`;
}
// the open-PR line; a magazine/<slug> PR is left out only while the block lists its mag:fail:<slug> item
function prLine(pulls, env, mag) {
  const prs = pulls.filter(p => { const r = String(p?.head?.ref || ""); return !(r.startsWith("magazine/") && mag.has(r.slice(9))); });
  const dep = prs.filter(p => p?.user?.login === "dependabot[bot]"), other = prs.length - dep.length;
  if (!prs.length) return null;
  const old = Math.min(...dep.map(p => Date.parse(p.created_at)).filter(Number.isFinite));
  const parts = [...(dep.length ? [`${dep.length} של Dependabot${Number.isFinite(old) ? ` (הוותיקה מ-${dm(old)})` : ""}`] : []),
    ...(other ? [dep.length ? `${other} ${other === 1 ? "אחרת" : "אחרות"}` : String(other)] : [])];
  return `• בקשות מיזוג פתוחות: ${parts.join(", ")} · https://github.com/${repo(env)}/pulls`;
}
// dead-man findings (out) and the sources that could not be read (bad)
function deadman(src, now) {
  const out = [], bad = [], s = src.state, wf = src.wf, hb = (s && s.hb) || {};
  if (!wf) bad.push("בדיקת התהליכים: לא מחובר");
  else {
    for (const w of wf.late) out.push(`• "${w.name}" לא רץ כמתוכנן (ריצה אחרונה ${ilTime(new Date(w.t))})`);
    for (const w of wf.off) out.push(`• "${w.name}" מושבת (${OFF_HE[w.state] || w.state})`);
    if (wf.unchecked) bad.push(`בדיקת התהליכים: ${plural(wf.unchecked, "תהליך אחד לא נבדק", "תהליכים לא נבדקו")}`);
  }
  const fl = src.files || [], unread = fl.filter(x => !x.j).map(x => x.F.name);
  if (unread.length) bad.push(unread.length === fl.length ? "קובצי הנתונים של האפליקציה: לא נקראו" : `קובצי נתונים לא נקראו: ${unread.join(", ")}`);
  for (const { F, j } of fl) { const l = j && fileStale(F, j, now); if (l) out.push("• " + l); }
  if (s) {   // the router itself
    const da = Date.parse(hb.dailyAt), ok = Date.parse(hb.tgOkAt), bad = Date.parse(hb.tgFailAt);
    if (!Number.isFinite(da)) out.push("• מערך ההתראות היומי עוד לא רץ");
    else if (now - da > 30 * H) out.push(`• מערך ההתראות היומי לא רץ (אחרון: ${ilTime(new Date(da))})`);
    if (Number.isFinite(bad) && !(ok >= bad)) out.push(`• בדיקת הטלגרם היומית נכשלה (${dm(bad)})`);
  }
  if (src.health === null) bad.push("בדיקת הזמינות לא עונה");
  else if (src.health) {
    const h = src.health, tick = Date.parse(h.tick), arm = h.armed || {};
    if (!(now - tick <= 30 * 6e4)) out.push(`• בדיקת הזמינות לא רצה מאז ${Number.isFinite(tick) ? ilTime(new Date(tick)) : "?"}`);
    const un = [["home", "דף הבית"], ["api", "/api"]].filter(([k]) => arm[k] !== true).map(([, he]) => he);
    if (un.length) out.push(`• בדיקת הזמינות לא חמושה: ${un.join(", ")}`);
    if (h.email === false) out.push("• לבדיקת הזמינות אין גיבוי מייל");
    if (h.tg === false) out.push("• בדיקת הזמינות לא מצליחה לשלוח לטלגרם");
  }
  return { out, bad };
}
// a section: "(N)" counts findings only; a source that failed is its own line under the section's emoji (spec 9.3)
const sect = (e, h, l, bad, cap, none) => [...(l.length ? [`${e} ${h} (${l.length})`, ...l.slice(0, cap), ...(l.length > cap ? [`ועוד ${l.length - cap}`] : [])]
  : none && !bad.length ? [`${e} ${h}: ${none}`] : []), ...bad.map(b => `${e} ${b}`)].join("\n") || null;
// the whole block; complete = false when the state was not read while summary/silent are routed (run.py then does not mark the summary)
export function build(src, now, env = process.env) {
  const s = src.state, hb = (s && s.hb) || {}, on = LEVELS.filter(l => routed(l, env)), shadow = on.length < LEVELS.length;
  const sa = Date.parse(hb.summaryAt);   // failures and FYI since the last summary (7 to 14 days), so a late or missed Sunday skips nothing
  const from = Number.isFinite(sa) ? Math.max(now - 14 * D, Math.min(now - 7 * D, sa)) : now - 7 * D;
  const head = [`🧾 לוחית · סיכום שבועי ${dm(from)}–${dm(now - D)}`];
  if (shadow) head.push(on.length ? `(הנתב פעיל רק עבור: ${on.join(", ")}. השאר נשלח כרגיל)` : "(הנתב במצב ניסיון: ההודעות עדיין נשלחות כרגיל, והשורה האחרונה מראה מה היה משתנה איתו)");
  const wg = s ? groups(s, "wait", now - 14 * D).sort((a, b) => b.last - a.last) : [], wait = wg.map(itemLine);
  const mag = new Set(wg.flatMap(g => [...g.keys]).filter(k => k.startsWith("mag:fail:")).map(k => k.slice(9)));
  const pr = src.pulls && prLine(src.pulls, env, mag);
  if (pr) wait.push(pr);
  const wbad = [...(s ? [] : ["רשימת ההתראות: לא מחובר"]), ...(src.pulls ? [] : ["בקשות מיזוג פתוחות: לא מחובר"])];
  const fail = s ? groups(s, "fail", from).sort((a, b) => b.n - a.n || b.last - a.last).map(itemLine) : [];
  const fyi = s ? groups(s, "fyi", from).sort((a, b) => b.last - a.last).map(itemLine) : [];
  const dead = deadman(src, now);
  const tail = s ? bell(s, from, shadow) : "🔔 התראות השבוע: לא מחובר";
  let text = "";
  for (let cap = CAP.lines; cap >= 1; cap--) {   // 6 lines a section, fewer when the block would pass 1,800 characters
    text = [head.join("\n"), sect("⏳", "מחכה לך", wait, wbad, cap, "אין כלום השבוע ✓"), sect("🪦", "לא רץ או התיישן", dead.out, dead.bad, cap),
      sect("🔧", "תקלות השבוע", fail, [], cap), sect("ℹ️", "לידיעה", fyi, [], cap), tail].filter(Boolean).join("\n\n");
    if (text.length <= CAP.block) break;
  }
  if (text.length > CAP.block) text = text.slice(0, CAP.block - 2).replace(/\n[^\n]*$/, "") + "\n…";
  return { text, complete: !!s || !(routed("summary", env) || routed("silent", env)) };
}

export async function main(file, env = process.env, now = Date.now()) {
  const { text, complete } = build(await collect(env, now), now, env);
  fs.writeFileSync(file, text + "\n");
  return complete ? 0 : 3;
}

// ---- selftest (offline: mocked fetch, fixtures, fixed clock) ----
async function selftest() {
  const os = await import("node:os");
  let n = 0, bad = 0;
  const ok = (c, m) => { n++; if (!c) { bad++; process.stderr.write("FAIL " + m + "\n"); } };
  const NOW = Date.parse("2026-10-18T05:25:00Z"), iso = t => new Date(t).toISOString(), ago = h => iso(NOW - h * H);   // Sunday 08:25 IDT
  const ENV = { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "ddsabag/vehicle-app", ALERT_ROUTE: "" };
  const it = (lastH, o = {}) => ({ lv: "day", src: "x", u: [], first: ago(lastH + 1), last: ago(lastH), n: 1, sent: null, pend: null, open: true, ...o });
  const lg = (k, h, a, td = "loud", sh = 1) => ({ t: ago(h), k, lv: "day", a, td, sh });
  const CMP = "https://github.com/ddsabag/vehicle-app/compare/main...seo-auto", RULES = "https://github.com/ddsabag/vehicle-app/blob/catalog-data/rules-report.md";
  const STATE = { v: 1, hb: { daily: "2026-10-17", dailyAt: ago(21), tgOkAt: ago(21), summaryAt: iso(Date.parse("2026-10-11T05:30:00Z")) },
    items: {
      "seo-auto:blocked:a1b2c3d": it(87, { lv: "summary", u: [CMP] }),
      "mag:fail:2026-10": it(12 * 24, { u: [] }),
      "catalog:0a1b2c3d4e5f": it(30, { lv: "summary", n: 1, u: [RULES] }), "catalog:1a1b2c3d4e5f": it(70, { lv: "summary", n: 3, u: [RULES] }),
      "expiry:domain": it(50, { open: false }),                      // resolved: not waiting any more
      "review:aaaaaaaaaaaa": it(15 * 24),                            // older than 14 days
      "wf:Reviews monitor": it(48, { n: 1 }), "ministry:recalls": it(72, { lv: "summary", n: 2 }), "wf:Fuel price": it(9 * 24),   // before the window
      "guard:warn:0badf00d": it(80, { lv: "summary" }), "mention:abcdefabcdef": it(5, { lv: "summary", n: 2, u: ["https://example.co.il/a", "https://news.example/b", "https://third.example/c"] }),
      "seo:daily": it(2, { lv: "silent", n: 7 }), "nope:x": it(3),
    },
    log: [lg("wf:Reviews monitor", 48, "loud"), lg("wf:Reviews monitor", 100, "loud"), lg("wf:Reviews monitor", 140, "deduped"), lg("wf:Reviews monitor", 200, "loud"),
      lg("ministry:recalls", 72, "queued"), lg("ministry:recalls", 96, "queued"), lg("seo:daily", 2, "logged", "silent"), lg("seo:daily", 26, "logged", "silent"),
      lg("mag:fail:2026-10", 12 * 24, "night"), lg("vitals:crash", 30, "night"), lg("nope:x", 3, "legacy", "none")] };
  const PULLS = [{ user: { login: "dependabot[bot]" }, head: { ref: "dependabot/x" }, created_at: "2026-10-13T09:00:00Z" },
    { user: { login: "dependabot[bot]" }, head: { ref: "dependabot/y" }, created_at: "2026-10-15T09:00:00Z" },
    { user: { login: "ddsabag" }, head: { ref: "feature" }, created_at: "2026-10-16T09:00:00Z" }, { user: { login: "github-actions[bot]" }, head: { ref: "magazine/2026-10" }, created_at: "2026-10-06T09:00:00Z" }];
  const fresh = { "models.json": { updated: "2026-10-05" }, "market.json": { updated: "2026-10-05" }, "modelstats.json": { updated: "2026-10-06" },
    "fuel.json": { checked: "2026-10-05" }, "status.json": { checked: ago(23.5) }, "meta.json": { u: "2026-10-17" } };
  const daily = k => Array.from({ length: 6 }, (_, i) => iso(NOW - (k + i) * D - 4 * 6e4));   // 05:21 UTC daily, newest k days ago
  const WFS = [{ file: "fuel.yml", name: "Fuel price", scheduled: true }, { file: "models.yml", name: "Model names", scheduled: true },
    { file: "android.yml", name: "Android build", scheduled: false }, { file: "zombie.yml", name: "Back-on-road detector", scheduled: true }];
  // mocked network: o[source] = "500" | "hang" | value
  const net = (o = {}) => async (u, init = {}) => {
    const res = (v, status = 200) => new Response(JSON.stringify(v), { status });
    const pick = (k, v) => (o[k] === "hang" ? new Promise((_, no) => init.signal?.addEventListener("abort", () => no(new Error("aborted")))) : o[k] === "500" ? res({}, 500) : res(o[k] ?? v));
    if (u.includes("/contents/state.json")) return o.state === "404" ? res({}, 404) : pick("state", null);
    if (u.includes("/pulls?")) return pick("pulls", PULLS);
    if (/\/actions\/workflows\?/.test(u)) return pick("list", { workflows: [{ path: ".github/workflows/fuel.yml", name: "Fuel price", state: "active" },
      { path: ".github/workflows/models.yml", name: "Model names", state: "active" }, { path: ".github/workflows/android.yml", name: "Android build", state: "disabled_manually" },
      { path: ".github/workflows/zombie.yml", name: "Back-on-road detector", state: "disabled_inactivity" }, { path: ".github/workflows/gone.yml", name: "Gone", state: "disabled_manually" }] });
    const m = /\/actions\/workflows\/([^/]+)\/runs/.exec(u);
    if (m) return pick("runs:" + m[1], { workflow_runs: (m[1] === "fuel.yml" ? daily(1) : [iso(NOW - 13 * D), iso(NOW - 44 * D), iso(NOW - 74 * D)]).map(c => ({ created_at: c })) });
    if (u.includes("/health")) return pick("health", { v: "uptime-1", tick: ago(0.1), armed: { home: true, api: true }, tg: true, email: true });
    const f = Object.keys(fresh).find(k => u.includes("/" + k + "?"));
    if (f) return pick(f, fresh[f]);
    return res({}, 404);
  };
  const stateRes = s => ({ sha: "s", content: Buffer.from(JSON.stringify(s)).toString("base64") });
  const keep = { fetch: globalThis.fetch, env: { ...process.env }, T: { ...T }, write: process.stdout.write };
  const stdout = [];
  const setEnv = e => { for (const k of ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "ALERT_ROUTE", "ALERT_UPTIME_URL"]) delete process.env[k]; Object.assign(process.env, e); };
  const run = async (o = {}, env = ENV) => {   // collect + build against the mock (readState goes through alert.mjs, which reads process.env)
    globalThis.fetch = net({ state: stateRes(STATE), ...o }); setEnv(env);
    const src = await collect(env, NOW, WFS);
    return { src, ...build(src, NOW, env) };
  };
  process.stdout.write = (s, ...a) => { stdout.push(String(s)); return true; };
  T.req = 150; T.all = 600;
  try {
    // dead-man rules
    ok(wfLate(daily(1), NOW) === null, "daily: ran yesterday");
    ok(wfLate(daily(2), NOW) === null, "daily: one dropped run is not flagged");
    ok(wfLate(daily(3), NOW) === Date.parse(daily(3)[0]), "daily: two dropped runs are flagged");
    const tri = [];   // reviews monitor 06:15, 11:15, 17:15 UTC (+20 min), uneven gaps
    for (let d = 1; d <= 3; d++) for (const h of [17, 11, 6]) tri.push(Date.parse("2026-10-18T00:35:00Z") - d * D + h * H);
    ok(wfLate(tri.map(iso), NOW) === null, "3 a day: on time");
    ok(wfLate(tri.slice(1).map(iso), NOW) === null, "3 a day: one dropped run is not flagged");
    ok(wfLate(tri.slice(3).map(iso), NOW) !== null, "3 a day: a whole day missing is flagged");
    const two = [];   // web deploy 03:17 and 09:17 UTC (+15 min): 6/18 h gaps; 2 x median would flag the dropped Sunday 03:17 run at 20 h
    for (let d = 0; d <= 3; d++) for (const h of [9.5, 3.5]) two.push(Date.parse("2026-10-18T00:00:00Z") - d * D + h * H);
    ok(wfLate(two.filter(t => t < NOW).map(iso), NOW) === null && wfLate(two.filter(t => t < NOW - 3 * H).map(iso), NOW) === null, "twice a day: one dropped run is not flagged");
    ok(wfLate(two.filter(t => t < NOW - 30 * H).map(iso), NOW + 2 * H) !== null, "twice a day: three dropped runs are flagged");
    const pair = ["2026-10-11T07:00:05Z", "2026-10-11T05:41:12Z", "2026-10-04T06:30:00Z", "2026-10-04T05:35:00Z", "2026-09-27T06:28:00Z", "2026-09-27T05:33:00Z"];
    ok(wfLate(pair, NOW) === null && wfLate(pair, Date.parse("2026-10-25T09:00Z")) === null, "DST-paired weekly: one week dropped is not flagged");
    ok(wfLate(pair, Date.parse("2026-11-01T09:00Z")) !== null, "DST-paired weekly: two weeks dropped are flagged");
    ok(wfLate(["2026-10-05T07:30Z", "2026-09-05T07:30Z", "2026-08-05T07:30Z"], Date.parse("2027-01-01T00:00Z")) === null, "monthly is skipped");
    ok(wfLate(daily(9).slice(0, 2), NOW) === null, "fewer than 3 runs: skipped");
    const F = n => FILES.find(x => x.name.startsWith(n));
    for (const [n, v, want] of [["fuel", { checked: "2026-09-13" }, false], ["fuel", { checked: "2026-09-12" }, true], ["models", { updated: "2026-09-08" }, false],
      ["models", { updated: "2026-09-07" }, true], ["market", {}, true], ["status", { checked: ago(53.9) }, false], ["status", { checked: ago(54.1) }, true],
      ["meta", { u: "2026-10-17" }, false], ["meta", { u: "2026-10-16" }, false], ["meta", { u: "2026-10-15" }, true]]) ok(!!fileStale(F(n), v, NOW) === want, `file ${n} ${JSON.stringify(v)}`);
    ok(fileStale(F("meta"), { u: "2026-10-15" }, NOW) === "meta.json (הקטלוג) לא עודכן מאז 15.10", "file line");
    ok(fileStale(F("meta"), { u: "2026-10-16" }, Date.parse("2026-10-18T23:30:00Z")) === null, "catalog: UTC dates, not Jerusalem dates");
    const real = wfFiles();
    ok(real.some(w => w.file === "weekly-analytics.yml" && w.scheduled) && real.some(w => w.file === "alert-check.yml" && !w.scheduled), "workflow files read from disk");

    // layout snapshot (shadow)
    let x = await run();
    const SNAP = [
      "🧾 לוחית · סיכום שבועי 11.10–17.10",
      "(הנתב במצב ניסיון: ההודעות עדיין נשלחות כרגיל, והשורה האחרונה מראה מה היה משתנה איתו)",
      "",
      "⏳ מחכה לך (4)",
      "• שמות דגמים חדשים בקטלוג לבדיקה ×4 · אחרון 17.10 · " + RULES,
      "• שינוי SEO מחכה לאישור שלך (a1b2c3d) · 14.10 · " + CMP,
      "• כתבת מגזין לא פורסמה, הבדיקות נכשלו: 2026-10 · 06.10",
      "• בקשות מיזוג פתוחות: 2 של Dependabot (הוותיקה מ-13.10), 1 אחרת · https://github.com/ddsabag/vehicle-app/pulls",
      "",
      "🪦 לא רץ או התיישן (2)",
      '• "Android build" מושבת (כובה ידנית)',
      '• "Back-on-road detector" מושבת (כבה אחרי 60 יום בלי פעילות במאגר)',
      "",
      "🔧 תקלות השבוע (2)",
      '• הבוט "שומר הביקורות" נכשל ×3 · אחרון 16.10',
      "• מאגר של משרד התחבורה לא תקין: ריקולים לפי רכב ×2 · אחרון 15.10",
      "",
      "ℹ️ לידיעה (3)",
      "• התראה: nope:x · 18.10",
      "• אזכור חדש של לוחית ברשת ×2 · אחרון 18.10 · https://example.co.il/a · https://news.example/b",
      "• שינוי לא שובר במבנה מאגר של משרד התחבורה · 15.10",
      "",
      "🔔 השבוע בפועל: 8 הודעות (6 מצלצלות). עם הנתב: 3 הודעות (2 מצלצלות, 1 בלילה).",
    ].join("\n");
    ok(x.text === SNAP, "layout snapshot:\n" + x.text);
    ok(x.complete === true && !x.text.includes("—"), "complete, no em-dash");
    x = await run({}, { ...ENV, ALERT_ROUTE: "critical,silent" });
    ok(x.text.split("\n")[1] === "(הנתב פעיל רק עבור: silent, critical. השאר נשלח כרגיל)", "partial rollout preview line");
    x = await run({ state: stateRes({ ...STATE, log: STATE.log.map(e => ({ ...e, sh: 0 })) }) }, { ...ENV, ALERT_ROUTE: "all" });
    ok(!x.text.includes("במצב ניסיון") && !x.text.includes("השאר נשלח כרגיל") && x.text.endsWith("🔔 התראות השבוע: 2 צלצלו · 1 נשלחה בשקט בלילה · 6 נרשמו בלי הודעה"), "routed: no preview, counts line\n" + x.text.split("\n").at(-1));
    x = await run({ state: stateRes({ ...STATE, log: [lg("a:b", 1, "loud", "loud", 0), lg("a:b", 2, "legacy", "silent", 0), lg("a:b", 3, "queued", "loud", 0)] }) }, { ...ENV, ALERT_ROUTE: "all" });
    ok(x.text.endsWith("🔔 התראות השבוע: 1 צלצלה · 0 נשלחו בשקט בלילה · 1 נשלחה בשקט · 1 נרשמה בלי הודעה"), "routed counts, singular\n" + x.text.split("\n").at(-1));
    // empty case: nothing waiting, nothing stale
    x = await run({ state: stateRes({ v: 1, items: {}, hb: STATE.hb, log: [] }), pulls: [], list: { workflows: [] } });
    ok(x.text === "🧾 לוחית · סיכום שבועי 11.10–17.10\n(הנתב במצב ניסיון: ההודעות עדיין נשלחות כרגיל, והשורה האחרונה מראה מה היה משתנה איתו)\n\n⏳ מחכה לך: אין כלום השבוע ✓\n\n🔔 השבוע בפועל: 0 הודעות (0 מצלצלות). עם הנתב: 0 הודעות (0 מצלצלות, 0 בלילה).", "empty case\n" + x.text);
    // dead-man through the mock: late workflow, stale files, the router, uptime
    x = await run({ "runs:fuel.yml": { workflow_runs: daily(3).map(c => ({ created_at: c })) }, "fuel.json": { checked: "2026-09-01" }, "meta.json": { u: "2026-10-14" },
      state: stateRes({ ...STATE, hb: { dailyAt: ago(31), tgOkAt: ago(50), tgFailAt: ago(31) } }),
      health: { tick: ago(2), armed: { home: true, api: false }, tg: false, email: false } }, { ...ENV, ALERT_UPTIME_URL: "https://up.example/" });
    for (const l of ['• "Fuel price" לא רץ כמתוכנן (ריצה אחרונה 15.10 08:21)', "• fuel.json לא עודכן מאז 01.09", "• meta.json (הקטלוג) לא עודכן מאז 14.10",
      "• מערך ההתראות היומי לא רץ (אחרון: 17.10 01:25)", "• בדיקת הטלגרם היומית נכשלה (17.10)", "• בדיקת הזמינות לא רצה מאז 18.10 06:25",
      "• בדיקת הזמינות לא חמושה: /api", "• לבדיקת הזמינות אין גיבוי מייל", "• בדיקת הזמינות לא מצליחה לשלוח לטלגרם"]) ok(deadman(x.src, NOW).out.includes(l), "dead-man line " + l);
    ok(/🪦 לא רץ או התיישן \(11\)\n(.*\n){6}ועוד 5\n/.test(x.text), "6 lines per section, then ועוד");
    x = await run({ state: "404" });
    ok(x.text.includes("• מערך ההתראות היומי עוד לא רץ") && x.text.includes("⏳ מחכה לך (1)"), "no state branch yet");
    // a magazine PR is left out only while its mag:fail item is listed (14 days, open); otherwise it is an open PR like any other
    const magPR = [PULLS[3]], magSt = (o = {}) => stateRes({ v: 1, hb: STATE.hb, log: [], items: { "mag:fail:2026-10": it(12 * 24, o) } }), PRS = "https://github.com/ddsabag/vehicle-app/pulls";
    x = await run({ pulls: magPR, state: magSt() });
    ok(x.text.includes("⏳ מחכה לך (1)\n• כתבת מגזין לא פורסמה") && !x.text.includes("בקשות מיזוג"), "magazine PR listed through mag:fail\n" + x.text);
    for (const [st, m] of [[magSt({ last: ago(15 * 24) }), "mag:fail older than 14 days"], [magSt({ open: false }), "mag:fail resolved"], [stateRes({ ...STATE, items: {} }), "no mag:fail item"],
      [stateRes({ v: 1, hb: STATE.hb, log: [], items: { "mag:fail:2026-09": it(12 * 24) } }), "mag:fail of another slug"]])
      ok((x = await run({ pulls: magPR, state: st })).text.includes("• בקשות מיזוג פתוחות: 1 · " + PRS), "magazine PR still listed: " + m + "\n" + x.text);
    ok(build({ state: null, pulls: magPR, wf: { off: [], late: [], unchecked: 0 }, files: [] }, NOW, ENV).text.includes("• בקשות מיזוג פתוחות: 1 · " + PRS), "magazine PR listed when the state is not read");

    // an Alpha upload that later reached Production, or was followed by a newer upload, is no longer waiting (25.10)
    const shipSt = (extra) => stateRes({ v: 1, hb: STATE.hb, log: [], items: { "ship:done:1.37": it(72), ...extra } });
    ok((x = await run({ pulls: [], state: shipSt({}) })).text.includes("גרסה 1.37 עלתה ל-Alpha"), "an Alpha upload alone is waiting\n" + x.text);
    ok(!(x = await run({ pulls: [], state: shipSt({ "prod:sent:127": it(70) }) })).text.includes("גרסה 1.37 עלתה ל-Alpha"), "settled by a later Production step\n" + x.text);
    ok(!(x = await run({ pulls: [], state: shipSt({ "ship:done:1.38": it(10) }) })).text.includes("גרסה 1.37 עלתה ל-Alpha"), "settled by a newer upload\n" + x.text);
    ok((x = await run({ pulls: [], state: shipSt({ "prod:sent:126": it(80) }) })).text.includes("גרסה 1.37 עלתה ל-Alpha"), "an older Production step does not settle it\n" + x.text);

    // each source failing gives its own line and leaves the others intact
    // "(N)" counts the "• " lines under the header; a failed source is a line of its own and is not counted
    const counted = t => t.split("\n\n").every(p => { const m = /^\S+ [^\n(]+ \((\d+)\)\n/.exec(p); return !m || /\nועוד \d+/.test(p) || p.split("\n").filter(l => l.startsWith("• ")).length === +m[1]; });
    for (const [o, line, env] of [[{ state: "500" }, "⏳ רשימת ההתראות: לא מחובר"], [{ pulls: "500" }, "⏳ בקשות מיזוג פתוחות: לא מחובר"], [{ list: "500" }, "🪦 בדיקת התהליכים: לא מחובר"],
      [{ "runs:fuel.yml": "500" }, "🪦 בדיקת התהליכים: תהליך אחד לא נבדק"], [{ "fuel.json": "500" }, "🪦 קובצי נתונים לא נקראו: fuel.json"],
      [{ "status.json": "hang", "meta.json": "500" }, "🪦 קובצי נתונים לא נקראו: status.json (מצב המאגרים), meta.json (הקטלוג)"],
      [{ health: "500" }, "🪦 בדיקת הזמינות לא עונה", { ...ENV, ALERT_UPTIME_URL: "https://up.example" }]]) {
      x = await run(o, env);
      const k = Object.keys(o)[0], others = SNAP.split("\n").filter(l => l.startsWith("• ") && !(k === "state" ? !/Dependabot|מושבת/.test(l) : k === "pulls" ? /Dependabot/.test(l) : k === "list" && /מושבת/.test(l)))
        .map(l => (k === "state" ? l.replace("1 אחרת", "2 אחרות") : l));   // without the state, the magazine PR is no longer covered by mag:fail
      ok(x.text.includes(line) && others.every(l => x.text.includes(l)) && counted(x.text), `source failure ${Object.keys(o)[0]}: ${line}\n${x.text}`);
    }
    x = await run({ pulls: "500" });
    ok(x.text.includes("⏳ מחכה לך (3)\n") && x.text.includes("\n🪦 לא רץ או התיישן (2)\n"), "a failed source does not change the counts\n" + x.text);
    x = await run({ "fuel.json": "500", list: { workflows: [] } });
    ok(!x.text.includes("🪦 לא רץ או התיישן") && x.text.includes("\n\n🪦 קובצי נתונים לא נקראו: fuel.json\n\n"), "only a failed source: no counted header\n" + x.text);
    x = { text: build({ state: null, pulls: [], wf: { off: [], late: [], unchecked: 0 }, files: [] }, NOW, ENV).text };
    ok(x.text.includes("\n\n⏳ רשימת ההתראות: לא מחובר\n\n") && !/\(\d+\)|אין כלום/.test(x.text), "state not read, no PRs: one line, no count, no all-clear\n" + x.text);
    x = await run({ state: "500" });
    ok(x.text.endsWith("🔔 התראות השבוע: לא מחובר") && x.complete === true, "state failure in shadow: still complete (nothing is held back)");
    x = await run({ state: "500" }, { ...ENV, ALERT_ROUTE: "critical,summary" });
    ok(x.complete === false, "state failure with summary routed: not complete (the summary is not marked)");
    x = await run({}, { ...ENV, GITHUB_TOKEN: "" });
    ok(x.text.includes("⏳ רשימת ההתראות: לא מחובר"), "no token: state not connected");
    // every source hangs: bounded by the deadline, each one says so
    const t1 = Date.now();
    x = await run(Object.fromEntries(["state", "pulls", "list", "health", ...Object.keys(fresh)].map(k => [k, "hang"])), { ...ENV, ALERT_UPTIME_URL: "https://up.example" });
    const el = Date.now() - t1;
    ok(el < T.all + 200 && ["⏳ רשימת ההתראות: לא מחובר", "⏳ בקשות מיזוג פתוחות: לא מחובר", "🪦 בדיקת התהליכים: לא מחובר", "🪦 קובצי הנתונים של האפליקציה: לא נקראו",
      "🪦 בדיקת הזמינות לא עונה", "🔔 התראות השבוע: לא מחובר"].every(l => x.text.includes(l)) && !/\(\d+\)|אין כלום/.test(x.text),
      `all sources hang: ${el} ms\n${x.text}`);
    T.req = 5000;   // a request that ignores nothing but outlives the whole deadline: the deadline still ends the collect
    const t2 = Date.now();
    x = await run({ "runs:fuel.yml": "hang", pulls: "hang" });
    ok(Date.now() - t2 < T.all + 300 && x.text.includes("⏳ בקשות מיזוג פתוחות: לא מחובר") && x.text.includes("🪦 בדיקת התהליכים: תהליך אחד לא נבדק"), "deadline ends the collect " + (Date.now() - t2));
    T.req = 150;

    // caps: 6 lines a section, 1,800 characters in all
    const many = { v: 1, hb: STATE.hb, log: [], items: {} };
    for (let i = 0; i < 40; i++) many.items[`wf:Workflow number ${String.fromCharCode(65 + (i % 26))}${i > 25 ? "x" : ""} ${"long name ".repeat(4).trim()}`] = it(10 + i, { u: ["https://github.com/ddsabag/vehicle-app/actions/runs/" + "a".repeat(200), "https://b.example/" + "b".repeat(250)] });
    for (let i = 0; i < 12; i++) many.items["catalog:" + "abcdef0123" + String.fromCharCode(97 + i) + "f"] = it(20 + i, { u: ["https://c.example/" + "c".repeat(120) + i] });
    x = await run({ state: stateRes(many) });
    ok(x.text.length <= CAP.block && x.text.startsWith("🧾") && x.text.includes("⏳ מחכה לך") && /ועוד \d+/.test(x.text), `block capped at 1,800 (${x.text.length})`);
    ok(x.text.split("\n").every(l => l.length <= CAP.line + 40), "lines capped");
    x = { text: build({ state: many, pulls: [], wf: { off: [], late: [], unchecked: 0 }, files: [] }, NOW, { ALERT_ROUTE: "" }).text };
    ok(x.text.length <= CAP.block, "pure build capped");

    // main writes the file, never stdout
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "waiting-")), "w.txt");
    globalThis.fetch = net({ state: stateRes(STATE) }); setEnv(ENV);
    ok(await main(file, ENV, NOW) === 0 && fs.readFileSync(file, "utf8").startsWith("🧾 לוחית"), "main writes the block to the file");
    globalThis.fetch = net({ state: "500" }); setEnv({ ...ENV, ALERT_ROUTE: "all" });
    ok(await main(file, { ...ENV, ALERT_ROUTE: "all" }, NOW) === 3 && fs.readFileSync(file, "utf8").includes("לא מחובר"), "main exit 3 when routed and the state is not read");
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    ok(stdout.length === 0, "nothing written to stdout: " + JSON.stringify(stdout.join("").slice(0, 200)));
  } finally { process.stdout.write = keep.write; globalThis.fetch = keep.fetch; setEnv({}); Object.assign(process.env, keep.env); Object.assign(T, keep.T); }
  process.stdout.write(bad ? `waiting selftest: ${bad} of ${n} checks FAILED\n` : `waiting selftest ok (${n} checks)\n`);
  return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("waiting.mjs")) {
  const a = process.argv[2];
  if (a === "--selftest") process.exit(await selftest());
  if (!a) { process.stderr.write("usage: waiting.mjs <out file> | --selftest\n"); process.exit(2); }
  process.exit(await main(a));
}
