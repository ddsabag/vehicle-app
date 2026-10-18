// Alert router: one engine for every Telegram alert (levels critical/day/summary/silent, quiet hours, 24 h dedupe, Sunday queue).
// Each call site keeps its own unchanged send as `legacy`; a missing, broken, slow or unrouted router means exactly that legacy runs once.
// The repo variable ALERT_ROUTE (comma list of levels, or "all") switches levels on; unset = shadow (legacy sends, the router only records).
// State lives on the public branch "alert-state" (state.json + heartbeat.json) and holds no message text: keys, levels, times, counts, links.
// Node 20, no imports except node: builtins (failure-alert and alert-daily check out only this file).
//   Node:   let router = null; try { router = await import("./alert.mjs"); } catch {}   then  router.alert(level, key, text, link, { today, legacy })
//   shell:  out=$(timeout 45 node .github/scripts/alert.mjs send <level> <key> --today loud --text "$t" 2>/dev/null || true)
//           case "$out" in *ALERT_DONE*) echo "${out##*$'\n'}" ;; *) <the original send line> ;; esac
//   node alert.mjs send <level> <key> --today loud|silent|none (--text "<t>" | --file <path>) [--plain] [--link URL]... [--fresh]
//   node alert.mjs wf "<workflow name>" --today loud|silent --text "<t>" --link URL [--repeat]
//   node alert.mjs --stdin          JSON {level,key,text,link,today,plain,fresh} (analytics/alert.py)
//   node alert.mjs daily            alert-daily.yml: claim, Telegram self-test, morning ring, uptime and Monday checks, heartbeat, prune
//   node alert.mjs mark-summary     weekly "mark" job: hb.summaryAt = now
//   node alert.mjs selftest         offline (mocked fetch, injectable clock)
// CLI output contract: the LAST stdout line is "ALERT_DONE <action> <0|1>" (handled, the caller must not send) or "ALERT_LEGACY" (the caller
// sends exactly as today). Exit 0, except usage errors (exit 2, no marker, so the shell fallback runs anyway).
import fs from "node:fs";
import { createHash } from "node:crypto";

// ---- constants (the only place these rules live) ----
export const LEVELS = ["silent", "summary", "day", "critical"];            // rank = index
export const QUIET  = { tz: "Asia/Jerusalem", dayStart: 8, dayEnd: 22 };   // daytime = local hour in [8, 22)
export const REMIND_MS = 24 * 36e5 - 90 * 6e4;   // "one reminder per 24 h", with 90 min tolerance for GitHub cron drift (observed 25-39 min)
export const IDLE_MS   = 26 * 36e5;              // an open key not seen for 26 h is closed; the next occurrence is a new episode
export const GATE_NIGHT_MS   = 30 * 36e5;        // hb.dailyAt must be this fresh to delay a night "day" item
export const GATE_SUMMARY_MS = 8 * 864e5;        // hb.summaryAt must be this fresh to keep summary/silent out of Telegram
export const DEADLINE_MS = 40000;
export const EMAIL_TO = "ddsabag@gmail.com";     // NOTIFY_TO in worker/api/wrangler.toml
export const EMAIL_FROM = { name: "לוחית התראות", email: "updates@luchit.app" };   // already a verified Brevo sender (worker/api/worker.js:49)
export const STATE = { branch: "alert-state", file: "state.json", heartbeat: "heartbeat.json" };

// failure-alert.yml level per workflow name (the `wf` command); any other name: "day" (a safe default, never silent)
// "Ministry watch" (was "Data health", silent, + "Data status", day) is day: its status job refreshes the app's status.json, and the name cannot tell the jobs apart.
// Phase 3 merges: Infra watch is part of "Site smoke test", Magazine data articles and Newsletter of "Magazine", IndexNow a job of "Web deploy (build)".
export const WF_LEVELS = {
  "Web deploy (build)": "critical",
  "Workers deploy": "critical",   // a crash mid-deploy can leave the site on an unchecked Worker version
  "Android build": "day", "Data guard": "day", "Fuel price": "day", "Market data": "day",
  "Ministry watch": "day", "Model names": "day", "Model statistics": "day", "Magazine": "day", "Site smoke test": "day",
  "Site smoke test (after deploy)": "day", "Weekly analytics report": "day", "Alert daily": "day",
  "SEO check": "summary", "SEO auto-publish": "summary", "Web watch": "summary",
  "Model catalogue": "summary",
  "SEO daily digest": "summary", "SEO data snapshot": "summary", "Experimenter": "summary",
  "Reviews monitor": "silent", "Ownership data mirror": "silent",
  "Back-on-road detector": "silent",
};

// fixed Hebrew text for the morning ring and the Sunday block. Lookup: first two key segments, then the first one.
// {id} = the rest of the key after the family; {ids} = that rest split on "+" and mapped through ids. sect: wait|fail|fyi|none
export const LABELS = {
  "wf":                  { he: 'התהליך "{id}" נכשל', sect: "fail" },
  "smoke":               { he: "בדיקת האתר החי מצאה בעיה: {ids}", sect: "fail",
                           ids: { home: "דף הבית", lookup: "בדיקת רכב", magazine: "דף המגזין", applinks: "קישורי האפליקציה",
                                  privacy: "מדיניות הפרטיות", model: "דף דגם", sitemap: "מפת האתר",
                                  cert: "אישור האבטחה (SSL)", domain: "הדומיין luchit.app", certcheck: "בדיקת אישור האבטחה נכשלה" } },   // mixed smoke keys carry expiry ids
  "expiry":              { he: "צריך לחדש בקרוב: {ids}", sect: "wait", ids: { cert: "אישור האבטחה (SSL)", domain: "הדומיין luchit.app", certcheck: "בדיקת אישור האבטחה נכשלה" } },
  "infra":               { he: "שירותי האתר או המכסה: {ids}", sect: "fail",
                           ids: { site: "האתר", api: "שירות ההרשמה (/api)", sitemap: "מפת האתר", "quota-cf": "מכסת Cloudflare מעל 80%", "quota-brevo": "מכסת Brevo מעל 80%" } },
  "infra-branches":      { he: "ענפים ישנים שאפשר למחוק", sect: "fyi" },
  "guard:core":          { he: "משרד התחבורה שינה עמודה שבדיקת הרכב קוראת", sect: "wait" },
  "guard:break":         { he: "משרד התחבורה שינה מבנה של מאגר, בניית אנדרואיד עצורה", sect: "wait" },
  "guard:warn":          { he: "שינוי לא שובר במבנה מאגר של משרד התחבורה", sect: "fyi" },
  "ministry":            { he: "מאגר של משרד התחבורה לא תקין: {ids}", sect: "fail" },   // ids: SETS[].title from datasets.mjs (waiting.mjs)
  "checker:data-health": { he: "בדיקת בריאות הנתונים קרסה", sect: "fail" },
  "review":              { he: "ביקורת 1–2 כוכבים בגוגל פליי, לענות", sect: "wait" },
  "review3":             { he: "ביקורת 3 כוכבים בגוגל פליי, כדאי לענות", sect: "wait" },
  "vitals":              { he: "שיעור {ids} בגוגל פליי מעל סף גוגל", sect: "fail", ids: { crash: "הקריסות", anr: "ה-ANR" } },
  "reviews:error":       { he: "הבדיקה של גוגל פליי לא הצליחה לרוץ", sect: "fail" },
  "seo:error":           { he: "הדוח היומי מ-Search Console לא רץ", sect: "fail" },
  "seo":                 { he: "דוח SEO יומי", sect: "none" },
  "mention":             { he: "אזכור חדש של לוחית ברשת", sect: "fyi" },
  "seo-auto:blocked":    { he: "שינוי SEO מחכה לאישור שלך ({id})", sect: "wait" },
  "seo-auto:notice":     { he: "שינוי SEO יעלה לאתר בעוד 24 שעות ({id})", sect: "none" },
  "seo-auto":            { he: "שינוי SEO ({id})", sect: "none" },
  "catalog":             { he: "שמות דגמים חדשים בקטלוג לבדיקה", sect: "wait" },
  "mag:fail":            { he: "כתבת מגזין לא פורסמה, הבדיקות נכשלו: {id}", sect: "wait" },
  "mag":                 { he: "כתבת מגזין פורסמה: {id}", sect: "none" },
  "webwatch:rollback":   { he: "האתר הוחזר לגרסה הקודמת בגלל מהירות, צריך להחליט מתי להחזיר", sect: "wait" },
  "webwatch:rollback-failed": { he: "החזרה האוטומטית של האתר נכשלה", sect: "fail" },
  "meta:uptime":         { he: "בדיקת הזמינות ב-Cloudflare לא מדווחת", sect: "fail" },
  "meta:telegram":       { he: "מערך ההתראות בטלגרם לא עבד", sect: "fail" },
  "weekly:missing":      { he: "הסיכום השבועי לא נשלח", sect: "fail" },
  "workers:refused":     { he: "פריסת Worker נעצרה ומחכה לתיקון: {id}", sect: "wait" },
  "workers:rollback":    { he: "פריסת Worker נכשלה בבדיקה: {id}", sect: "fail" },
  "workers:failed":      { he: "פריסת Worker נכשלה: {id}", sect: "fail" },
  "workers:forced":      { he: "קוד שלא היה ב-main הוחלף בפריסה: {id}", sect: "fyi" },
};
// key stems of every call site (spec 10.1, GitHub side); the selftest checks each has a real label and that the call sites use no other
export const FAMILIES_IN_USE = [
  "wf", "smoke", "expiry", "infra", "infra-branches", "guard:core", "guard:break", "guard:warn", "ministry", "checker:data-health",
  "review", "review3", "vitals", "reviews:error", "seo:daily", "seo:nodata", "seo:error", "mention",
  "seo-auto:blocked", "seo-auto:wait", "seo-auto:notice", "seo-auto:done", "catalog", "mag:pub", "mag:fail",
  "webwatch:rollback", "webwatch:rollback-failed", "meta:uptime", "weekly:missing", "workers:refused", "workers:rollback", "workers:failed", "workers:forced",
];

const TODAY = ["loud", "silent", "none"];
const ACTIONS = ["loud", "night", "remind", "remind-night", "deduped", "queued", "logged", "legacy", "failed", "ring"];
const NIGHT = "\n\n🌙 נשלח בשקט כי עכשיו לילה. צלצול תזכורת יגיע בבוקר.";
const EMPTY = '{"v":1,"items":{},"hb":{},"log":[]}';

// injectable I/O: the selftest swaps these (mocked fetch, fixed clock, scaled timers, captured stdout)
const IO = { env: process.env, fetch: (u, o) => fetch(u, o), now: () => Date.now(), scale: 1, out: s => process.stdout.write(s + "\n"), err: s => process.stderr.write(s + "\n") };
const ms = x => Math.max(1, Math.round(x * IO.scale));
const sleep = (x, dl) => new Promise(r => {   // ends early when dl aborts
  if (dl?.aborted) return r();
  const done = () => { clearTimeout(t); dl?.removeEventListener("abort", done); r(); }, t = setTimeout(done, ms(x));
  dl?.addEventListener("abort", done);
});
const iso = t => new Date(t).toISOString();
const t0 = s => (typeof s === "string" ? Date.parse(s) : NaN);
const rank = l => LEVELS.indexOf(l);
const J = s => { try { return JSON.parse(s); } catch { return null; } };
export const h12 = s => createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
const strip = t => String(t).replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const cap = t => (t.length > 4000 ? t.slice(0, 3993) + "…(קוצר)" : t);
const isDry = env => env.DRY_RUN === "1" || env.DRY === "1";

// ---- time (Intl only, no fixed offsets) ----
export function isDaytime(d = new Date()) {
  const h = +new Intl.DateTimeFormat("en-GB", { timeZone: QUIET.tz, hour: "2-digit", hourCycle: "h23" }).format(d);
  return h >= QUIET.dayStart && h < QUIET.dayEnd;
}
const parts = d => Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: QUIET.tz, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(d).map(p => [p.type, p.value]));
export function ilTime(d = new Date()) { const p = parts(d); return `${p.day}.${p.month} ${p.hour}:${p.minute}`; }   // "DD.MM HH:MM"
const ilDate = d => { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; };
const hhmm = d => { const p = parts(d); return `${p.hour}:${p.minute}`; };

// ---- keys, links, labels ----
// public logs and the public branch carry keys, so a key never holds names, numbers or text
export function validKey(k) {
  if (typeof k !== "string" || k.length > 120 || k.includes("@")) return false;
  if (!/^[a-z][a-z0-9-]*(:[A-Za-z0-9 ()._+\-]{1,80}){0,3}$/.test(k)) return false;
  return k.split(":").every(s => (/^[0-9a-f]{7,16}$/i.test(s) && /[a-f]/i.test(s)) ||   // a hash or short sha (at least one letter: an all-digit run is a number)
    !/\d{5,}/.test(s.replace(ISO_DATE, "-").replace(/(\d)[ ()._+\-]+(?=\d)/g, "$1")));    // no 5+ digit run, separators ignored (12-345-67, 050 123 4567, 12.500)
}
const ISO_DATE = /(?<!\d)20\d\d-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?(?!\d)/g;   // 2026-10 and 2026-10-18 in keys like mag:pub:2026-10-18-x
const decoded = u => { try { return decodeURIComponent(u); } catch { return "@"; } };   // undecodable counts as unsafe
const cleanLinks = l => (Array.isArray(l) ? l : [l]).filter(u => typeof u === "string" && u.startsWith("https://") && u.length <= 300 &&
  !/@|%40/i.test(u + decoded(u)) && !/\s/.test(u)).slice(0, 3);
const family = key => { const s = String(key).split(":"), two = s.slice(0, 2).join(":"); return s.length > 1 && LABELS[two] ? two : LABELS[s[0]] ? s[0] : null; };
export function label(key) {
  const f = family(key);
  if (!f) return { he: "התראה: " + key, sect: "fyi" };
  const L = LABELS[f], id = String(key).split(":").slice(f.split(":").length).join(":");
  return { he: L.he.replace("{ids}", id.split("+").map(x => (L.ids && L.ids[x]) || x).join(", ")).replace("{id}", id), sect: L.sect };
}
export function routed(level, env = process.env) {
  const r = String(env.ALERT_ROUTE || "").split(",").map(s => s.trim().toLowerCase());
  return LEVELS.includes(level) && (r.includes("all") || r.includes(level));
}
const srcName = env => { const s = String(env.GITHUB_WORKFLOW || "").replace(/[^\w ()._+\-]/g, "").slice(0, 80); return /\d{5,}/.test(s) ? "" : s; };

// ---- network: every request has its own timeout and reads its body inside it; dl = the call's deadline signal ----
async function req(url, o, t, dl) {
  const c = new AbortController(), stop = () => c.abort(), timer = setTimeout(stop, ms(t));
  dl?.addEventListener("abort", stop);
  try {
    if (dl?.aborted) throw new Error("deadline");
    const r = await IO.fetch(url, { ...o, signal: c.signal });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } finally { clearTimeout(timer); dl?.removeEventListener("abort", stop); }
}
const repo = () => IO.env.GITHUB_REPOSITORY || "ddsabag/vehicle-app";
const gh = (method, path, body, dl, t = 8000) => req(`https://api.github.com/repos/${repo()}${path}`, { method, headers: {
  authorization: "Bearer " + IO.env.GITHUB_TOKEN, accept: "application/vnd.github+json", "user-agent": "luchit-alert",
  ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }, t, dl);

// Telegram: 10 s per try, 2 tries 1 s apart (a 429 retry_after up to 10 s is honoured); a 400 on HTML entities is retried once as plain text.
// The deadline is checked before each try only, so a send in flight is never cut (cutting it could deliver and still look failed);
// once it has fired, the retry wait is skipped.
async function tg(text, { silent = false, plain = false } = {}, dl) {
  const env = IO.env;
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  let t = cap(String(text)), html = !plain;
  for (let i = 0; i < 2; i++) {
    if (dl?.aborted) return false;
    let wait = 1000;
    try {
      const r = await req(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: t, disable_web_page_preview: true, disable_notification: silent, ...(html ? { parse_mode: "HTML" } : {}) }) }, 10000);
      if (r.ok) return true;
      if (r.status === 400 && html && /can't parse entities/i.test(r.text)) { html = false; t = cap(strip(text)); i--; continue; }
      if (r.status === 429) wait = Math.min(+(J(r.text)?.parameters?.retry_after) || 1, 10) * 1000;
      else if (r.status < 500) return false;   // 401/403/400: a retry cannot help
    } catch { /* timeout or network: retry */ }
    if (!i) await sleep(wait, dl);
  }
  return false;
}
// Brevo email to Dudu's own inbox; only when BREVO_API_KEY is in the environment
async function mail(subject, text, links, dl) {
  const key = IO.env.BREVO_API_KEY;
  if (!key || dl?.aborted) return false;
  try {
    const r = await req("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: EMAIL_FROM, to: [{ email: EMAIL_TO }], subject, textContent: strip(text) + "\n" + cleanLinks(links).join("\n") }) }, 10000);
    return r.ok;
  } catch { return false; }
}

// ---- state I/O (own CAS helper; flash.mjs is not used) ----
const okState = s => s && typeof s === "object" && !Array.isArray(s) && s.items && typeof s.items === "object" && !Array.isArray(s.items);
const norm = s => ({ v: 1, items: s.items, hb: s.hb && typeof s.hb === "object" ? s.hb : {}, log: Array.isArray(s.log) ? s.log : [] });
// {data, sha} | {missing: true} | null (read error, bad JSON, wrong shape)
async function getFile(file, dl) {
  const r = await gh("GET", `/contents/${file}?ref=${STATE.branch}`, null, dl);
  if (r.status === 404) return { missing: true };
  if (!r.ok) return null;
  const j = J(r.text), data = j && typeof j.content === "string" ? J(Buffer.from(j.content, "base64").toString("utf8")) : null;
  if (file === STATE.file ? !okState(data) : !data) return null;
  return { data: file === STATE.file ? norm(data) : data, sha: j.sha };
}
// orphan branch holding only an empty state.json; a 422 because another run created it first is fine
async function ensureBranch(dl) {
  const ref = await gh("GET", `/git/ref/heads/${STATE.branch}`, null, dl);
  if (ref.status !== 404) return;
  const tree = await gh("POST", "/git/trees", { tree: [{ path: STATE.file, mode: "100644", type: "blob", content: EMPTY }] }, dl);
  if (!tree.ok) return;
  const commit = await gh("POST", "/git/commits", { message: "alert state", tree: J(tree.text)?.sha, parents: [] }, dl);
  if (!commit.ok) return;
  await gh("POST", "/git/refs", { ref: "refs/heads/" + STATE.branch, sha: J(commit.text)?.sha }, dl);
}
// GET (sha) -> pure change(copy) -> PUT with the sha; 409/422 re-read and re-apply, up to `tries`. change returns null for "nothing to write".
// Returns {s, wrote} or null. Never throws.
async function cas(file, change, { tries = 4, dl } = {}) {
  if (!IO.env.GITHUB_TOKEN) return null;
  let made = false;
  try {
    for (let i = 0; i < tries; i++) {
      if (dl?.aborted) return null;
      if (i) await sleep(300 + Math.random() * 1200);
      let g = await getFile(file, dl);
      if (g?.missing && !made) { made = true; await ensureBranch(dl); g = await getFile(file, dl); }
      if (!g) return null;
      const cur = g.missing ? (file === STATE.file ? J(EMPTY) : {}) : g.data, next = change(structuredClone(cur));
      if (next === null) return { s: cur, wrote: false };
      const w = await gh("PUT", `/contents/${file}`, { message: "alert " + file, branch: STATE.branch,
        content: Buffer.from(JSON.stringify(next)).toString("base64"), ...(g.sha ? { sha: g.sha } : {}) }, dl);
      if (w.ok) return { s: next, wrote: true };
      if (w.status !== 409 && w.status !== 422) return null;
    }
  } catch { /* timeout, abort, network */ }
  return null;
}
// state as read (404 = empty), or null when it cannot be read; used by waiting.mjs
export async function readState(dl) {
  if (!IO.env.GITHUB_TOKEN) return null;
  try { const g = await getFile(STATE.file, dl); return !g ? null : g.missing ? J(EMPTY) : g.data; } catch { return null; }
}

// ---- pure decision and state change ----
const newEpisode = (it, lv, fresh, now) => !it || !it.open || !!fresh || !(now - t0(it.last) <= IDLE_MS) || rank(lv) > rank(it.lv);
// would-action against a state: logged|queued|deduped|loud|remind|night|remind-night, or legacy when a backstop gate is not met
export function decide(s, lv, key, fresh, now, day) {
  const it = s.items[key], hb = s.hb || {}, ep = newEpisode(it, lv, fresh, now);
  if (lv === "silent" || lv === "summary") return { a: !(now - t0(hb.summaryAt) <= GATE_SUMMARY_MS) ? "legacy" : lv === "silent" ? "logged" : "queued", ep };
  let remind = false;
  if (!ep && it.sent) { if (now - t0(it.sent) >= REMIND_MS) remind = true; else return { a: "deduped", ep }; }
  if (lv === "critical" && !remind) return { a: "loud", ep, email: true };
  if (day) return { a: remind ? "remind" : "loud", ep, remind };
  if (!(now - t0(hb.dailyAt) <= GATE_NIGHT_MS)) return { a: "legacy", ep };
  return { a: remind ? "remind-night" : "night", ep, remind, night: true };
}
// o: {key, level, now, fresh, links, src, today}; count = this occurrence (n++, last); set = {sent, pend}; a/sh = log entry
function apply(s, o, { count = true, a = null, sh = 0, set = null } = {}) {
  const now = iso(o.now);
  if (count) {
    const old = s.items[o.key], ep = newEpisode(old, o.level, o.fresh, o.now);
    const it = ep ? { lv: o.level, u: [], first: now, last: now, n: 0, sent: null, pend: old?.pend || null, open: true } : { ...old };
    it.n = (it.n || 0) + 1; it.last = now; it.open = true;
    if (rank(o.level) > rank(it.lv)) it.lv = o.level;
    if (o.src) it.src = o.src;
    if (o.links.length) it.u = o.links;
    s.items[o.key] = it;
  }
  if (set && s.items[o.key]) Object.assign(s.items[o.key], set);
  if (a) s.log = [...s.log, { t: now, k: o.key, lv: o.level, a, td: o.today, sh }].slice(-600);
  return s;
}
// best-effort record after (or, from the CLI, before) a legacy send: one GET and one PUT, no retry, 10 s. Returns the logged action.
async function record(o, a, delivered, sh, counted = false) {
  if (!IO.env.GITHUB_TOKEN) return a || "";
  const c = new AbortController(), timer = setTimeout(() => c.abort(), ms(10000));
  let would = a || "";
  try {
    await cas(STATE.file, s => {
      would = a || decide(s, o.level, o.key, o.fresh, o.now, isDaytime(new Date(o.now))).a;
      return apply(s, o, { count: !counted, a: would, sh, set: delivered && o.today !== "none" ? { sent: iso(o.now) } : null });
    }, { tries: 1, dl: c.signal });
  } finally { clearTimeout(timer); }
  return would;
}

// ---- routed path; returns {delivered, action} or {legacy: true, delivered?, action, after?} ----
async function route(o, text, opts, dl, st) {
  if (!IO.env.GITHUB_TOKEN) return { legacy: true, action: "legacy" };
  const g = await readState(dl);
  if (!g) return { legacy: true, action: "legacy" };
  const d = decide(g, o.level, o.key, o.fresh, o.now, isDaytime(new Date(o.now)));
  if (d.a === "legacy") return { legacy: true, action: "legacy", after: r => record(o, "legacy", r, 0) };
  if (d.a === "logged" || d.a === "queued" || d.a === "deduped") {   // the write is the action: a failed write -> legacy
    const w = await cas(STATE.file, s => apply(s, o, { a: d.a }), { dl });
    return w ? { delivered: true, action: d.a } : { legacy: true, action: "legacy" };
  }
  let counted = false;
  if (d.night) {   // the morning-ring pointer is written first; a failed write -> legacy (loud, as today)
    if (!await cas(STATE.file, s => apply(s, o, { a: d.a, set: { pend: iso(o.now) } }), { dl })) return { legacy: true, action: "legacy" };
    counted = true;
  }
  const it = g.items[o.key];
  const body = (d.remind ? `🔁 תזכורת: זה עדיין קורה (מאז ${ilTime(new Date(t0(it.first) || o.now))}, ${(it.n || 0) + 1} פעמים)\n\n` : "") + text + (d.night ? NIGHT : "");
  const sent = tg(body, { silent: !!d.night, plain: o.plain }, dl).then(ok => { if (ok && !st.ok) { st.ok = true; st.action = d.a; opts.onSent?.(d.a); } return ok; });
  st.inflight = sent;
  const subject = "🔴 לוחית: " + label(o.key).he;
  const [ok, mailed] = await Promise.all([sent, d.email ? mail(subject, text, o.links, dl) : false]);
  if (ok) {   // send first, then write; a failed write is only logged (the next occurrence may duplicate, nothing is lost)
    const w = await cas(STATE.file, s => apply(s, o, { count: !counted, a: counted ? null : d.a, set: { sent: iso(o.now), ...(d.night ? {} : { pend: null }) } }), { dl });
    return { delivered: true, action: d.a + (w ? "" : " unsaved") };
  }
  // Telegram failed after retries: Brevo email (critical already sent one in parallel), then legacy as a last try
  const em = d.email ? mailed : await mail(subject, text, o.links, dl);
  return { legacy: true, delivered: em, action: "failed", after: r => record(o, "failed", r, 0, counted) };
}

// alert(level, key, text, link, {today, legacy, plain, fresh, levels}) -> {delivered, action}. Never throws on its own (legacy's exceptions propagate).
// Logs exactly one line "alert <key> <level> -> <action>": never text, links or numbers.
export async function alert(level, key, text, link = "", opts = {}) {
  const env = IO.env, legacy = opts.legacy, all = Array.isArray(opts.levels) && opts.levels.length ? opts.levels : [level];
  let said = false;
  const say = a => { if (said) return; said = true; IO.out(validKey(key) ? `alert ${key} ${LEVELS.includes(level) ? level : "invalid-level"} -> ${a}` : `alert <invalid-key> -> ${a}`); };
  opts = { ...opts, onSent: a => { say(a); opts.onDone?.(a); } };
  const runLegacy = async () => (typeof legacy === "function" ? await legacy() : false);
  if (isDry(env) || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !validKey(key) || !LEVELS.includes(level) || !all.every(l => LEVELS.includes(l))) {
    say("legacy");
    return { delivered: await runLegacy(), action: "legacy" };
  }
  const o = { level, key, now: IO.now(), fresh: !!opts.fresh, links: cleanLinks(link), src: srcName(env), today: TODAY.includes(opts.today) ? opts.today : "loud", plain: !!opts.plain };
  if (!all.every(l => routed(l, env))) {   // SHADOW: today's send, plus a record of what the router would have done
    // the CLI records before the caller's send and never learns its result, so it leaves `sent` unset (worst case one duplicate at switch-on)
    if (opts.cli) { const w = await record(o, null, false, 1); say("shadow:" + (w || "unrecorded")); return { delivered: await runLegacy(), action: "legacy" }; }
    const r = await runLegacy();
    const w = await record(o, null, r, 1);
    say("shadow:" + (w || "unrecorded"));
    return { delivered: r, action: "shadow:" + (w || "unrecorded") };
  }
  // routed: the whole call races DEADLINE_MS; before any send that means legacy, after a send that send's result
  const ac = new AbortController(), st = { ok: false, action: null, inflight: null };
  const timer = setTimeout(() => ac.abort(), ms(DEADLINE_MS));
  let res;
  try {
    const p = route(o, text, opts, ac.signal, st).catch(() => (st.ok ? { delivered: true, action: st.action } : { legacy: true, action: "legacy" }));
    const late = new Promise(r => ac.signal.addEventListener("abort", () => r(null), { once: true }));
    res = await Promise.race([p, late]);
    if (res === null) {
      if (!st.ok && st.inflight) await Promise.race([st.inflight.catch(() => false), sleep(10000)]);   // a fetch that ignores its signal still ends here
      res = st.ok ? { delivered: true, action: st.action } : { legacy: true, action: "legacy" };
    }
  } finally { clearTimeout(timer); }
  if (!res.legacy) { say(res.action); return { delivered: true, action: res.action }; }
  say(res.action);
  const r = await runLegacy();
  if (res.after) await res.after(r);
  return { delivered: res.delivered || r, action: res.action };
}

// close every open item under the prefixes (no message); one read, at most one write, 8 s, never throws
export async function resolve(prefixes) {
  const env = IO.env, pre = (Array.isArray(prefixes) ? prefixes : [prefixes]).filter(p => typeof p === "string" && p);
  if (isDry(env) || !env.GITHUB_TOKEN || !pre.length) return 0;
  const c = new AbortController(), timer = setTimeout(() => c.abort(), ms(8000));
  let n = 0;
  try {
    const s = await readState(c.signal);
    if (!s || !Object.entries(s.items).some(([k, it]) => it.open && pre.some(p => k.startsWith(p)))) return 0;
    const w = await cas(STATE.file, x => {
      n = 0;
      for (const [k, it] of Object.entries(x.items)) if (it.open && pre.some(p => k.startsWith(p))) { it.open = false; n++; }
      return n ? x : null;
    }, { dl: c.signal });
    return w?.wrote ? n : 0;
  } catch { return 0; } finally { clearTimeout(timer); }
}

// ---- daily job (alert-daily.yml) ----
// scheduled runs act only at local 08:00-13:59 and once per local day; manual runs skip the hour check
export function dailyGate(now, hb, scheduled) {
  const d = new Date(now), h = +parts(d).hour;
  if (scheduled && (h < 8 || h >= 14)) return "early";
  return hb && hb.daily === ilDate(d) ? "done" : "act";
}
export function prune(s, now) {
  for (const [k, it] of Object.entries(s.items)) if (!(now - t0(it.last) <= 21 * 864e5)) delete s.items[k];
  s.log = s.log.filter(e => now - t0(e.t) <= 35 * 864e5).slice(-600);
  return s;
}
const ringText = items => [`☀️ לוחית: מה קרה בלילה (${items.length})`, ...items.map(([k, it]) => `• ${label(k).he} (${hhmm(new Date(t0(it.pend)))})`),
  "הפרטים בהודעות השקטות שנשלחו בלילה."].join("\n");
async function daily() {
  const env = IO.env, now = IO.now(), dry = isDry(env), today = ilDate(new Date(now));
  if (!env.GITHUB_TOKEN) { IO.out("daily: no GITHUB_TOKEN"); return 1; }
  const s0 = await readState();
  if (!s0) { IO.out("daily: state not readable"); return 1; }
  const gate = dailyGate(now, s0.hb, env.GITHUB_EVENT_NAME === "schedule");
  if (gate === "early") { IO.out("daily: outside 08:00-14:00 local, nothing to do"); return 0; }
  if (gate === "done" && !dry) { IO.out("daily: already done today"); return 0; }
  let s = s0;
  if (!dry) {   // 1 claim
    const c = await cas(STATE.file, x => (x.hb.daily === today ? null : (x.hb.daily = today, x.hb.dailyAt = iso(now), x)));
    if (!c) { IO.out("daily: claim failed"); return 1; }
    if (!c.wrote) { IO.out("daily: already done today"); return 0; }
    s = c.s;
  }
  // 2 Telegram self-test (getMe + getChat send nothing)
  IO.out("email path: " + (env.BREVO_API_KEY ? "on" : "off"));
  let tgOk = false;
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) try {
    const base = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/`;
    const [a, b] = await Promise.all([req(base + "getMe", {}, 10000), req(base + "getChat?chat_id=" + encodeURIComponent(env.TELEGRAM_CHAT_ID), {}, 10000)]);
    tgOk = a.ok && b.ok && J(a.text)?.ok === true && J(b.text)?.ok === true;
  } catch { tgOk = false; }
  IO.out("telegram self-test: " + (tgOk ? "ok" : "failed"));
  const runUrl = env.GITHUB_RUN_ID ? `https://github.com/${repo()}/actions/runs/${env.GITHUB_RUN_ID}` : "";
  if (!tgOk && !dry) await mail("🚨 לוחית: מערך ההתראות בטלגרם לא עובד",
    "בדיקת הטלגרם היומית נכשלה (getMe/getChat). עד שזה יתוקן, התראות קריטיות מגיעות במייל, וריצות שנכשלות שולחות את המייל של GitHub.", [runUrl]);
  // 3 morning ring
  const pend = Object.entries(s.items).filter(([, it]) => it.pend).sort((a, b) => t0(a[1].pend) - t0(b[1].pend));
  let ringOk = true;
  if (dry) IO.out(`would ring ${pend.length}`);
  else if (pend.length) {
    const text = ringText(pend);
    if (await tg(text, { plain: true })) {
      const seen = Object.fromEntries(pend.map(([k, it]) => [k, it.pend]));
      await cas(STATE.file, x => {
        for (const [k, p] of Object.entries(seen)) if (x.items[k] && x.items[k].pend === p) {
          x.items[k].pend = null;
          x.log = [...x.log, { t: iso(now), k, lv: x.items[k].lv, a: "ring", td: "none", sh: 0 }].slice(-600);
        }
        return x;
      });
      IO.out("morning ring sent");
    } else { ringOk = false; await mail("☀️ לוחית: מה קרה בלילה", text, []); IO.out("morning ring failed"); }
  }
  const direct = text => () => tg(text, { plain: true });   // meta alerts: a direct loud send is their legacy, so they work in shadow too
  // 4 uptime Worker check
  let upSeen = false;
  const up = String(env.ALERT_UPTIME_URL || "").replace(/\/+$/, "");
  if (up) {
    let tick = NaN;
    try { const r = await req(up + "/health", {}, 10000); if (r.ok) tick = t0(J(r.text)?.tick); } catch { /* stale */ }
    upSeen = now - tick <= 30 * 6e4;
    IO.out("uptime worker: " + (upSeen ? "ok" : "stale"));
    if (!upSeen && s.hb.uptimeSeenAt) {
      const text = `⚠️ בדיקת הזמינות ב-Cloudflare (luchit-uptime) לא דיווחה מאז ${ilTime(new Date(tick > 0 ? tick : t0(s.hb.uptimeSeenAt)))}. הבדיקות היומיות ב-GitHub ממשיכות כרגיל.`;
      if (dry) IO.out("would alert meta:uptime"); else await alert("day", "meta:uptime", text, "", { today: "loud", plain: true, legacy: direct(text) });
    }
  }
  // 5 Monday: the Sunday summary must have gone out (armed once hb.summaryAt exists)
  if (parts(new Date(now)).weekday === "Mon" && s.hb.summaryAt) {
    const sa = new Date(t0(s.hb.summaryAt)), sunday = ilDate(new Date(now - 864e5));
    if (`${ilDate(sa)} ${parts(sa).hour}` < `${sunday} 08`) {
      const text = "⚠️ הסיכום השבועי של יום ראשון לא נשלח. להריץ ידנית: Actions ← Weekly analytics report ← Run workflow, לסמן send.";
      const link = `https://github.com/${repo()}/actions/workflows/weekly-analytics.yml`;
      if (dry) IO.out("would alert weekly:missing"); else await alert("day", "weekly:missing", text, link, { today: "loud", plain: true, legacy: direct(text) });
    }
  }
  if (dry) { IO.out("dry run: nothing sent or written"); return 0; }
  // 6 heartbeat (read by luchit-uptime), then the self-test marks and the prune
  const hb = await cas(STATE.heartbeat, () => ({ t: iso(now) }));
  IO.out("heartbeat " + (hb ? "written" : "not written"));
  const fin = await cas(STATE.file, x => {
    if (tgOk) x.hb.tgOkAt = iso(now); else x.hb.tgFailAt = iso(now);
    if (upSeen) x.hb.uptimeSeenAt = iso(now);
    return prune(x, now);
  });
  IO.out("state " + (fin ? "pruned" : "not written"));
  return tgOk && ringOk ? 0 : 1;   // 7 a red run brings GitHub's own email
}
async function markSummary() {
  if (isDry(IO.env)) { IO.out("dry run: summary not marked"); return 0; }
  const now = IO.now(), w = await cas(STATE.file, x => { x.hb.summaryAt = iso(now); return x; });
  IO.out(w ? "summary marked" : "summary not marked");
  return w ? 0 : 1;
}

// ---- CLI ----
class Usage extends Error {}
function flags(args, spec) {
  const f = { link: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i], name = a.slice(2);
    if (!a.startsWith("--") || !(name in spec)) throw new Usage("unknown argument");
    if (spec[name] === "bool") f[name] = true;
    else { if (i + 1 >= args.length) throw new Usage("missing value"); const v = args[++i]; if (name === "link") f.link.push(v); else f[name] = v; }
  }
  return f;
}
// one alert from the command line; legacy = print ALERT_LEGACY (the shell then runs its own original send)
async function cliAlert(level, key, text, link, { today, plain, fresh }) {
  if (!LEVELS.includes(level) || !TODAY.includes(today) || typeof key !== "string" || typeof text !== "string") throw new Usage("bad arguments");
  let legacy = false, done = false;
  const r = await alert(level, key, text, link, { today, plain, fresh, cli: true, legacy: async () => { legacy = true; return false; },
    onDone: a => { done = true; IO.out(`ALERT_DONE ${a} 1`); } });   // printed as soon as the message is out, before the state write
  if (!done) IO.out(legacy ? "ALERT_LEGACY" : `ALERT_DONE ${r.action} ${r.delivered ? 1 : 0}`);
  return 0;
}
export async function cli(argv, stdin = () => fs.readFileSync(0, "utf8")) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "send") {
      const [level, key, ...more] = rest, f = flags(more, { today: "v", text: "v", file: "v", plain: "bool", link: "v", fresh: "bool" });
      if (("text" in f) === ("file" in f)) throw new Usage("--text or --file");
      let text = f.text;
      if (f.file) try { text = fs.readFileSync(f.file, "utf8"); } catch { throw new Usage("file not readable"); }
      return await cliAlert(level, key, text, f.link, { today: f.today, plain: !!f.plain, fresh: !!f.fresh });
    }
    if (cmd === "wf") {
      const [name, ...more] = rest, f = flags(more, { today: "v", text: "v", link: "v", repeat: "bool" });
      if (typeof name !== "string" || !name || !["loud", "silent"].includes(f.today) || typeof f.text !== "string") throw new Usage("bad arguments");
      return await cliAlert(WF_LEVELS[name] ?? "day", "wf:" + name, f.text, f.link, { today: f.today, plain: true, fresh: !f.repeat });
    }
    if (cmd === "--stdin") {
      const j = J(stdin());
      if (!j || typeof j !== "object") throw new Usage("bad JSON");
      return await cliAlert(j.level, j.key, j.text, j.link || "", { today: j.today, plain: !!j.plain, fresh: !!j.fresh });
    }
    if (cmd === "daily") return await daily();
    if (cmd === "mark-summary") return await markSummary();
    if (cmd === "selftest") return await selftest();
    throw new Usage("unknown command");
  } catch (e) {
    if (!(e instanceof Usage)) throw e;
    IO.err("usage: alert.mjs send|wf|--stdin|daily|mark-summary|selftest (" + e.message + ")");
    return 2;
  }
}

// ---- selftest (offline: mocked fetch, fixed clock, timers scaled down 100x) ----
async function selftest() {
  const path = await import("node:path"), url = await import("node:url"), cp = await import("node:child_process");
  const SELF = url.fileURLToPath(import.meta.url), ROOT = path.resolve(path.dirname(SELF), "../..");
  const keep = { ...IO };
  let n = 0, bad = 0;
  const ok = (c, m) => { n++; if (!c) { bad++; process.stdout.write("FAIL " + m + "\n"); } };
  const B64 = s => Buffer.from(s).toString("base64");
  const res = (status, body = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  // fake GitHub contents/git API, Telegram and Brevo; o.get / o.put / o.tg / o.brevo inject failures
  function net(o = {}) {
    const m = { files: {}, branch: o.branch !== false, calls: [], tg: [], mails: [], puts: 0, gets: 0, seq: 0, tree: null };
    if (o.state) m.files["state.json"] = { sha: "s0", text: JSON.stringify(o.state) };
    const hang = (init, honour) => new Promise((ok2, no) => {
      const t = setTimeout(() => ok2(res(500)), ms(60000));
      if (honour) init.signal?.addEventListener("abort", () => { clearTimeout(t); no(new Error("aborted")); });
    });
    const delay = (init, t) => new Promise((ok2, no) => { const h = setTimeout(ok2, ms(t)); init.signal?.addEventListener("abort", () => { clearTimeout(h); no(new Error("aborted")); }); });
    const step = (v, init) => (v === "hang" ? hang(init, true) : v === "hang-hard" ? hang(init, false) : v === "bad" ? res(200, { sha: "x", content: B64("{not json") }) : res(v));
    m.fetch = async (u, init = {}) => {
      const method = init.method || "GET";
      m.calls.push(method + " " + u.replace(/^https:\/\/[^/]+/, ""));
      if (u.startsWith("https://api.telegram.org/")) {
        if (/getMe|getChat/.test(u)) return res(o.tgSelf ?? 200, { ok: (o.tgSelf ?? 200) === 200 });
        const b = JSON.parse(init.body), v = (o.tg || []).shift();
        m.tg.push(b);
        if (v === "hang-hard") return hang(init, false);
        if (v?.wait) await delay(init, v.wait);
        if (v?.status) return res(v.status, v.body || { ok: false });
        return res(200, { ok: true });
      }
      if (u.startsWith("https://api.brevo.com/")) { m.mails.push(JSON.parse(init.body)); return res(o.brevo ?? 201, {}); }
      if (u.startsWith("https://luchit-uptime.test/")) return o.health ? res(200, o.health) : res(503);
      const p = u.replace(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+/, "");
      const file = (/^\/contents\/([^?]+)/.exec(p) || [])[1];
      if (file && method === "GET") {
        m.gets++;
        const v = (o.get || []).shift();
        if (v?.wait) await delay(init, v.wait); else if (v) return step(v, init);
        const f = m.files[file];
        return m.branch && f ? res(200, { sha: f.sha, content: B64(f.text) }) : res(404, { message: "Not Found" });
      }
      if (file && method === "PUT") {
        m.puts++;
        const v = (o.put || []).shift();
        if (v?.wait) await delay(init, v.wait); else if (v) return step(v, init);
        const b = JSON.parse(init.body), f = m.files[file];
        if (!m.branch) return res(404);
        if (f ? b.sha !== f.sha : b.sha) return res(409);
        m.files[file] = { sha: "s" + ++m.seq, text: Buffer.from(b.content, "base64").toString("utf8") };
        return res(200, { content: { sha: m.files[file].sha } });
      }
      if (p.startsWith("/git/ref/heads/")) return m.branch ? res(200, { object: { sha: "c" } }) : res(404);
      if (p === "/git/trees") { m.tree = JSON.parse(init.body).tree[0].content; return res(201, { sha: "t1" }); }
      if (p === "/git/commits") return res(201, { sha: "c1" });
      if (p === "/git/refs") { if (m.branch) return res(422); m.branch = true; m.files["state.json"] = { sha: "s" + ++m.seq, text: m.tree }; return res(201, {}); }
      return res(400);
    };
    m.state = () => J(m.files["state.json"]?.text || "null");
    return m;
  }
  const ENV = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c", GITHUB_TOKEN: "g", GITHUB_REPOSITORY: "o/r", GITHUB_WORKFLOW: "Data guard", ALERT_ROUTE: "all" };
  const DAY = Date.parse("2026-10-20T09:00:00Z"), NIGHT_T = Date.parse("2026-10-20T21:00:00Z"), H = 36e5;
  const gates = (now, night = true, summary = true) => ({ dailyAt: iso(now - (night ? 1 : 31) * H), summaryAt: iso(now - (summary ? 24 : 9 * 24) * H) });
  let out = [];
  async function run(o) {   // one alert() call against a fresh mock; returns what happened
    const m = o.m || net({ state: o.state, get: o.get, put: o.put, tg: o.tg, brevo: o.brevo, branch: o.branch });
    IO.fetch = m.fetch; IO.env = { ...ENV, ...(o.env || {}) }; IO.now = () => o.now ?? DAY; out = [];
    let legacy = 0;
    const r = await alert(o.level, o.key ?? "guard:core:a1b2c3d4", o.text ?? "<b>טקסט</b> בדיקה", o.link ?? "", { today: o.today ?? "loud",
      levels: o.levels, fresh: o.fresh, plain: o.plain, legacy: async () => { legacy++; if (o.throws) throw new Error("legacy boom"); return o.ret ?? true; } });
    return { r, legacy, m, out: out.slice(), st: m.state() };
  }
  IO.scale = 0.01; IO.out = s => out.push(s); IO.err = () => {};
  try {
    // DST pins
    for (const [u, want] of [["2026-10-24T18:59Z", true], ["2026-10-24T19:00Z", false], ["2026-10-24T23:30Z", false], ["2026-10-25T05:59Z", false],
      ["2026-10-25T06:00Z", true], ["2027-03-26T04:59Z", false], ["2027-03-26T05:00Z", true]]) ok(isDaytime(new Date(u)) === want, "isDaytime " + u);
    ok(ilTime(new Date("2026-10-25T06:00Z")) === "25.10 08:00" && ilTime(new Date("2026-10-24T18:59Z")) === "24.10 21:59", "ilTime");
    // daily gate: crons 05:05 / 06:05 UTC, delays 0/25/39 min, around both DST switches: exactly one acting run a day, never before 08:00
    for (const day of ["2026-10-24", "2026-10-25", "2027-03-26"]) for (const d1 of [0, 25, 39]) for (const d2 of [0, 25, 39]) {
      const hb = { daily: "x" }; let acts = 0;
      for (const t of [Date.parse(`${day}T05:05:00Z`) + d1 * 6e4, Date.parse(`${day}T06:05:00Z`) + d2 * 6e4]) if (dailyGate(t, hb, true) === "act") {
        acts++; ok(+parts(new Date(t)).hour >= 8, "daily acts before 08:00 " + day); hb.daily = ilDate(new Date(t));
      }
      ok(acts === 1, `daily gate ${day} +${d1}/+${d2}: ${acts} acting runs`);
    }
    ok(dailyGate(Date.parse("2026-10-24T04:00Z"), {}, false) === "act", "manual run skips the hour check");

    // decision table: level x day/night x episode x gates; reminders are never loud at night
    const SC = { none: null, same: { sent: -1, last: -1 }, remind: { sent: -23, last: -1 }, idle: { sent: -27, last: -27 },
      closed: { sent: -1, last: -1, open: false }, fresh: { sent: -1, last: -1 }, rise: { sent: -1, last: -1, lower: true } };
    for (const lv of LEVELS) for (const day of [true, false]) for (const sc of Object.keys(SC)) for (const gN of [true, false]) for (const gS of [true, false]) {
      if (sc === "rise" && lv === "silent") continue;
      const now = day ? DAY : NIGHT_T, k = "guard:core:a1b2c3d4", spec = SC[sc];
      const items = spec ? { [k]: { lv: spec.lower ? LEVELS[rank(lv) - 1] : lv, first: iso(now - 30 * H), last: iso(now + spec.last * H), n: 2,
        sent: iso(now + spec.sent * H), pend: null, open: spec.open ?? true, u: [] } } : {};
      const x = await run({ level: lv, now, fresh: sc === "fresh", state: { v: 1, items, hb: gates(now, gN, gS), log: [] }, env: { BREVO_API_KEY: "b" } });
      const first = ["none", "idle", "closed", "fresh", "rise"].includes(sc);
      let want;
      if (lv === "silent" || lv === "summary") want = gS ? { a: lv === "silent" ? "logged" : "queued" } : { a: "legacy", legacy: 1 };
      else if (sc === "same") want = { a: "deduped" };
      else if (lv === "critical" && first) want = { a: "loud", tg: "loud", mail: 1 };
      else if (day) want = { a: first ? "loud" : "remind", tg: "loud" };
      else if (!gN) want = { a: "legacy", legacy: 1 };
      else want = { a: first ? "night" : "remind-night", tg: "silent", pend: true };
      const tag = `${lv}/${day ? "day" : "night"}/${sc}/N${+gN}S${+gS}`;
      ok(x.r.action === want.a, `${tag}: action ${x.r.action}, want ${want.a}`);
      ok(x.legacy === (want.legacy || 0), `${tag}: legacy ${x.legacy}`);
      ok(x.m.tg.length === (want.tg ? 1 : 0) && (!want.tg || x.m.tg[0].disable_notification === (want.tg === "silent")), `${tag}: telegram ${JSON.stringify(x.m.tg.map(t => t.disable_notification))}`);
      ok(x.m.mails.length === (want.mail || 0), `${tag}: mails ${x.m.mails.length}`);
      if (x.m.tg.length && !day) ok(x.m.tg[0].disable_notification || (lv === "critical" && first), `${tag}: loud at night`);
      if (want.tg) ok(x.m.tg[0].text.startsWith("🔁") === /remind/.test(want.a) && x.m.tg[0].text.endsWith(NIGHT) === (want.tg === "silent"), `${tag}: text shape`);
      if (want.pend) ok(!!x.st.items[k].pend && !!x.st.items[k].sent, `${tag}: pointer and sent`);
      if (want.a === "loud" || want.a === "remind") ok(x.st.items[k].sent === iso(now) && x.st.items[k].n === (first ? 1 : 3), `${tag}: state after send`);
      ok(x.out.length === 1, `${tag}: one log line`);
    }

    // partial-rollout matrix: unrouted = legacy exactly once, its value passed through; routed and delivered = legacy never called
    const RT = { "": [], critical: ["critical"], "critical,silent": ["critical", "silent"], "critical,silent,day": ["critical", "silent", "day"], all: LEVELS, bogus: [] };
    for (const [route, on] of Object.entries(RT)) for (const lv of LEVELS) {
      const sentinel = { s: route + lv };
      const x = await run({ level: lv, ret: sentinel, env: { ALERT_ROUTE: route }, state: { v: 1, items: {}, hb: gates(DAY), log: [] } });
      if (on.includes(lv)) ok(x.legacy === 0 && x.r.delivered === true && x.st.log.at(-1).sh === 0, `route "${route}" ${lv}: routed`);
      else ok(x.legacy === 1 && x.r.delivered === sentinel && x.m.tg.length === 0 && x.st.log.at(-1).sh === 1, `route "${route}" ${lv}: shadow`);
    }
    {
      const x = await run({ level: "critical", key: "smoke:home+magazine", levels: ["critical", "day"], env: { ALERT_ROUTE: "critical" }, state: { v: 1, items: {}, hb: gates(DAY), log: [] } });
      ok(x.legacy === 1 && x.m.tg.length === 0, "combined {critical, day} with only critical routed: one legacy");
    }

    // failure matrix
    const base = () => ({ v: 1, items: {}, hb: gates(DAY), log: [] });
    const fm = async (name, o, want) => { const x = await run({ level: "day", state: base(), ...o }); ok(want(x), name + ": " + JSON.stringify({ a: x.r.action, legacy: x.legacy, tg: x.m.tg.length, mails: x.m.mails.length })); return x; };
    await fm("no GITHUB_TOKEN", { env: { GITHUB_TOKEN: "" } }, x => x.legacy === 1 && x.m.tg.length === 0);
    for (const g of [403, 500, "hang", "bad"]) await fm("GET " + g, { get: [g] }, x => x.legacy === 1 && x.m.tg.length === 0);
    await fm("PUT 409 x5 after a send", { put: [409, 409, 409, 409, 409] }, x => x.legacy === 0 && x.m.tg.length === 1 && x.r.delivered === true && /unsaved/.test(x.r.action));
    await fm("PUT 409 x5 on a queue", { level: "summary", put: [409, 409, 409, 409, 409] }, x => x.legacy === 1 && x.m.puts === 4);
    for (const lv of ["summary", "silent"]) await fm("PUT 403 on " + lv, { level: lv, put: [403] }, x => x.legacy === 1 && x.m.tg.length === 0);
    {
      const now = DAY, st = base(); st.items["guard:core:a1b2c3d4"] = { lv: "day", first: iso(now - 2 * H), last: iso(now - H), n: 1, sent: iso(now - H), pend: null, open: true, u: [] };
      await fm("PUT 403 on a dedupe", { state: st, put: [403] }, x => x.legacy === 1 && x.m.tg.length === 0);
    }
    await fm("PUT 409 then ok", { put: [409] }, x => x.legacy === 0 && x.r.action === "loud" && x.st.items["guard:core:a1b2c3d4"].sent);
    await fm("Telegram 500 x2, no Brevo key", { tg: [{ status: 500 }, { status: 500 }] }, x => x.legacy === 1 && x.m.tg.length === 2 && x.m.mails.length === 0 && x.r.action === "failed");
    await fm("Telegram 500 x2, Brevo key", { tg: [{ status: 500 }, { status: 500 }], env: { BREVO_API_KEY: "b" } },
      x => x.legacy === 1 && x.m.mails.length === 1 && x.r.delivered === true && x.st.log.at(-1).a === "failed");
    await fm("Telegram 401", { tg: [{ status: 401 }] }, x => x.legacy === 1 && x.m.tg.length === 1);
    {
      const t1 = Date.now();
      await fm("429 retry_after", { tg: [{ status: 429, body: { ok: false, parameters: { retry_after: 7 } } }] },
        x => x.legacy === 0 && x.m.tg.length === 2 && x.r.action === "loud" && Date.now() - t1 >= ms(7000));
    }
    await fm("400 on entities", { tg: [{ status: 400, body: { ok: false, description: "Bad Request: can't parse entities: unsupported start tag" } }] },
      x => x.legacy === 0 && x.m.tg.length === 2 && !("parse_mode" in x.m.tg[1]) && !x.m.tg[1].text.includes("<b>") && "parse_mode" in x.m.tg[0]);
    {
      const t1 = Date.now();
      await fm("fetch hangs 60 s before any send (deadline)", { get: ["hang-hard"] }, x => x.legacy === 1 && x.m.tg.length === 0 && Date.now() - t1 < ms(59000));
      const t2 = Date.now();
      await fm("fetch hangs 60 s after the send (deadline)", { put: ["hang-hard"] }, x => x.legacy === 0 && x.m.tg.length === 1 && x.r.delivered === true && Date.now() - t2 < ms(59000));
      await fm("Telegram send hangs past the deadline", { tg: ["hang-hard"] }, x => x.legacy === 1);
      const w = { wait: 6000 };   // night: read, pointer GET+PUT (18 s), an 8 s try answered 429 retry_after 10, then an 8 s try that succeeds at 44 s
      await fm("a send in flight at the deadline is awaited, not duplicated", { now: NIGHT_T, get: [w, w], put: [w],
        tg: [{ wait: 8000, status: 429, body: { ok: false, parameters: { retry_after: 10 } } }, { wait: 8000 }] },
        x => x.legacy === 0 && x.m.tg.length === 2 && x.r.delivered === true && x.r.action === "night");
      // night: read, pointer GET+409, GET+409, GET+PUT (38 s), then a try answered 429 retry_after 10 at 47.6 s: no retry wait past the deadline
      const rnd0 = Math.random, sc = IO.scale, v = { wait: 7500 };
      Math.random = () => 0; IO.scale = 0.05;
      try {
        const t3 = Date.now();
        await fm("deadline during a 429 retry wait: legacy without the wait", { now: NIGHT_T, get: [v, v, v, v], put: [409, 409, v],
          tg: [{ wait: 9500, status: 429, body: { ok: false, parameters: { retry_after: 10 } } }] },
          x => x.legacy === 1 && x.m.tg.length === 1 && x.r.action === "legacy" && Date.now() - t3 < ms(50000) && Date.now() - t3 >= ms(47000));
      } finally { Math.random = rnd0; IO.scale = sc; }
    }
    for (const d of [{ DRY: "1" }, { DRY_RUN: "1" }]) await fm("dry " + Object.keys(d)[0], { env: d }, x => x.legacy === 1 && x.m.calls.length === 0);
    await fm("no Telegram token", { env: { TELEGRAM_BOT_TOKEN: "" } }, x => x.legacy === 1 && x.m.calls.length === 0);
    await fm("invalid key", { key: "plate:12-345-67" }, x => x.legacy === 1 && x.m.calls.length === 0 && x.out[0] === "alert <invalid-key> -> legacy");
    await fm("missing branch is created as an orphan", { branch: false }, x => x.legacy === 0 && x.m.calls.includes("POST /repos/o/r/git/refs") && x.st.items["guard:core:a1b2c3d4"].sent);
    for (const [name, o] of [["shadow", { env: { ALERT_ROUTE: "" } }], ["gate not met", { level: "summary", state: { v: 1, items: {}, hb: {}, log: [] } }], ["unrouted dry", { env: { DRY: "1" } }]]) {
      let thrown = null;
      try { await run({ level: "day", state: base(), throws: true, ...o }); } catch (e) { thrown = e; }
      ok(thrown && thrown.message === "legacy boom", "legacy that throws propagates: " + name);
    }

    // resolve
    {
      const st = base();
      st.items["smoke:home"] = { lv: "critical", first: iso(DAY), last: iso(DAY), n: 1, sent: iso(DAY), pend: null, open: true, u: [] };
      st.items["smoke-x:y"] = { ...st.items["smoke:home"] }; st.items["expiry:cert"] = { ...st.items["smoke:home"], open: false };
      const m = net({ state: st }); IO.fetch = m.fetch; IO.env = { ...ENV };
      ok(await resolve(["smoke:", "expiry:"]) === 1 && m.state().items["smoke:home"].open === false && m.state().items["smoke-x:y"].open === true, "resolve closes the open prefix items");
      const p = m.puts; ok(await resolve("smoke:") === 0 && m.puts === p, "resolve with nothing open writes nothing");
      IO.env = { ...ENV, DRY: "1" }; ok(await resolve("smoke-x:") === 0 && m.puts === p, "resolve is a no-op in DRY");
      IO.env = { ...ENV, GITHUB_TOKEN: "" }; ok(await resolve("smoke-x:") === 0, "resolve without a token");
    }

    // privacy: 500 random calls; state = whitelist schema, no @, no 5+ digit runs, no 12+ character piece of any text; stdout = log lines only
    {
      const m = net({ state: { v: 1, items: {}, hb: gates(DAY), log: [] } }), texts = [];
      let seed = 7; const rnd = k => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
      const pick = a => a[rnd(a.length)];
      const bits = ["dudu.sabag@example.co.il", "12-345-67", "123-45-678", "050-1234567", "+972-52-765-4321", "4815162342", "₪12,500", "שלום", "הרכב",
        "<b>חשוב</b>", "a&amp;b", "Toyota Corolla 2019", "ת.ז. 012345678", "https://evil.example/x?u=1", "קילומטראז' 154,321"];
      const keys = () => pick(["wf:Data guard", "smoke:home+lookup", "infra:site", "guard:core:" + h12(rnd(1e6)).slice(0, 8), "review:" + h12(rnd(1e6)),
        "catalog:" + h12(rnd(9)), "mag:fail:2026-10", "seo:daily", "seo-auto:blocked:" + h12(rnd(50)).slice(0, 7), "mention:" + h12(rnd(5)), "meta:uptime"]);
      const caught = [];
      IO.out = s => caught.push(s);
      for (let i = 0; i < 500; i++) {
        const text = Array.from({ length: 2 + rnd(6) }, () => pick(bits) + " " + rnd(99999)).join(" ") + " #" + i;
        texts.push(text);
        IO.fetch = m.fetch; IO.env = { ...ENV, ALERT_ROUTE: pick(["", "critical", "all", "critical,silent,day", "all"]), BREVO_API_KEY: "b" };
        IO.now = () => DAY + rnd(72) * H;
        await alert(pick(LEVELS), keys(), text, pick(["", "https://github.com/o/r/actions/runs/123456", ["https://a.example/1", "mailto:x@y.z", "http://plain"], "https://x@y.example",
          ["https://luchit.app/?e=dudu%40gmail.com", "https://a.example/%2540x", "https://a.example/%E0%A4%A"]]),
          { today: pick(TODAY), fresh: !rnd(5), legacy: async () => !!rnd(4) });
      }
      IO.out = s => out.push(s);
      const st = m.state(), sch = schema(st);
      ok(sch === "", "privacy: whitelist schema " + sch);
      const pub = JSON.stringify({ ...st, items: Object.fromEntries(Object.entries(st.items).map(([k, it], i) => ["k" + i, { ...it, u: [] }])), log: st.log.map(e => ({ ...e, k: "k" })) });
      ok(!JSON.stringify(st).includes("@"), "privacy: no @ in state");
      ok(Object.values(st.items).every(it => it.u.every(u => !/@/.test(decodeURIComponent(decodeURIComponent(u))))), "privacy: no encoded @ in kept links");
      ok(cleanLinks(["https://a.example/?e=d%40g.com", "https://a.example/?e=d%2540g.com", "https://a.example/%E0%A4%A", "https://a.example/ok"]).join() === "https://a.example/ok", "cleanLinks drops %40 and undecodable links");
      ok(!/\d{5,}/.test(pub), "privacy: no 5+ digit run in state");
      const grams = new Set(), all12 = s => { for (let i = 0; i + 12 <= s.length; i++) grams.add(s.slice(i, i + 12)); };
      all12(JSON.stringify(st)); all12(caught.join("\n"));
      ok(!texts.some(t => { for (let i = 0; i + 12 <= t.length; i++) if (grams.has(t.slice(i, i + 12))) return true; return false; }), "privacy: no text piece in state or stdout");
      ok(caught.length === 500 && caught.every(l => /^alert (<invalid-key>|[a-z][\w:+ ().-]* (silent|summary|day|critical)) -> [a-z:-]+( unsaved)?$/.test(l)), "privacy: stdout holds log lines only");
      ok(Object.keys(st.items).length > 5 && st.log.length > 100 && st.log.some(e => e.sh === 1) && st.log.some(e => e.sh === 0), "privacy: the fuzz exercised state");
    }

    // keys and labels
    for (const k of ["plate:12-345-67", "plate:123-45-678", "plate:1234567", "x:12345", "user:dudu@example.com", "phone:050-1234567", "Bad:x",
      "x:" + "a".repeat(81), "a:b:c:d:e", "x:" + "ab ".repeat(39) + ":" + "c".repeat(40), "", "x:<b>", "num:+972-50-123-4567",
      "x:050-123-4567", "x:052-765-4321", "x:050 123 4567", "x:12.345.67", "x:12 345 67", "x:12_345_67", "x:123.45.678", "x:12.500", "x:1 234 567",
      "x:2026-10-1234567", "x:(050)1234567"]) ok(!validKey(k), "validKey rejects " + k);
    for (const k of ["wf:Web deploy (build)", "seo-auto:blocked:a1b2c3d", "catalog:" + h12("x"), "mag:fail:2026-10", "guard:core:1a2b3c4d", "smoke:home+lookup",
      "infra:quota-cf+site", "checker:data-health", "mag:pub:2026-10-18-new-cars", "infra-branches:2026-10", "x:v1.2.3"]) ok(validKey(k), "validKey accepts " + k);
    for (const f of FAMILIES_IN_USE) ok(family(f) !== null, "label for family " + f);
    for (const [f, ids] of [["smoke", "home lookup magazine applinks privacy model sitemap cert domain certcheck"], ["expiry", "cert domain certcheck"],
      ["infra", "site api sitemap quota-cf quota-brevo"], ["vitals", "crash anr"]]) {   // every id a call site can put in the key (spec 10.1) has Hebrew
      const he = label(f + ":" + ids.split(" ").join("+")).he.split(/[\s,:]+/);
      ok(!ids.split(" ").some(i => he.includes(i)), `label ${f}: no raw id left`);
    }
    ok(label("smoke:home+lookup").he === "בדיקת האתר החי מצאה בעיה: דף הבית, בדיקת רכב" && label("wf:Data guard").he === 'התהליך "Data guard" נכשל'
      && label("seo:daily").sect === "none" && label("nope:x").he === "התראה: nope:x" && label("mag:fail:2026-10").sect === "wait", "label rendering");
    const used = scanKeys(ROOT), missing = used.filter(k => !FAMILIES_IN_USE.some(f => f === k || f.startsWith(k + ":") || k.startsWith(f + ":")));
    ok(missing.length === 0, "call-site keys missing from FAMILIES_IN_USE: " + missing.join(", "));
    out.length = 0;

    // CLI: marker contract, wf lookup, --repeat, shadow record budget
    const runCli = async (argv, o = {}) => {
      const m = o.m || net({ state: o.state ?? base(), get: o.get, put: o.put, tg: o.tg });
      IO.fetch = m.fetch; IO.env = { ...ENV, ...(o.env || {}) }; IO.now = () => o.now ?? DAY; out = [];
      const code = await cli(argv, () => o.stdin ?? "");
      return { code, out: out.slice(), last: out.at(-1), m };
    };
    let c = await runCli(["send", "day", "guard:break:a1b2c3d4", "--today", "loud", "--text", "x", "--link", "https://github.com/o/r/actions/runs/1"]);
    ok(c.code === 0 && c.last === "ALERT_DONE loud 1" && c.out.length === 2 && c.out[0] === "alert guard:break:a1b2c3d4 day -> loud", "cli send: DONE last " + c.out);
    c = await runCli(["send", "day", "guard:break:a1b2c3d4", "--today", "loud", "--text", "x"], { put: ["hang-hard"] });
    ok(c.code === 0 && c.out.includes("ALERT_DONE loud 1") && c.last === "ALERT_DONE loud 1", "cli: DONE printed before the state write");
    c = await runCli(["send", "day", "guard:break:a1b2c3d4", "--today", "loud", "--text", "x"], { tg: [{ status: 500 }, { status: 500 }] });
    ok(c.code === 0 && c.last === "ALERT_LEGACY" && c.m.state().log.at(-1).a === "failed", "cli: Telegram failed -> ALERT_LEGACY");
    c = await runCli(["send", "summary", "catalog:" + h12("x"), "--today", "loud", "--plain", "--text", "x"]);
    ok(c.code === 0 && c.last === "ALERT_DONE queued 1", "cli: queued");
    c = await runCli(["send", "day", "plate:12-345-67", "--today", "loud", "--text", "x"]);
    ok(c.code === 0 && c.last === "ALERT_LEGACY", "cli: invalid key -> ALERT_LEGACY");
    for (const argv of [["send", "day"], ["send", "bogus", "k:x", "--today", "loud", "--text", "x"], ["send", "day", "k:x", "--today", "maybe", "--text", "x"],
      ["send", "day", "k:x", "--today", "loud"], ["send", "day", "k:x", "--today", "loud", "--text", "x", "--file", "f"], ["frob"], ["wf"], ["send", "day", "k:x", "--bogus"],
      ["--stdin"]]) {
      c = await runCli(argv);
      ok(c.code === 2 && !c.out.some(l => l.startsWith("ALERT_")), "cli usage error exit 2, no marker: " + argv.join(" "));
    }
    c = await runCli(["--stdin"], { stdin: JSON.stringify({ level: "day", key: "webwatch:rollback", text: "x", link: "", today: "loud", plain: true, fresh: false }) });
    ok(c.last === "ALERT_DONE loud 1" && c.m.tg[0].parse_mode === undefined, "cli --stdin, plain");
    c = await runCli(["wf", "Ownership data mirror", "--today", "loud", "--text", "x", "--link", "https://github.com/o/r/actions/runs/1"]);
    ok(c.out[0] === "alert wf:Ownership data mirror silent -> logged", "wf: Ownership data mirror -> silent " + c.out[0]);
    c = await runCli(["wf", "Ministry watch", "--today", "loud", "--text", "x"]);
    ok(c.out[0] === "alert wf:Ministry watch day -> loud", "wf: Ministry watch -> day " + c.out[0]);
    c = await runCli(["wf", "Web deploy (build)", "--today", "loud", "--text", "x"]);
    ok(c.out[0] === "alert wf:Web deploy (build) critical -> loud", "wf: Web deploy -> critical");
    c = await runCli(["wf", "Something New", "--today", "loud", "--text", "x"]);
    ok(c.out[0] === "alert wf:Something New day -> loud" && c.last === "ALERT_DONE loud 1", "wf: unknown name -> day");
    {
      const m = net({ state: base() });
      await runCli(["wf", "Data guard", "--today", "loud", "--text", "x"], { m });
      c = await runCli(["wf", "Data guard", "--today", "silent", "--text", "x", "--repeat"], { m, now: DAY + H });
      ok(c.last === "ALERT_DONE deduped 1" && m.tg.length === 1, "wf --repeat inside 22.5 h -> deduped");
      c = await runCli(["wf", "Data guard", "--today", "silent", "--text", "x", "--repeat"], { m, now: DAY + 23 * H });
      ok(c.last === "ALERT_DONE remind 1" && m.tg.length === 2 && m.tg[1].text.startsWith("🔁"), "wf --repeat after 22.5 h -> reminder");
      c = await runCli(["wf", "Data guard", "--today", "loud", "--text", "x"], { m, now: DAY + 24 * H });
      ok(c.last === "ALERT_DONE loud 1" && m.tg.length === 3, "wf without --repeat -> a fresh episode, loud");
    }
    {
      const t1 = Date.now();
      c = await runCli(["send", "day", "guard:break:a1b2c3d4", "--today", "loud", "--text", "x"], { env: { ALERT_ROUTE: "" }, get: [{ wait: 7000 }], put: [{ wait: 7000 }] });
      const el = Date.now() - t1;
      ok(c.last === "ALERT_LEGACY" && c.m.gets === 1 && c.m.puts === 1 && el < ms(13000) && el >= ms(9500), `cli shadow record: one GET, one PUT, 10 s budget (${el} ms scaled)`);
      c = await runCli(["send", "day", "guard:break:a1b2c3d4", "--today", "loud", "--text", "x"], { env: { ALERT_ROUTE: "" } });
      ok(c.out[0] === "alert guard:break:a1b2c3d4 day -> shadow:loud" && c.last === "ALERT_LEGACY" && c.m.state().log.at(-1).sh === 1 && c.m.tg.length === 0, "cli shadow: records, then ALERT_LEGACY");
      // the shell's own send may have failed, so the shadow record must not make the first routed occurrence a dedupe
      ok(c.m.state().items["guard:break:a1b2c3d4"].sent === null, "cli shadow leaves sent unset");
      c = await runCli(["send", "day", "guard:break:a1b2c3d4", "--today", "loud", "--text", "x"], { m: c.m, now: DAY + H });
      ok(c.last === "ALERT_DONE loud 1" && c.m.tg.length === 1, "cli: routed after a cli shadow is sent, not deduped " + c.last);
    }
    {   // the real process: marker is the last line and exit 0 without a token; usage error exit 2
      const env = { PATH: process.env.PATH, HOME: process.env.HOME || "/tmp" };
      const p1 = cp.spawnSync(process.execPath, [SELF, "send", "day", "guard:break:a1b2c3d4", "--today", "loud", "--text", "x"], { env, encoding: "utf8", timeout: 20000 });
      ok(p1.status === 0 && p1.stdout.trim().split("\n").at(-1) === "ALERT_LEGACY", "process: no token -> ALERT_LEGACY, exit 0");
      const p2 = cp.spawnSync(process.execPath, [SELF, "send"], { env, encoding: "utf8", timeout: 20000 });
      ok(p2.status === 2 && !p2.stdout.includes("ALERT_"), "process: usage error exit 2");
      const p3 = cp.spawnSync(process.execPath, [SELF, "--stdin"], { env, input: JSON.stringify({ level: "critical", key: "x:y", text: "x", today: "loud" }), encoding: "utf8", timeout: 20000 });
      ok(p3.status === 0 && p3.stdout.trim().split("\n").at(-1) === "ALERT_LEGACY", "process: --stdin");
    }

    // daily and mark-summary
    {
      const st = base(); st.hb = { daily: "2026-10-19", dailyAt: iso(DAY - 24 * H) };
      st.items["mag:fail:2026-10"] = { lv: "day", first: iso(DAY - 8 * H), last: iso(DAY - 8 * H), n: 1, sent: iso(DAY - 8 * H), pend: iso(DAY - 8 * H), open: true, u: [] };
      st.items["old:x"] = { lv: "day", first: iso(DAY - 30 * 864e5), last: iso(DAY - 22 * 864e5), n: 1, sent: null, pend: null, open: false, u: [] };
      const m = net({ state: st });
      let d = await runCli(["daily"], { m, env: { GITHUB_EVENT_NAME: "schedule" }, now: Date.parse("2026-10-20T05:20:00Z") });
      const s1 = m.state();
      ok(d.code === 0 && m.tg.length === 1 && m.tg[0].disable_notification === false && m.tg[0].text.includes("כתבת מגזין לא פורסמה, הבדיקות נכשלו: 2026-10 (04:00)"), "daily: one loud morning ring " + d.out);
      ok(s1.items["mag:fail:2026-10"].pend === null && s1.log.some(e => e.a === "ring") && !s1.items["old:x"] && s1.hb.daily === "2026-10-20" && s1.hb.tgOkAt, "daily: pend cleared, pruned, claimed");
      ok(!!m.files["heartbeat.json"] && J(m.files["heartbeat.json"].text).t, "daily: heartbeat written");
      d = await runCli(["daily"], { m, env: { GITHUB_EVENT_NAME: "schedule" }, now: Date.parse("2026-10-20T06:20:00Z") });
      ok(d.code === 0 && m.tg.length === 1 && d.last === "daily: already done today", "daily: second run the same day does nothing");
      d = await runCli(["daily"], { m, env: { GITHUB_EVENT_NAME: "schedule" }, now: Date.parse("2026-10-21T04:20:00Z") });
      ok(d.code === 0 && /outside/.test(d.last), "daily: early scheduled line skips");
      const m2 = net({ state: { ...base(), hb: { summaryAt: iso(Date.parse("2026-10-11T05:30:00Z")), uptimeSeenAt: iso(DAY - 24 * H) } }, tgSelf: 401 });
      d = await runCli(["daily"], { m: m2, env: { BREVO_API_KEY: "b", ALERT_UPTIME_URL: "https://luchit-uptime.test/" }, now: Date.parse("2026-10-19T06:30:00Z") });
      ok(d.code === 1 && m2.mails.some(x => x.subject.includes("טלגרם")) && d.out.includes("email path: on"), "daily: Telegram self-test failure -> email + red");
      ok(d.out.includes("alert meta:uptime day -> loud") && d.out.includes("alert weekly:missing day -> loud"), "daily: uptime stale and Monday checks " + d.out);
      ok(m2.state().hb.tgFailAt && !m2.state().hb.tgOkAt, "daily: tgFailAt");
      const m3 = net({ state: st });
      d = await runCli(["daily"], { m: m3, env: { DRY: "1" }, now: Date.parse("2026-10-20T05:20:00Z") });
      ok(d.out.includes("would ring 1") && m3.puts === 0 && m3.tg.length === 0 && m3.mails.length === 0, "daily: dry run sends and writes nothing");
      d = await runCli(["mark-summary"], { m: m3 });
      ok(d.code === 0 && m3.state().hb.summaryAt === iso(DAY), "mark-summary");
    }
  } finally { Object.assign(IO, keep); }
  process.stdout.write(bad ? `selftest: ${bad} of ${n} checks FAILED\n` : `selftest ok (${n} checks)\n`);
  return bad ? 1 : 0;
}
// whitelist schema of state.json ("" when it matches)
function schema(s) {
  const isoRe = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, isoN = v => v === null || (typeof v === "string" && isoRe.test(v));
  if (!s || JSON.stringify(Object.keys(s).sort()) !== '["hb","items","log","v"]' || s.v !== 1) return "top level";
  const IT = { lv: v => LEVELS.includes(v), src: v => typeof v === "string" && v.length <= 80, u: v => Array.isArray(v) && v.length <= 3 && cleanLinks(v).length === v.length,
    first: isoN, last: isoN, n: v => Number.isInteger(v) && v > 0, sent: isoN, pend: isoN, open: v => typeof v === "boolean" };
  for (const [k, it] of Object.entries(s.items)) {
    if (!validKey(k)) return "item key";
    for (const [f, v] of Object.entries(it)) if (!IT[f] || !IT[f](v)) return "item field " + f;
  }
  const HB = { daily: v => /^\d{4}-\d\d-\d\d$/.test(v), dailyAt: isoN, summaryAt: isoN, tgOkAt: isoN, tgFailAt: isoN, uptimeSeenAt: isoN };
  for (const [f, v] of Object.entries(s.hb)) if (!HB[f] || !HB[f](v)) return "hb field " + f;
  const LG = { t: isoN, k: validKey, lv: v => LEVELS.includes(v), a: v => ACTIONS.includes(v), td: v => TODAY.includes(v), sh: v => v === 0 || v === 1 };
  for (const e of s.log) { if (Object.keys(e).length !== 6) return "log entry"; for (const [f, v] of Object.entries(e)) if (!LG[f] || !LG[f](v)) return "log field " + f; }
  return "";
}
// alert keys used at the converted call sites (files that load the router), as static stems
function scanKeys(root) {
  const found = new Set(), K = "([a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*)";
  const RES = [new RegExp(`alert\\.mjs\\s+send\\s+\\S+\\s+["']?${K}`, "g"), new RegExp(`\\blevel:\\s*[^,}]+,\\s*key:\\s*["'\`]${K}`, "g"),
    new RegExp(`router\\??\\.alert\\(\\s*[^,]+,\\s*["'\`]${K}`, "g"), new RegExp(`router\\??\\.resolve\\(\\s*\\[?\\s*["'\`]${K}`, "g"),
    new RegExp(`\\btg\\s+".*"\\s+(?:true|false)\\s+\\w+\\s+"${K}`, "g")];
  for (const dir of [".github/workflows", ".github/scripts", "analytics"]) {
    let names = [];
    try { names = fs.readdirSync(`${root}/${dir}`); } catch { continue; }
    for (const f of names) {
      if (!/\.(m?js|cjs|py|ya?ml|sh)$/.test(f) || /^(alert\.mjs|alert\.py|waiting\.mjs|alert-fallback\.test\.sh|alert-check\.yml)$/.test(f)) continue;
      const src = fs.readFileSync(`${root}/${dir}/${f}`, "utf8");
      if (!/alert\.mjs|import alert as router/.test(src)) continue;
      if (/alert\.mjs\s+wf\b/.test(src)) found.add("wf");
      for (const re of RES) for (const m of src.matchAll(re)) found.add(m[1].replace(/:$/, ""));
    }
  }
  return [...found];
}

if (process.argv[1] && process.argv[1].endsWith("alert.mjs")) process.exit(await cli(process.argv.slice(2)));
