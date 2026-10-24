// luchit-uptime: Cloudflare Worker that checks luchit.app every 10 minutes (cron */10) and pages Dudu when it is down.
//   probes: home = GET https://luchit.app/?u=<ms> must answer 200 with the bytes id="plate" in the first 256 KB;
//           api  = GET https://luchit.app/api/confirm?e=x&x=1&t=x must answer 302 to ...subscribed=expired (luchit-api rejects the
//                  address before signing: no mail, no Brevo or GA call, no write; the same check as infra-watch.mjs)
//   2 failed ticks in a row (each with one retry) = one critical alert: Telegram loud + email in parallel; one reminder per 22.5 h by day;
//   a silent line on recovery (retried on later OK ticks until it is out). A probe pages only after its first success (armed).
//   Other duties: the morning ring for luchit-mail's night pointers (KV "p:<ms>", listed on every daytime tick), a daily Telegram
//   getChat, and a watch on the GitHub heartbeat (alert-state/heartbeat.json) 4 times a day.
//   GET /health = public status without keys, numbers or mail data.
// Observe mode (default): the dashboard variable ALERT_ROUTE does not list "critical", so a would-be page is a SILENT "🧪 (מצב ניסיון)"
// message with no email. ALERT_ROUTE=critical turns paging on; deleting the variable turns it off again.
// Bindings: KV ALERTS (luchit-alerts, required; without it the Worker only logs). Optional: Send Email MAIL. Secrets: TELEGRAM_BOT_TOKEN,
// TELEGRAM_CHAT_ID (without them it records and sends nothing), optional BREVO_KEY. KV "u" is written once per tick (144/day).
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
const P0 = () => ({ fails: 0, armed: false, since: null, pagedAt: null, remAt: null, last: null, back: null });   // back = ms down, recovery line not yet out
const U0 = () => ({ v: 1, tick: null, mode: "observe", probes: { home: P0(), api: P0() }, gh: { seenAt: null, t: null, at: null, staleAt: null }, morning: null, hello: false, tg: false });
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

async function tick(env) {
  if (!env.ALERTS) return console.log("no KV binding ALERTS: nothing checked");
  let u;
  try { u = await readU(env); } catch (e) { return console.log("KV read failed, tick skipped:", String(e).slice(0, 120)); }
  u = { ...U0(), ...(u || {}) };
  u.probes = Object.fromEntries(Object.keys(PROBES).map(id => [id, { ...P0(), ...(u.probes || {})[id] }]));
  u.gh = { ...U0().gh, ...u.gh };
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
      armed: { home: a("home"), api: a("api") }, tg: u?.tg === true, email: !!(env.MAIL || env.BREVO_KEY) }),
      { status: ok ? 200 : 503, headers: { "content-type": "application/json", "cache-control": "no-store", ...version(env) } });
  },
};
