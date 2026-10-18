// Reference copy of the "alert-lib v1" block for the Cloudflare Workers (luchit-uptime, luchit-mail). Everything between the two marker
// lines is pasted byte-identical into worker/uptime/worker.js and worker/mail/worker.js, so each Worker stays one pasteable file.
// CI (alert-check.yml) compares the copies with this file, and QUIET and the isDaytime body with .github/scripts/alert.mjs.
// Same meaning as the GitHub router: the Worker's own dashboard variable ALERT_ROUTE (comma list or "all") switches levels on; a level
// that is not routed, or any exception, runs the caller's legacy (today's send). No imports; cloudflare:email is loaded only when needed.
// >>> alert-lib v1
const QUIET = { tz: "Asia/Jerusalem", dayStart: 8, dayEnd: 22 };   // CI: must equal alert.mjs QUIET
const ALERT_MAIL = { name: "לוחית התראות", from: "alerts@luchit.app", brevoFrom: "updates@luchit.app", to: "ddsabag@gmail.com" };   // to = FORWARD_TO of luchit-mail
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
// a night "day" item may wait for the morning ring only when KV ALERTS is bound and luchit-uptime ticked in the last 25 min
async function canDefer(env) {
  try { if (!env.ALERTS) return false; const u = await within(env.ALERTS.get("u", "json")); return !!u && Date.now() - Date.parse(u.tick) <= 25 * 6e4; } catch { return false; }
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
export { QUIET, ALERT_MS, isDaytime, ilTime, routed, tgSend, emailSend, canDefer, alert };   // tests only (worker/lib/test.mjs); in a Worker the block stays module-local
