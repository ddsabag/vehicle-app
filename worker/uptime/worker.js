// luchit-uptime: Cloudflare Worker that checks luchit.app every 10 minutes (cron */10) and pages Dudu when it is down.
//   probes: home = GET https://luchit.app/?u=<ms> must answer 200 with the bytes id="plate" in the first 256 KB;
//           api  = GET https://luchit.app/api/confirm?e=x&x=1&t=x must answer 302 to ...subscribed=expired (luchit-api rejects the
//                  address before signing: no mail, no Brevo or GA call, no write; the same check as infra-watch.mjs)
//   2 failed ticks in a row (each with one retry) = one critical alert: Telegram loud + email in parallel; one reminder per 22.5 h by day;
//   a silent line on recovery (retried on later OK ticks until it is out). A probe pages only after its first success (armed).
//   Other duties: the morning ring for luchit-mail's night pointers (KV "p:<ms>", listed on every daytime tick), a daily Telegram
//   getChat, a watch on the GitHub heartbeat (alert-state/heartbeat.json) 4 times a day, and the backup clock (CLOCK below, once an hour):
//   GitHub started scheduled runs hours late or not at all from 1.11.2026, so the bots that matter most are started from here when late.
//   GET /health = public status without keys, numbers or mail data.
// Observe mode (default): the dashboard variable ALERT_ROUTE does not list "critical", so a would-be page is a SILENT "🧪 (מצב ניסיון)"
// message with no email. ALERT_ROUTE=critical turns paging on; deleting the variable turns it off again.
// Bindings: KV ALERTS (luchit-alerts, required; without it the Worker only logs). Optional: Send Email MAIL. Secrets: TELEGRAM_BOT_TOKEN,
// TELEGRAM_CHAT_ID (without them it records and sends nothing), optional BREVO_KEY, optional GH_DISPATCH_TOKEN (the backup clock; without
// it the clock is off; dashboard variable CLOCK=off stops it too). KV "u" is written once per tick (144/day).
// The block between the alert-lib v1 markers is a byte-identical copy of worker/lib/alert-lib.js (CI compares them).
const SITE = "https://luchit.app", UA = "luchit-uptime/1", REPO = "ddsabag/vehicle-app";
const HEARTBEAT = `https://raw.githubusercontent.com/${REPO}/alert-state/heartbeat.json`;
// which version answered (binding CF_VERSION_METADATA in wrangler.toml): the Workers deploy check waits for the new one
const version = env => (env.CF_VERSION_METADATA?.id ? { "x-luchit-version": env.CF_VERSION_METADATA.id } : {});
const MARK = new TextEncoder().encode('id="plate"'), MARK_MAX = 256 * 1024;
const UP = { probe: 10000, retry: 5000, hb: 5000, stale: 50 * 36e5, remind: 24 * 36e5 - 90 * 6e4, ghHours: [0, 6, 12, 18] };   // remind = alert.mjs REMIND_MS
const TRIAL = "🧪 (מצב ניסיון) ";
const WHY = { timeout: "האתר לא ענה בזמן", net: "תקלת רשת בדרך לאתר", marker: "הדף נטען אבל בלי תיבת המספר", redirect: "הפניה לא צפויה" };   // else "השרת החזיר קוד <status>"
const MAIL_CLS = { privacy: "פרטיות או מחיקה", crash: "תקלה באפליקציה" };
// the shared message shape of .github/scripts/tg-text.mjs (a Worker is one file, so the few lines it needs are copied): classification line, short text, what to do
const TAG = { down: "<b>🔴 דחוף · אתר</b>", back: "<b>✅ בוצע · אתר</b>", mail: "<b>🟠 לטיפול היום · מייל</b>", gh: "<b>🟠 לטיפול היום · בוטים</b>" };
const TODO = { down: '👉 מה לעשות: לפתוח את luchit.app בטלפון, ברשת סלולרית. אם גם שם הוא לא נפתח, לכתוב בשרשור "תפעול, בוטים ומייל". אם הוא נפתח, כנראה תקלה רגעית, וההודעה הבאה תגיד שהוא חזר.',
  mail: "👉 מה לעשות: לענות מהג'ימייל. הפרטים בהודעות השקטות מהלילה.", gh: '👉 מה לעשות: לבדוק ב-githubstatus.com אם יש תקלה אצל GitHub. אם אין, לכתוב בשרשור "תפעול, בוטים ומייל".' };

// >>> alert-lib v1
const QUIET = { tz: "Asia/Jerusalem", dayStart: 8, dayEnd: 22 };   // CI: must equal alert.mjs QUIET
const ALERT_MAIL = { name: "לוחית התראות", from: "alerts@luchit.app", brevoFrom: "updates@luchit.app", to: "luchit.app.service@gmail.com" };   // to = FORWARD_TO of luchit-mail
const ALERT_NIGHT = "\n\n🌙 נשלח בשקט כי עכשיו לילה. צלצול תזכורת יגיע בבוקר.";
const ALERT_MS = { call: 10000, deadline: 40000 };   // per binding call (send_email, KV, the cloudflare:email import) and per alert(); tests lower them
// a promise that has not settled after t ms counts as failed (bindings take no AbortSignal)
function within(p, t = ALERT_MS.call) {
  let h;
  return Promise.race([p, new Promise((_, no) => { h = setTimeout(() => no(new Error("timeout")), t); })]).finally(() => clearTimeout(h));
}
function isDaytime(d = new Date()) {
  const h = +new Intl.DateTimeFormat("en-GB", { timeZone: QUIET.tz, hour: "2-digit", hourCycle: "h23" }).format(d);
  return h >= QUIET.dayStart && h < QUIET.dayEnd;
}
function ilTime(d = new Date()) {   // "DD.MM HH:MM" in Israel time
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: QUIET.tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map(x => [x.type, x.value]));
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
}
function routed(env, level) {
  const r = String(env.ALERT_ROUTE || "").split(",").map(s => s.trim().toLowerCase());
  return r.includes("all") || r.includes(level);
}
const alertStrip = t => String(t).replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
// Telegram: 10 s per try, 2 tries 1 s apart (429 retry_after up to 10 s); a 400 on HTML entities is retried once as plain text
async function tgSend(env, text, { silent = false, html = true } = {}) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  let t = String(text);
  if (t.length > 4000) t = t.slice(0, 3993) + "…(קוצר)";
  for (let i = 0; i < 2; i++) {
    let wait = 1000;
    try {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: t, disable_web_page_preview: true, disable_notification: silent, ...(html ? { parse_mode: "HTML" } : {}) }) });
      if (r.ok) return true;
      const b = await r.text();
      if (r.status === 400 && html && /can't parse entities/i.test(b)) { html = false; t = alertStrip(t); i--; continue; }
      if (r.status === 429) { try { wait = Math.min(+JSON.parse(b).parameters.retry_after || 1, 10) * 1000; } catch {} }
      else if (r.status < 500) return false;
    } catch { /* timeout or network: retry */ }
    if (!i) await new Promise(res => setTimeout(res, wait));
  }
  return false;
}
// email to Dudu: 1) the send_email binding MAIL (raw MIME), 2) else or on failure BREVO_KEY, 3) else false
async function emailSend(env, subject, text) {
  const b64 = s => { const u = new TextEncoder().encode(s); let bin = ""; for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(bin); };
  const words = s => {   // RFC 2047, encoded words of at most 45 bytes, never splitting a character
    const out = []; let cur = "";
    for (const ch of s) { if (new TextEncoder().encode(cur + ch).length > 45) { out.push(cur); cur = ""; } cur += ch; }
    return [...out, cur].map(w => `=?UTF-8?B?${b64(w)}?=`).join("\r\n ");
  };
  const body = alertStrip(text);
  if (env.MAIL) try {
    const { EmailMessage } = await within(import("cloudflare:email"));
    const raw = [`From: ${words(ALERT_MAIL.name)} <${ALERT_MAIL.from}>`, `To: ${ALERT_MAIL.to}`, `Subject: ${words(subject)}`, `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@luchit.app>`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64", "", b64(body).replace(/.{76}/g, "$&\r\n")].join("\r\n");
    await within(env.MAIL.send(new EmailMessage(ALERT_MAIL.from, ALERT_MAIL.to, raw)));
    return true;
  } catch (e) { console.log("mail binding failed:", String(e).slice(0, 120)); }
  if (env.BREVO_KEY) try {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", signal: AbortSignal.timeout(10000),
      headers: { "api-key": env.BREVO_KEY, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { name: ALERT_MAIL.name, email: ALERT_MAIL.brevoFrom }, to: [{ email: ALERT_MAIL.to }], subject, textContent: body }) });
    return r.ok;
  } catch { /* fall through */ }
  return false;
}
// a night "day" item may wait for the morning ring only when KV ALERTS is bound, luchit-uptime ticked in the last 25 min and its last
// Telegram call worked (it sends the ring)
async function canDefer(env) {
  try { if (!env.ALERTS) return false; const u = await within(env.ALERTS.get("u", "json")); return !!u && u.tg === true && Date.now() - Date.parse(u.tick) <= 25 * 6e4; } catch { return false; }
}
// one alert; legacy = the caller's own unchanged send, run when the level is not routed, on any exception, past the deadline,
// and as a last try when nothing got through
async function alert(env, level, key, text, link = "", { legacy } = {}) {
  const leg = async () => (typeof legacy === "function" ? await legacy() : false);
  if (!routed(env, level)) return { delivered: await leg(), action: "legacy" };
  let ok = false, mailed = false, action = "failed";
  try {
    const done = await within((async () => {
      const subject = "🔴 לוחית: " + (alertStrip(text).split("\n").find(l => l.trim()) || key).slice(0, 80), body = text + (link ? "\n" + link : "");
      if (level === "silent") return { delivered: true, action: "logged" };
      if (level === "critical") { action = "loud"; [ok, mailed] = await Promise.all([tgSend(env, text), emailSend(env, subject, body)]); }
      else if (level === "summary") { action = "silent"; ok = await tgSend(env, text, { silent: true }); }
      else if (isDaytime()) { action = "loud"; ok = await tgSend(env, text); }
      else if (await canDefer(env)) {   // the pointer first (a failed put -> legacy, loud as today), then the silent message
        await within(env.ALERTS.put("p:" + Date.now(), JSON.stringify({ c: key, at: new Date().toISOString() }), { expirationTtl: 172800 }));
        action = "night"; ok = await tgSend(env, text + ALERT_NIGHT, { silent: true });
      } else { action = "loud"; ok = await tgSend(env, text); }
      if (ok) return { delivered: true, action };
      if (level === "day") mailed = await emailSend(env, subject, body);
      return null;
    })(), ALERT_MS.deadline);
    if (done) { console.log(`alert ${key} ${level} -> ${done.action}`); return done; }
  } catch (e) {
    console.log(`alert ${key} ${level} -> error:`, String(e).slice(0, 120));
    if (ok) return { delivered: true, action };
  }
  console.log(`alert ${key} ${level} -> legacy`);
  return { delivered: (await leg()) || mailed, action: "legacy" };
}
// <<< alert-lib v1

// each probe: the reason it failed, or "" when it is fine
const PROBES = {
  home: { name: "דף הבית", url: t => `${SITE}/?u=${t}`,
    check: async r => (r.status !== 200 ? String(r.status) : (await hasMark(r.body)) ? "" : "marker") },
  api: { name: "שירות ההרשמה (/api)", url: () => `${SITE}/api/confirm?e=x&x=1&t=x`, manual: true,
    check: async r => (r.status !== 302 ? String(r.status) : /subscribed=expired/.test(r.headers.get("location") || "") ? "" : "redirect") },
};
const C0 = () => ({ at: null, day: null, n: 0, told: null, err: null, errAt: null, seen: {} });   // n = runs the clock started on "day" (Israel date)
const P0 = () => ({ fails: 0, armed: false, since: null, pagedAt: null, remAt: null, last: null, back: null });   // back = ms down, recovery line not yet out
const U0 = () => ({ v: 1, tick: null, mode: "observe", probes: { home: P0(), api: P0() }, gh: { seenAt: null, t: null, at: null, staleAt: null }, clock: C0(), morning: null, hello: false, tg: false });
const iso = t => new Date(t).toISOString();
const ms = s => (typeof s === "string" ? Date.parse(s) : NaN);
const ilDate = d => new Intl.DateTimeFormat("en-CA", { timeZone: QUIET.tz }).format(d);   // YYYY-MM-DD in Israel
const dur = t => { const m = Math.max(1, Math.round(t / 6e4)); return m < 120 ? `${m} דקות` : `${Math.round(m / 60)} שעות`; };
const sleep = t => new Promise(r => setTimeout(r, t));
const drop = async r => { try { await r.body?.cancel(); } catch {} };

// the marker in the first MARK_MAX bytes of a streamed body: bytes, no decoding, carried across chunk edges; the rest is never downloaded
async function hasMark(body) {
  if (!body) return false;
  const rd = body.getReader();
  let seen = 0, tail = new Uint8Array(0);
  try {
    while (seen < MARK_MAX) {
      const { done, value } = await rd.read();
      if (done) return false;
      const buf = new Uint8Array(tail.length + value.length); buf.set(tail); buf.set(value, tail.length);
      const end = MARK_MAX - seen + tail.length;   // a match must end inside the first MARK_MAX bytes
      for (let i = buf.indexOf(MARK[0]); i >= 0 && i + MARK.length <= end; i = buf.indexOf(MARK[0], i + 1)) {
        let j = 1; while (j < MARK.length && buf[i + j] === MARK[j]) j++;
        if (j === MARK.length) return true;
      }
      seen += value.length; tail = buf.slice(Math.max(0, buf.length - MARK.length + 1));
    }
    return false;
  } finally { try { await rd.cancel(); } catch {} }
}
// 10 s per try, one retry 5 s later
async function probe(id, now) {
  const p = PROBES[id];
  let last = "net";
  for (let i = 0; i < 2; i++) {
    if (i) await sleep(UP.retry);
    try {
      const r = await fetch(p.url(now), { headers: { "user-agent": UA }, redirect: p.manual ? "manual" : "follow", signal: AbortSignal.timeout(UP.probe) });
      const why = await p.check(r);
      await drop(r);
      if (!why) return { ok: true, last: String(r.status) };
      last = why;
    } catch (e) { last = /timeout|abort/i.test(e?.name || "") ? "timeout" : "net"; }
  }
  return { ok: false, last };
}
// heartbeat.json {t} written by alert-daily; null when it cannot be read
async function heartbeat() {
  try {
    const r = await fetch(HEARTBEAT, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(UP.hb) });
    if (!r.ok) { await drop(r); return null; }
    const t = ms((await r.json())?.t);
    return t > 0 ? t : null;
  } catch { return null; }
}
// KV "u", or null when missing or unreadable as JSON; throws when KV fails
const readU = async env => { try { return JSON.parse(await within(env.ALERTS.get("u"))); } catch (e) { if (e instanceof SyntaxError) return null; throw e; } };
// getChat sends nothing and fails on a bad token, a wrong chat or a bot removed from it; 2 tries 1 s apart, as tgSend
async function tgCheck(env) {
  for (let i = 0; i < 2; i++) {
    if (i) await sleep(1000);
    try {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChat?chat_id=${encodeURIComponent(env.TELEGRAM_CHAT_ID)}`, { signal: AbortSignal.timeout(10000) });
      await drop(r);
      if (r.ok) return true;
      if (r.status < 500 && r.status !== 429) return false;
    } catch { /* timeout or network: retry */ }
  }
  return false;
}

// The backup clock (Dudu 2.11.2026 "כן, לבנות"; ops bots review): from 1.11.2026 GitHub started scheduled runs hours late or not at all
// (2.11: daily bots about 1 h late, later 8-10 h; frequent ones mostly never). Once an hour, for each entry due now, it reads the runs of the
// workflow on main since the entry's cut-off: "gap" minutes ago, or the last slot of its "cron" line. With no run of its own there (see
// counts()), it starts one by hand (workflow_dispatch on main, with the inputs that make it act as its schedule). "morning" (Alert daily) goes
// by Israel time: from 08:45 to 22:00 while today's heartbeat is missing. A scheduled run GitHub still starts late after that does no harm:
// each of these bots keeps its own state (posted items in social-queue, the daily claim in alert-state, the watch states) or writes the same
// thing again, and runs in its own concurrency group. A bot where a second run would cost or send twice is here only with the slot check
// (slot-done.mjs, below). GitHub answers 401/403/404 to the token =
// one day alert at most once per 22.5 h (an expired or revoked token); any other failure is a log line and the next hour retries.
const CLOCK = [
  { wf: "social-publish.yml", he: "פרסום ברשתות", utc: [5, 20], gap: 40, inputs: { mode: "run" } },              // slots every 15 min 04:04-19:49
  { wf: "live-watch.yml", he: "מעקב הדשבורד", utc: [0, 24], gap: 75, inputs: { dry_run: "false" } },             // :12 and :42
  { wf: "reviews-monitor.yml", he: "ביקורות בחנות", utc: [7, 20], gap: 330, inputs: { dry_run: "false" } },       // 06:15, 11:15, 17:15
  { wf: "release-watch.yml", he: "מעקב הגרסה בחנות", utc: [8, 20], gap: 330, inputs: { mode: "on" } },            // 06:40, 11:40, 17:40
  { wf: "alert-daily.yml", he: "סיכום הבוקר", morning: [845, 2200], gap: 60, inputs: { dry_run: "false" } },      // 05:05 / 06:05 (08:05 local)
  // the daily bots (3.11.2026: GitHub started none of the morning's data checks): due from an hour after today's slot ("slot", the
  // workflow's own daily line, UTC) inside the utc hours, while no run of its own started since that slot. Until 4.11 the cut-off was
  // "no run in 20 h", so GitHub's run of 11:49 the day before held the next morning's start until 07:49 and the start drifted later each day
  // (ops thread 4.11.2026); a run of the day before never counts now. "gap" stays only for the read order
  { wf: "app-guardian.yml", he: "שומר האפליקציה", utc: [3, 20], gap: 1200, slot: "37 1 * * *", inputs: {} },                              // 01:37
  { wf: "ui-guardian.yml", he: "שומר האתר", utc: [4, 20], gap: 1200, slot: "17 2 * * *", inputs: {} },                                     // 02:17
  { wf: "seo-data.yml", he: "נתוני החיפוש", utc: [5, 20], gap: 1200, slot: "30 3 * * *", inputs: {} },                                     // 03:30
  { wf: "own-data.yml", he: "הנתונים שלנו", utc: [5, 20], gap: 1200, slot: "40 3 * * *", inputs: {} },                                     // 03:40
  { wf: "ministry-watch.yml", he: "מעקב משרד התחבורה", utc: [5, 20], gap: 1200, slot: "7 4 * * *", inputs: { dry_run: "false" } },        // 04:07
  { wf: "data-guard.yml", he: "שומר הנתונים", utc: [5, 20], gap: 1200, slot: "15 4 * * *", inputs: { dry_run: "false" } },                 // 04:15
  { wf: "release-guard.yml", he: "שומר הגרסה", utc: [5, 20], gap: 1200, slot: "23 4 * * *", inputs: { mode: "on" } },                       // 04:23
  { wf: "data-truth.yml", he: "אמת הנתונים", utc: [6, 20], gap: 1200, slot: "47 4 * * *", job: "audit", inputs: { job: "audit" } },         // 04:47 (the daily audit only)
  { wf: "fuel.yml", he: "מחירי הדלק", utc: [6, 20], gap: 1200, slot: "17 5 * * *", inputs: {} },                                           // 05:17
  { wf: "site-smoke.yml", he: "בדיקת האתר", utc: [7, 20], gap: 1200, slot: "30 5 * * *", inputs: { dry_run: "false", infra: "true" } },     // 05:30
  { wf: "web-watch.yml", he: "מעקב האתר", utc: [9, 20], gap: 1200, slot: "25 7 * * *", inputs: { dry_run: "false" } },                     // 07:25
  { wf: "catalog.yml", he: "מאגר הדגמים", utc: [11, 20], gap: 1200, slot: "20 9 * * *", inputs: {} },                                      // 09:20
  // the weekly and monthly bots (3.11.2026): "cron" is the workflow's own line (UTC); due from an hour after its last slot, for 14 hours,
  // while no run of its own started since that slot. Only bots for which a start by hand is their schedule and a late GitHub run after
  // it changes nothing: the same snapshot or data again (no diff, no commit), the same text (no call), a check. Not the magazine: a second
  // data run the same week publishes the next article in line.
  { wf: "camp-data.yml", he: "צילום נתוני הקמפיינים", cron: "40 4 * * 3", inputs: {} },                                  // Wednesday
  { wf: "copy-audit.yml", he: "בדיקת הנוסח השבועית", cron: "41 5 * * 1", inputs: { dry: "false", force: "false" } },   // Monday; the same text = no call
  { wf: "seo-check.yml", he: "בדיקת SEO", cron: "30 5 * * 1", inputs: {} },                                              // Monday: the live site too
  { wf: "data-truth.yml", he: "הבדיקה השבועית מול משרד התחבורה", cron: "17 1 * * 0", job: "invariants", inputs: { job: "invariants" } },   // Sunday
  { wf: "market.yml", he: "נתוני השוק", cron: "40 4 5 * *", inputs: { skip_gate: "false" } },                            // the 5th
  { wf: "models.yml", he: "שמות הדגמים", cron: "10 7 5 * *", inputs: { skip_gate: "false" } },                           // the 5th
  { wf: "modelstats.yml", he: "סטטיסטיקת הדגמים", cron: "20 5 6 * *", inputs: { skip_gate: "false" } },                  // the 6th
  { wf: "zombie.yml", he: "גלאי רכבים שחזרו לכביש", cron: "7 7 3 * *", inputs: {} },                                     // the 3rd
  // the slot-checked bots (3.11.2026, with their owner threads): each takes the input "schedule" = the cron line and holds it in its run name,
  // so only a run of that line counts (title), and slot-done.mjs makes the later run of one slot do nothing: GitHub's late run after the
  // clock's start sends no second brief, Claude call or commit. "il": only the line whose slot is that hour in Israel (the other is gated out)
  { wf: "weekly-analytics.yml", he: "הדוח השבועי", cron: "20 5 * * 0", il: 8, title: "(20 5 * * 0)", inputs: { schedule: "20 5 * * 0" } },   // Sunday, summer time
  { wf: "weekly-analytics.yml", he: "הדוח השבועי", cron: "20 6 * * 0", il: 8, title: "(20 6 * * 0)", inputs: { schedule: "20 6 * * 0" } },   // Sunday, winter time
  { wf: "settlements.yml", he: "הסדרי פשרה", cron: "43 4 * * 0", title: "(43 4 * * 0)", inputs: { schedule: "43 4 * * 0", dry: "false" } },    // Sunday
  { wf: "explore.yml", he: "הסיור השבועי באפליקציה", cron: "7 3 * * 1", title: "(7 3 * * 1)", inputs: { schedule: "7 3 * * 1" } },              // Monday (walks next)
  { wf: "data-truth.yml", he: "בדיקת העומק החודשית", cron: "17 5 1 * *", title: "(17 5 1-3 * *)", inputs: { job: "deep", schedule: "17 5 1-3 * *" } },   // the 1st (2nd, 3rd: GitHub's retries)
  { wf: "data-truth.yml", he: "בדיקת העומק הנוספת", cron: "17 5 18-19 * *", title: "(17 5 18-19 * *)", inputs: { job: "deep", schedule: "17 5 18-19 * *" } },
  { wf: "data-truth.yml", he: "בדיקת העומק הנוספת", cron: "17 11 18-19 * *", title: "(17 11 18-19 * *)", inputs: { job: "deep", schedule: "17 11 18-19 * *" } },
  { wf: "competitor-check.yml", he: "בדיקת המתחרים החודשית", cron: "23 4 1 * *", title: "(23 4 1 * *)", inputs: { schedule: "23 4 1 * *", dry: "false" } },     // the 1st
  { wf: "kit-draft.yml", he: "טיוטת ערכת התוכן השבועית", cron: "40 20 * * 3", title: "(40 20 * * 3)", inputs: { schedule: "40 20 * * 3" } },     // Wednesday night
  { wf: "kit-qa.yml", he: "הבדיקה הוויזואלית של ערכת התוכן", cron: "40 13 * * 4", title: "(40 13 * * 4)", inputs: { schedule: "40 13 * * 4" } },   // Thursday
  { wf: "magazine.yml", he: "כתבת הנתונים במגזין", cron: "30 5 * * 4", title: "(30 5 * * 4)", inputs: { part: "data", schedule: "30 5 * * 4" } },   // Thursday
  { wf: "magazine.yml", he: "הכתבה החודשית במגזין", cron: "7 8 6 * *", title: "(7 8 6 * *)", inputs: { part: "monthly", schedule: "7 8 6 * *" } },  // the 6th
];
const clockKey = x => x.wf + (x.job ? ":" + x.job : "") + (x.title ? " " + x.title : "");
const CLOCK_MAX = 10;     // starts per hourly pass
const CLOCK_READS = 20;   // runs lists per pass (a bot seen done is not read again until its next cut-off), plus 3 job lists at most:
                          // with the starts and the rest of the tick it stays inside a Worker's 50 subrequests
const GH_API = `https://api.github.com/repos/${REPO}/actions/`;
const ilHM = d => +new Intl.DateTimeFormat("en-GB", { timeZone: QUIET.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d).replace(":", "");
// the last time a cron line (UTC: minute hour day-of-month month weekday; numbers, lists, ranges and *) fired at or before now; 0 = none in 40 days
export function clockSlot(cron, now) {
  const f = String(cron).trim().split(/\s+/);
  const set = (s, wd) => { if (s === "*") return null; const o = new Set(); for (const p of String(s).split(",")) { const [a, b = a] = p.split("-").map(Number); for (let i = a; i <= b; i++) o.add(wd && i === 7 ? 0 : i); } return o; };
  const [mi, ho, dm, mo, dw] = f.length === 5 ? f.map((v, i) => set(v, i === 4)) : [new Set(), null, null, null, null];
  const has = (S, v) => !S || S.has(v), mins = [...(mi || Array.from({ length: 60 }, (_, i) => i))].sort((a, b) => b - a);
  for (let t = Math.floor(now / 36e5) * 36e5, end = now - 40 * 864e5; t > end; t -= 36e5) {
    const d = new Date(t), day = dm && dw ? dm.has(d.getUTCDate()) || dw.has(d.getUTCDay()) : has(dm, d.getUTCDate()) && has(dw, d.getUTCDay());
    if (!day || !has(mo, d.getUTCMonth() + 1) || !has(ho, d.getUTCHours())) continue;
    for (const m of mins) if (t + m * 6e4 <= now) return t + m * 6e4;
  }
  return 0;
}
// an entry's cut-off: a run created since it counts as this round's
const clockSince = (x, now) => x.cron ? clockSlot(x.cron, now) : x.slot ? clockSlot(x.slot, now) : now - x.gap * 6e4;
// the entries due now (pure, for the test): utc hours, the morning window, or from an hour after a cron slot for 14 hours ("il": a slot
// at that hour in Israel only)
export function clockDue(now, hbT) {
  const d = new Date(now), h = d.getUTCHours(), hm = ilHM(d), today = ilDate(d);
  return CLOCK.filter(c => c.cron ? (s => s > 0 && now - s >= 36e5 && now - s < 14 * 36e5 && (!c.il || Math.floor(ilHM(new Date(s)) / 100) === c.il))(clockSlot(c.cron, now))
    : c.morning ? hm >= c.morning[0] && hm < c.morning[1] && !(hbT > 0 && ilDate(new Date(hbT)) === today)
    : h >= c.utc[0] && h < c.utc[1] && (!c.slot || (s => s > 0 && now - s >= 36e5)(clockSlot(c.slot, now))));
}
// a run of the entry's own: started by GitHub's schedule or by hand (site smoke and the two guardians also run on pushes and pull requests,
// which are other checks; 3.11.2026), not skipped, and with the entry's title when it has one (for a workflow with parts by run name)
export const counts = (x, r) => ["schedule", "workflow_dispatch"].includes(r?.event) && r.conclusion !== "skipped" && (!x.title || String(r.display_title || "").includes(x.title));
async function gh(env, path, body) {
  const r = await fetch(GH_API + path, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000),
    headers: { authorization: "Bearer " + env.GH_DISPATCH_TOKEN, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": UA, ...(body ? { "content-type": "application/json" } : {}) } });
  const j = r.status === 204 ? null : await r.json().catch(() => null);
  return { status: r.status, j };
}
async function backupClock(env, u, now, fire) {
  const c = u.clock;
  if (!env.GH_DISPATCH_TOKEN || String(env.CLOCK || "").toLowerCase() === "off") return;
  if (now - ms(c.at) < 55 * 6e4) return;
  c.at = iso(now);
  const today = ilDate(new Date(now));
  if (c.day !== today) Object.assign(c, { day: today, n: 0 });
  const keys = new Set(CLOCK.map(clockKey));
  c.seen = Object.fromEntries(Object.entries(c.seen || {}).filter(([k]) => keys.has(k)));   // entry -> its newest own run seen (created_at)
  const morningOpen = CLOCK.some(x => x.morning && ilHM(new Date(now)) >= x.morning[0] && ilHM(new Date(now)) < x.morning[1]);
  // read order: the frequent ones and the morning, then the weekly and monthly (one slot, so not left behind on a heavy pass), then the daily
  const rank = x => x.cron ? 1 : x.gap >= 1200 ? 2 : 0;
  const due = clockDue(now, morningOpen ? await heartbeat() : null).sort((a, b) => rank(a) - rank(b)), started = [];
  let refused = 0, reads = 0, jobReads = 0;
  for (const x of due) {
    if (started.length >= CLOCK_MAX || reads >= CLOCK_READS) break;
    const key = clockKey(x), since = clockSince(x, now);
    if (!(since > 0) || ms(c.seen[key]) >= since) continue;   // seen done since the cut-off: no read
    try {
      reads++;
      const r = await gh(env, `workflows/${x.wf}/runs?branch=main&per_page=30&created=${encodeURIComponent(">=" + iso(since))}`);
      if ([401, 403, 404].includes(r.status)) { refused = r.status; break; }
      if (r.status !== 200) { console.log(`clock ${x.wf}: runs read ${r.status}`); continue; }
      let own = null, sure = true;   // sure = remember it, so the next passes need no read until the next cut-off
      for (const run of (r.j?.workflow_runs || []).filter(run => counts(x, run) && ms(run.created_at) >= since)) {
        if (!x.job) { own = run; break; }
        // data truth: one workflow, three jobs by the cron line or the "job" input; the run counts when the entry's job is not skipped.
        // Out of job reads this pass, or a list that cannot be read: nothing started and nothing remembered, the next hour reads again
        if (jobReads >= 3) { own = run; sure = false; break; }
        jobReads++;
        const j = await gh(env, `runs/${run.id}/jobs?per_page=20`);
        if ([401, 403, 404].includes(j.status)) { refused = j.status; break; }
        const job = (j.j?.jobs || []).find(o => o.name === x.job);
        if (j.status !== 200 || !job) { own = run; sure = false; break; }
        if (job.conclusion !== "skipped") { own = run; sure = run.status === "completed"; break; }   // ran, or running (remembered once it ends)
      }
      if (refused) break;
      if (own) { if (sure) c.seen[key] = own.created_at; continue; }
      const d = await gh(env, `workflows/${x.wf}/dispatches`, { ref: "main", inputs: x.inputs });
      if ([401, 403, 404].includes(d.status)) { refused = d.status; break; }
      console.log(`clock ${key}: no run of its own since ${iso(since)}, started: ${d.status}`);
      if (d.status === 204) { if (!started.includes(x.he)) started.push(x.he); c.n++; }
    } catch (e) { console.log(`clock ${x.wf}: ${String(e?.name || e).slice(0, 60)}`); }
  }
  if (refused) {
    c.err = "refused " + refused;
    console.log("clock: GitHub refused the token, " + refused);
    if (!(now - ms(c.errAt) < UP.remind) && await fire("day", "up:clock-token", `${TAG.gh}\n<b>שעון הגיבוי של הבוטים לא עובד</b>\nGitHub דחה את הטוקן שלו (GH_DISPATCH_TOKEN), כנראה כי פג תוקפו או שבוטל. בינתיים בוטים ש-GitHub מאחר להפעיל לא יופעלו מכאן.\n👉 מה לעשות: ליצור טוקן חדש באותן הגדרות (Actions: Read and write, רק vehicle-app) ולהדביק אותו בסוד GH_DISPATCH_TOKEN, ואז לכתוב בשרשור "תפעול, בוטים ומייל".`))
      c.errAt = iso(now);
    return;
  }
  c.err = null;
  // one quiet line per Israel day, on the first start: what GitHub was late with (later starts that day are counted in /health)
  if (started.length && c.told !== today && await fire("summary", "up:clock", `${TAG.gh}\n🕐 GitHub איחר בהפעלת בוטים, ושעון הגיבוי הפעיל אותם: ${started.join(", ")}.\n👌 לא צריך לעשות כלום.`))
    c.told = today;
}

async function tick(env) {
  if (!env.ALERTS) return console.log("no KV binding ALERTS: nothing checked");
  let u;
  try { u = await readU(env); } catch (e) { return console.log("KV read failed, tick skipped:", String(e).slice(0, 120)); }
  u = { ...U0(), ...(u || {}) };
  u.probes = Object.fromEntries(Object.keys(PROBES).map(id => [id, { ...P0(), ...(u.probes || {})[id] }]));
  u.gh = { ...U0().gh, ...u.gh };
  u.clock = { ...C0(), ...u.clock };
  const now = Date.now(), day = isDaytime(new Date(now)), page = routed(env, "critical"), keys = !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
  u.mode = page ? "page" : "observe";
  if (!keys) u.tg = false;
  const send = async (text, o) => (u.tg = await tgSend(env, text, o));
  // observe: silent and marked as a trial, no email; page: the block's legacy is a loud resend as a last try
  const legacy = text => () => (page ? send(text) : send(TRIAL + text, { silent: true }));
  const fire = async (level, key, text) => { const r = await alert(env, level, key, text, "", { legacy: legacy(text) }); if (r.action !== "legacy") u.tg = r.delivered; return r.delivered; };

  const h = new Date(now).getUTCHours(), ghDue = UP.ghHours.includes(h) && !(now - ms(u.gh.at) < 36e5);
  const ids = Object.keys(PROBES);
  const [res, hb] = await Promise.all([Promise.all(ids.map(id => probe(id, now))), ghDue ? heartbeat() : null]);
  const down = [], back = [], rem = [];
  ids.forEach((id, i) => {
    const p = u.probes[id], r = res[i];
    p.last = r.last;
    if (r.ok) {
      if (p.pagedAt) p.back = now - ms(p.since);
      Object.assign(p, { fails: 0, armed: true, since: null, pagedAt: null, remAt: null });
      if (p.back != null) back.push(id);
      return;
    }
    p.fails++; p.since = p.since || iso(now);
    if (!p.armed || p.fails < 2) return;
    if (!p.pagedAt) down.push(id);
    else if (day && now - Math.max(ms(p.pagedAt), ms(p.remAt) || 0) >= UP.remind) rem.push(id);
  });
  console.log("tick " + ids.map((id, i) => `${id}=${res[i].last}`).join(" ") + " mode=" + u.mode);

  // once a day, at the first daytime tick and before any send (a send that fails later in the tick wins): the Telegram check that
  // keeps "tg" honest for canDefer and /health
  const today = ilDate(new Date(now));
  if (day && u.morning !== today) { if (keys) u.tg = await tgCheck(env); u.morning = today; }
  if (!u.hello && keys && await send("✅ בדיקת הזמינות פועלת (כל 10 דקות)", { silent: true })) u.hello = true;
  const lines = list => list.map(id => { const p = u.probes[id];
    return `${PROBES[id].name} לא עונה כבר ${dur(now - ms(p.since))} (${p.fails} בדיקות ברצף, כל 10 דקות). בבדיקה האחרונה: ${WHY[p.last] || "השרת החזיר קוד " + p.last}.`; }).join("\n");
  if (down.length && await fire("critical", "up:" + down.join("+"), `${TAG.down}\n<b>לוחית לא זמינה</b>\n${lines(down)}\n${TODO.down}\nזמן: ${ilTime(new Date(now))}`))
    for (const id of down) Object.assign(u.probes[id], { pagedAt: iso(now), back: null });
  if (rem.length && await fire("critical", "up:" + rem.join("+"),
    `🔁 תזכורת: זה עדיין קורה (מאז ${ilTime(new Date(ms(u.probes[rem[0]].since)))})\n\n${TAG.down}\n<b>לוחית לא זמינה</b>\n${lines(rem)}\n${TODO.down}\nזמן: ${ilTime(new Date(now))}`))
    for (const id of rem) u.probes[id].remAt = iso(now);
  if (back.length && await send((page ? "" : TRIAL) + `${TAG.back}\n` + back.map(id => `${PROBES[id].name} חזר לעבוד אחרי ${dur(u.probes[id].back)}.`).join("\n") + "\n👌 לא צריך לעשות כלום.", { silent: true }))
    for (const id of back) u.probes[id].back = null;   // a failed line is sent again on the next OK tick

  // the ring for luchit-mail's night pointers: listed on every daytime tick (84 lists/day of the free 1,000), so a pointer written
  // just after 08:00 or late in KV's list still rings the same morning; one older than 12 h shows its date
  if (day) try {
    const names = (await within(env.ALERTS.list({ prefix: "p:" }))).keys.map(k => k.name);
    const ptr = (await Promise.all(names.map(k => within(env.ALERTS.get(k, "json")).catch(() => null)))).filter(x => x && ms(x.at) > 0).sort((a, b) => ms(a.at) - ms(b.at));
    const ring = ptr.slice(0, 20).map(x => { const c = MAIL_CLS[String(x.c).split(":").pop()], at = ilTime(new Date(ms(x.at)));
      return `• ${c ? "פנייה בנושא " + c : "פנייה"} התקבלה ב-${now - ms(x.at) > 12 * 36e5 ? at : at.slice(-5)}`; });
    if (ptr.length > 20) ring.push(`ועוד ${ptr.length - 20} פניות`);
    if (!ring.length || await send(`${TAG.mail}\n☀️ <b>פניות שהגיעו בלילה</b>\n${ring.join("\n")}\n${TODO.mail}`))   // a failed ring keeps the keys
      await Promise.all(names.map(k => within(env.ALERTS.delete(k)).catch(() => {})));   // a key left behind expires by its TTL (48 h)
  } catch (e) { console.log("morning ring: KV failed, next tick retries:", String(e).slice(0, 120)); }

  // GitHub watch: armed once a heartbeat was seen; over 50 h old = day alert by day, at most once per 22.5 h, email in page mode
  if (ghDue) {
    u.gh.at = iso(now);
    if (hb) { u.gh.t = iso(hb); u.gh.seenAt = iso(now); }
    const t = ms(u.gh.t);
    if (u.gh.seenAt && now - t > UP.stale && day && !(now - ms(u.gh.staleAt) < UP.remind)) {
      const text = `${TAG.gh}\n<b>הבוטים ב-GitHub לא רצו כבר יומיים</b>\nהדופק האחרון שלהם היה ב-${ilTime(new Date(t))}, ובינתיים שום בדיקה אוטומטית לא רצה.\n${TODO.gh}\nhttps://github.com/${REPO}/actions`;
      const [ok] = await Promise.all([fire("day", "up:github-stale", text), page ? emailSend(env, "⚠️ לוחית: האוטומציות ב-GitHub לא רצו כבר יומיים", text) : false]);
      if (ok) u.gh.staleAt = iso(now);
    }
  }

  try { await backupClock(env, u, now, fire); } catch (e) { console.log("clock failed:", String(e).slice(0, 120)); }

  u.tick = iso(now);
  try { await within(env.ALERTS.put("u", JSON.stringify(u))); } catch (e) { console.log("KV write failed:", String(e).slice(0, 120)); }   // the only write of the tick
}

export default {
  async scheduled(event, env) {
    try { await tick(env); } catch (e) { console.log("tick failed:", String(e).slice(0, 200)); }
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method !== "GET" || url.pathname !== "/health") return new Response("not found", { status: 404 });
    let u = null, ok = true;
    try { u = env.ALERTS ? await readU(env) : null; } catch { ok = false; }
    const a = id => !!u?.probes?.[id]?.armed;
    return new Response(JSON.stringify({ v: "uptime-1", mode: routed(env, "critical") ? "page" : "observe", tick: u?.tick || null,
      armed: { home: a("home"), api: a("api") }, tg: u?.tg === true, email: !!(env.MAIL || env.BREVO_KEY),
      clock: { on: !!env.GH_DISPATCH_TOKEN && String(env.CLOCK || "").toLowerCase() !== "off", at: u?.clock?.at || null, today: u?.clock?.day === ilDate(new Date()) ? u.clock.n : 0, ok: !u?.clock?.err } }),
      { status: ok ? 200 : 503, headers: { "content-type": "application/json", "cache-control": "no-store", ...version(env) } });
  },
};
