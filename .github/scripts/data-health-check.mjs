// Daily health check of the data.gov.il datasets the app reads: availability, latency, freshness (a removed column is noted; Data guard reports it).
// Sends a Telegram alert on any failure (needs TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID). DRY_RUN=1 prints instead of sending.
// Part of Ministry watch: what it reads that the app's status.json also needs (unfiltered row counts, last-update stamps) is handed to status.mjs
// as the step output "seen", so each dataset is asked once a day (see status.mjs for the format).
import { appendFileSync } from "node:fs";
import { ilTime } from "./notify.mjs";
import { flash } from "./flash.mjs";
import { SETS, SAMPLE_PLATE } from "./datasets.mjs";
import { msg, heError } from "./tg-text.mjs";
const API = "https://data.gov.il/api/3/action/";
const SLOW_MS = 5000, TIMEOUT_MS = 20000;
const DRY = process.env.DRY_RUN === "1";



const sleep = ms => new Promise(r => setTimeout(r, ms));
// for status.mjs: per dataset key, the unfiltered datastore_search reads made (tries; ok/total from the first that found rows, else the last)
// and the resource_show answer (modified, absent when that read failed). Filtered lookups are not counts of the dataset, so they are not recorded.
const seen = {};
const sawCount = (s, ok, total) => { const p = seen[s.key] ||= { id: s.id, tries: 0 }; if (p.ok) return; p.tries++; p.ok = ok; if (total !== undefined) p.total = total; };
const sawModified = (s, lm) => { (seen[s.key] ||= { id: s.id, tries: 0 }).modified = lm || null; };
function emitSeen() {
  const f = process.env.GITHUB_OUTPUT;
  try { if (f) appendFileSync(f, "seen=" + JSON.stringify(seen) + "\n"); } catch (e) { console.log("could not hand the readings to status.mjs:", e.message); }
}
async function call(action, params) {
  const t0 = Date.now(), url = API + action + "?" + new URLSearchParams(params);
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": "luchit-data-health/1.0" } });
  const ms = Date.now() - t0;
  if (!res.ok) throw Object.assign(new Error("HTTP " + res.status), { ms });
  let j; try { j = await res.json(); } catch { throw Object.assign(new Error("התשובה אינה JSON"), { ms }); }
  if (!j.success) throw Object.assign(new Error("success=false " + JSON.stringify(j.error || "").slice(0, 120)), { ms });
  return { j, ms };
}
// one retry so a single network blip does not page anyone
async function withRetry(fn) { try { return await fn(); } catch (e) { await sleep(3000); return fn(); } }

// the Hebrew sentence of a raw error (tg-text.mjs heError) without its folded block: the raw texts are folded once, at the end of the message
const heOnly = raw => heError(raw).split("\n<blockquote")[0];
const raws = [];
async function check(s) {
  const problems = [], notes = [];
  let ms = 0;
  try {
    const params = { resource_id: s.id, limit: "1" };
    if (s.filters) params.filters = JSON.stringify(s.filters);
    let j, m;
    try { ({ j, ms: m } = await withRetry(() => call("datastore_search", params))); } catch (e) { if (!s.filters) sawCount(s, false); throw e; }
    ms = m;
    const r = j.result, total = r.total ?? 0, rec = (r.records || [])[0];
    if (!s.filters) sawCount(s, total > 0, total);
    const have = new Set((r.fields || []).map(f => f.id));
    if (ms > SLOW_MS) problems.push(`תגובה איטית: ${(ms / 1000).toFixed(1)} שניות (סף ${SLOW_MS / 1000})`);
    // a removed column is Data guard's to report (once, with the build gate; it covers every field listed here): only noted here, so
    // one schema change is not told twice the same morning and again every day after
    const missing = s.fields.filter(f => !have.has(f));
    if (missing.length) notes.push(`שדות חסרים (Data guard מדווח): ${missing.join(", ")}`);
    if (total === 0) (s.expectEmpty ? notes : problems).push(s.expectEmpty ? "ריק (" + s.expectEmpty + ")" : (s.filters ? `המאגר לא החזיר תוצאה לרכב בדיקה שידוע שהוא רשום בו (${SAMPLE_PLATE})` : "המאגר ריק"));
    else if (rec && s.fields.every(f => have.has(f))) {
      const empty = s.fields.filter(f => rec[f] === null || rec[f] === undefined || rec[f] === "").filter(f => f !== "tokef_dt" && f !== "kosher_grira_im_blamim");
      if (empty.length && s.filters) problems.push(`שדות מפתח ריקים ברשומת הבדיקה: ${empty.join(", ")}`);
    }
  } catch (e) { problems.push(e.name === "TimeoutError" ? "המאגר לא ענה תוך " + TIMEOUT_MS / 1000 + " שניות" : heOnly(e.message)); raws.push(`${s.key}: ${e.message}`); ms = e.ms ?? ms; }
  // freshness
  try {
    const { j } = await withRetry(() => call("resource_show", { id: s.id }));
    const lm = j.result.last_modified || j.result.metadata_modified;
    sawModified(s, lm);
    if (!lm) problems.push("אין חותמת זמן עדכון");
    else {
      const age = (Date.now() - new Date(lm.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(lm) ? lm : lm + "Z").getTime()) / 864e5;
      if (age > s.maxAge && !s.expectEmpty) problems.push(`נתונים ישנים: עודכן לפני ${Math.floor(age)} ימים (סף ${s.maxAge}), ${lm.slice(0, 10)}`);
      notes.push(`עודכן ${lm.slice(0, 10)}`);
    }
  } catch (e) { if (!s.expectEmpty) { problems.push("לא הצלחנו לקרוא מתי המאגר עודכן: " + heOnly(e.message)); raws.push(`${s.key} resource_show: ${e.message}`); } }
  return { ...s, ms, problems, notes };
}

const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
async function telegram(text) {
  await flash("data", "alert", text);
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (DRY || !token || !chat) { console.log("--- Telegram (" + (DRY ? "dry run" : "no credentials") + ") ---\n" + text); return DRY; }
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }) });
  if (!r.ok) console.log("telegram failed", r.status);
  return r.ok;
}

const failText = (bad, total) => {
  const lines = bad.map(r => `❌ <b>${esc(r.title)}</b>\n${r.problems.map(p => "• " + esc(p)).join("\n")}${r.impact ? "\nמה זה אומר למשתמשים: " + esc(r.impact) + "." : ""}`);
  return msg({ kind: "today", area: "data", title: "מאגר של משרד התחבורה לא תקין",
    text: `${bad.length} מתוך ${total} מאגרים נכשלו בבדיקה, גם אחרי 3 ניסיונות בהפרש של כשתי דקות. זו תקלה אצל משרד התחבורה, והמאגרים חוזרים לעבוד בעצמם, בדרך כלל תוך כמה שעות.\n\n${lines.join("\n\n")}\n\nזמן: ${ilTime()} (שעון ישראל)`,
    what: "בדרך כלל כלום. אם ההתראה חוזרת גם מחר, לכתוב לי בשרשור \"נתונים ואמינות\".", raw: raws.slice(-6).join("; ") });
};
// PREVIEW=1 sends a clearly labelled sample of the alert, to check the wording on the phone
if (process.env.PREVIEW === "1") {
  const fake = [{ ...SETS[0], problems: ["המאגר לא החזיר תוצאה לרכב בדיקה שידוע שהוא רשום בו (דוגמה)"], notes: [] }];
  await telegram("🧪 <b>הודעת בדיקה, אין תקלה אמיתית</b>\n\n" + failText(fake, SETS.length));
  process.exit(0);
}
// a ministry dataset sometimes answers "nothing" for a few minutes and then recovers by itself: look again before waking anyone up
let results, bad = [], crash = null;
try {
  for (let attempt = 1; attempt <= 3; attempt++) {
    results = []; for (const s of SETS) results.push(await check(s));
    bad = results.filter(r => r.problems.length);
    if (!bad.length) break;
    if (attempt < 3) { console.log(`attempt ${attempt} found ${bad.length} problem(s), checking again in 2 minutes`); await sleep(120000); }
  }
} catch (e) { crash = e; }
emitSeen();   // before any alert or exit, so the status snapshot gets what was read even when this check fails
if (crash) { const e = crash; await telegram(msg({ kind: "today", area: "data", title: "הבדיקה היומית של מאגרי משרד התחבורה קרסה",
  text: `${heOnly(e.message)} לכן הבוקר לא ברור אם המאגרים תקינים. זו תקלה בבדיקה עצמה, לא באפליקציה.\nזמן: ${ilTime()} (שעון ישראל)`,
  what: "בדרך כלל כלום. אם זה חוזר מחר, לכתוב לי בשרשור \"נתונים ואמינות\".", raw: e.stack || e.message })); process.exit(1); }

for (const r of results) console.log(`${r.problems.length ? "FAIL" : "ok  "} ${r.key.padEnd(13)} ${String(r.ms).padStart(5)}ms ${[...r.problems, ...r.notes].join(" | ")}`);
if (bad.length) {
  // the alert reached Telegram: finish green, so GitHub does not also send its own "workflow failed" mail; a failed send keeps the red run as a fallback
  process.exit((await telegram(failText(bad, results.length))) ? 0 : 1);
}
console.log("all datasets healthy");
