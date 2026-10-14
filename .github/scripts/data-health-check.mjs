// Daily health check of the data.gov.il datasets the app reads: availability, latency, schema drift, freshness.
// Sends a Telegram alert on any failure (needs TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID). DRY_RUN=1 prints instead of sending.
const API = "https://data.gov.il/api/3/action/";
const SLOW_MS = 5000, TIMEOUT_MS = 20000, SAMPLE_PLATE = "38548003";
const DRY = process.env.DRY_RUN === "1";

// maxAge = days since last_modified before we call the data stale (per-car sets update daily-ish, per-model sets rarely)
// filter = a known-good lookup (also proves the filter column still works); expectEmpty = known ministry outage, reported as a note, not an alert
const SETS = [
  { key: "active", title: "רכב פרטי ומסחרי (vehicle_info)", id: "053cea08-09bc-40ec-8f7a-156f0677aff3", maxAge: 7,
    filters: { mispar_rechev: SAMPLE_PLATE }, fields: ["mispar_rechev", "tozeret_nm", "shnat_yitzur", "kinuy_mishari", "sug_delek_nm", "tokef_dt"] },
  { key: "tech", title: "היסטוריית מפרט ורישוי", id: "56063a99-8a3e-4ff4-912e-5966c0279bad", maxAge: 7,
    filters: { mispar_rechev: SAMPLE_PLATE }, fields: ["mispar_rechev"] },
  { key: "recalls", title: "ריקולים לפי רכב", id: "36bf1404-0be4-49d2-82dc-2f1ead4a8b93", maxAge: 7,
    filters: null, fields: ["MISPAR_RECHEV"] },
  { key: "modelRecalls", title: "ריקולים לפי דגם", id: "2c33523f-87aa-44ec-a736-edbb0a82975e", maxAge: 45,
    filters: null, fields: ["TOZAR_CD"] },
  { key: "wltp", title: "מפרט טכני (WLTP)", id: "142afde2-6228-49f9-8a29-9b6c3a0cbe40", maxAge: 45,
    filters: null, fields: ["tozeret_cd", "degem_cd", "shnat_yitzur", "kosher_grira_im_blamim"] },
  { key: "owners", title: "היסטוריית בעלויות", id: "bb2355dc-9ec7-4f06-9c3f-3344672171da", maxAge: 7,
    filters: { mispar_rechev: SAMPLE_PLATE }, fields: ["mispar_rechev", "baalut_dt", "baalut"], expectEmpty: "מושבתת ידועה בצד משרד התחבורה, האפליקציה משתמשת בגיבוי own-data" },
];

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
    if (total === 0) (s.expectEmpty ? notes : problems).push(s.expectEmpty ? "ריק (" + s.expectEmpty + ")" : (s.filters ? `אין תוצאה לרכב הבדיקה ${SAMPLE_PLATE}` : "המאגר ריק"));
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
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (DRY || !token || !chat) { console.log("--- Telegram (" + (DRY ? "dry run" : "no credentials") + ") ---\n" + text); return; }
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }) });
  if (!r.ok) console.log("telegram failed", r.status);
}

let results;
try { results = []; for (const s of SETS) results.push(await check(s)); }
catch (e) { await telegram(`⚠️ <b>בדיקת בריאות הנתונים קרסה</b>\n${esc(e.message)}`); process.exit(1); }

for (const r of results) console.log(`${r.problems.length ? "FAIL" : "ok  "} ${r.key.padEnd(13)} ${String(r.ms).padStart(5)}ms ${[...r.problems, ...r.notes].join(" | ")}`);
const bad = results.filter(r => r.problems.length);
if (bad.length) {
  const lines = bad.map(r => `❌ <b>${esc(r.title)}</b> (<code>${r.id.slice(0, 8)}</code>)\n${r.problems.map(p => "• " + esc(p)).join("\n")}`);
  await telegram(`⚠️ <b>לוחית: בעיה במאגרי משרד התחבורה</b>\n${bad.length} מתוך ${results.length} מאגרים\n\n${lines.join("\n\n")}\n\nהבדיקה: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`);
  process.exit(1);
}
console.log("all datasets healthy");
