// Daily health check of the data.gov.il datasets the app reads: availability, latency, schema drift, freshness.
// Sends a Telegram alert on any failure (needs TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID). DRY_RUN=1 prints instead of sending.
import { ilTime } from "./notify.mjs";
import { flash } from "./flash.mjs";
import { SETS, SAMPLE_PLATE } from "./datasets.mjs";
const API = "https://data.gov.il/api/3/action/";
const SLOW_MS = 5000, TIMEOUT_MS = 20000;
const DRY = process.env.DRY_RUN === "1";



const sleep = ms => new Promise(r => setTimeout(r, ms));
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

async function check(s) {
  const problems = [], notes = [];
  let ms = 0;
  try {
    const params = { resource_id: s.id, limit: "1" };
    if (s.filters) params.filters = JSON.stringify(s.filters);
    const { j, ms: m } = await withRetry(() => call("datastore_search", params)); ms = m;
    const r = j.result, total = r.total ?? 0, rec = (r.records || [])[0];
    const have = new Set((r.fields || []).map(f => f.id));
    if (ms > SLOW_MS) problems.push(`תגובה איטית: ${(ms / 1000).toFixed(1)} שניות (סף ${SLOW_MS / 1000})`);
    const missing = s.fields.filter(f => !have.has(f));
    if (missing.length) problems.push(`שינוי סכמה, שדות חסרים: ${missing.join(", ")}`);
    if (total === 0) (s.expectEmpty ? notes : problems).push(s.expectEmpty ? "ריק (" + s.expectEmpty + ")" : (s.filters ? `המאגר לא החזיר תוצאה לרכב בדיקה שידוע שהוא רשום בו (${SAMPLE_PLATE})` : "המאגר ריק"));
    else if (rec && s.fields.every(f => have.has(f))) {
      const empty = s.fields.filter(f => rec[f] === null || rec[f] === undefined || rec[f] === "").filter(f => f !== "tokef_dt" && f !== "kosher_grira_im_blamim");
      if (empty.length && s.filters) problems.push(`שדות מפתח ריקים ברשומת הבדיקה: ${empty.join(", ")}`);
    }
  } catch (e) { problems.push(`${e.name === "TimeoutError" ? "פג הזמן (" + TIMEOUT_MS / 1000 + " שניות)" : e.message}`); ms = e.ms ?? ms; }
  // freshness
  try {
    const { j } = await withRetry(() => call("resource_show", { id: s.id }));
    const lm = j.result.last_modified || j.result.metadata_modified;
    if (!lm) problems.push("אין חותמת זמן עדכון");
    else {
      const age = (Date.now() - new Date(lm.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(lm) ? lm : lm + "Z").getTime()) / 864e5;
      if (age > s.maxAge && !s.expectEmpty) problems.push(`נתונים ישנים: עודכן לפני ${Math.floor(age)} ימים (סף ${s.maxAge}), ${lm.slice(0, 10)}`);
      notes.push(`עודכן ${lm.slice(0, 10)}`);
    }
  } catch (e) { if (!s.expectEmpty) problems.push("לא ניתן לקרוא חותמת עדכון: " + e.message); }
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
  const lines = bad.map(r => `❌ <b>${esc(r.title)}</b>\n${r.problems.map(p => "• " + esc(p)).join("\n")}${r.impact ? "\nהשפעה על המשתמשים: " + esc(r.impact) + "." : ""}`);
  return `⚠️ <b>לוחית: מאגר של משרד התחבורה לא תקין</b>\n${bad.length} מתוך ${total} מאגרים נכשלו בבדיקה, גם אחרי 3 ניסיונות בהפרש של כשתי דקות.\n\n${lines.join("\n\n")}\n\nמה לעשות: בדרך כלל כלום. המאגרים נמצאים אצל משרד התחבורה וחוזרים לעבוד בעצמם, בדרך כלל תוך שעות. אם ההתראה חוזרת גם מחר, כתבו לי ואבדוק.\n\nזמן: ${ilTime()} (שעון ישראל)`;
};
// PREVIEW=1 sends a clearly labelled sample of the alert, to check the wording on the phone
if (process.env.PREVIEW === "1") {
  const fake = [{ ...SETS[0], problems: ["המאגר לא החזיר תוצאה לרכב בדיקה שידוע שהוא רשום בו (דוגמה)"], notes: [] }];
  await telegram("🧪 <b>הודעת בדיקה, אין תקלה אמיתית</b>\n\n" + failText(fake, SETS.length));
  process.exit(0);
}
// a ministry dataset sometimes answers "nothing" for a few minutes and then recovers by itself: look again before waking anyone up
let results, bad = [];
try {
  for (let attempt = 1; attempt <= 3; attempt++) {
    results = []; for (const s of SETS) results.push(await check(s));
    bad = results.filter(r => r.problems.length);
    if (!bad.length) break;
    if (attempt < 3) { console.log(`attempt ${attempt} found ${bad.length} problem(s), checking again in 2 minutes`); await sleep(120000); }
  }
} catch (e) { await telegram(`⚠️ <b>בדיקת בריאות הנתונים קרסה</b>\nהבדיקה היומית של מאגרי משרד התחבורה לא הצליחה לרוץ, ולכן לא ברור אם המאגרים תקינים. זו תקלה בבדיקה עצמה ולא בהכרח באפליקציה.\nפירוט: ${esc(e.message)}\n\nמה לעשות: בדרך כלל כלום. אם זה חוזר מחר, כתבו לי.\n\nזמן: ${ilTime()} (שעון ישראל)`); process.exit(1); }

for (const r of results) console.log(`${r.problems.length ? "FAIL" : "ok  "} ${r.key.padEnd(13)} ${String(r.ms).padStart(5)}ms ${[...r.problems, ...r.notes].join(" | ")}`);
if (bad.length) {
  // the alert reached Telegram: finish green, so GitHub does not also send its own "workflow failed" mail; a failed send keeps the red run as a fallback
  process.exit((await telegram(failText(bad, results.length))) ? 0 : 1);
}
console.log("all datasets healthy");
