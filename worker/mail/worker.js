// luchit-mail: Cloudflare Email Worker for support@luchit.app.
// Every incoming mail is (1) summarised and classified into a Telegram message and (2) always forwarded to the normal inbox (in finally,
// so no error and no new code can skip it).
// Setup: Cloudflare > Email > Email Routing > Routes: point support@luchit.app at this Worker ("Send to a Worker").
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.  Var: FORWARD_TO (a verified destination address in Email Routing).
// Alert router (optional, dashboard): var ALERT_ROUTE (comma list of levels or "all") and KV binding ALERTS = luchit-alerts. Unset = as
// before: every mail is one loud Telegram message (today's request, kept verbatim as the router's legacy). Routed levels:
//   day     privacy, crash: loud by day; at night silent plus a pointer for luchit-uptime's morning ring, only while luchit-uptime is
//           alive (else loud)
//   summary data, biz, other: one silent message at once, same text
//   silent  bulk mail (mailing lists, newsletters, auto-replies; by headers only): no Telegram, Gmail only
// The block between the alert-lib v1 markers is a byte-identical copy of worker/lib/alert-lib.js (CI compares them).

const CLASSES = [
  { key: "privacy", icon: "🔴", label: "פרטיות או מחיקה", re: /פרטיות|מחיק|למחוק|מחקו|תמחק|מחק את|להסיר את|להסיר אות|הסירו|תסירו|(אבקש|מבקש\S*|בקש[הת]) \S{0,2}הסי?ר|הסר[הת]? (של )?ה?(מידע|פרטי|נתונ|חשבון)|gdpr|privacy|delete (all )?my|remove my|erase/i },
  { key: "crash", icon: "🔴", label: "תקלה באפליקציה", re: /קורס|קריסה|נתקע|תקוע|לא עובד|לא נפתח|תקלה|שגיאה|crash|bug|error|freez|not working/i },
  { key: "data", icon: "🟡", label: "טעות בנתוני רכב", re: /טעות|שגוי|לא נכון|לא תואם|לא מדויק|נתון|מספר רישוי|מספר יד|ידיים|ריקול|טסט|wrong|incorrect|mistake/i },
  { key: "biz", icon: "🔵", label: "שיתוף פעולה או עיתונות", re: /שיתוף פעולה|פרסום|חסות|עיתונא|כתבה|כתב ב|ראיון|partnership|sponsor|press|advertis/i },
];

function decodeWords(s) {   // RFC 2047 encoded words in a header
  return s.replace(/=\?([\w-]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
    try {
      const bytes = enc.toUpperCase() === "B" ? Uint8Array.from(atob(txt), c => c.charCodeAt(0))
        : Uint8Array.from(txt.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), c => c.charCodeAt(0));
      return new TextDecoder(cs).decode(bytes);
    } catch { return txt; }
  });
}
function decodeBody(txt, enc, cs) {
  try {
    enc = (enc || "").toLowerCase();
    if (enc === "base64") txt = new TextDecoder(cs || "utf-8").decode(Uint8Array.from(atob(txt.replace(/\s+/g, "")), c => c.charCodeAt(0)));
    else if (enc === "quoted-printable") {
      const raw = txt.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
      txt = new TextDecoder(cs || "utf-8").decode(Uint8Array.from(raw, c => c.charCodeAt(0) & 255));
    }
  } catch { /* keep raw */ }
  return txt;
}
// Pulls the first text/plain part out of a raw mail (handles single-part and one level of multipart).
function plainText(raw) {
  const split = s => { const i = s.search(/\r?\n\r?\n/); return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i).replace(/^\r?\n\r?\n/, "")]; };
  const hdr = (h, n) => { const m = new RegExp("^" + n + ":\\s*([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)", "im").exec(h); return m ? m[1].replace(/\r?\n[ \t]+/g, " ") : ""; };
  const [h, body] = split(raw);
  const ct = hdr(h, "Content-Type"), b = /boundary="?([^";\s]+)"?/i.exec(ct);
  if (b) {
    for (const part of body.split("--" + b[1])) {
      const [ph, pb] = split(part.replace(/^\r?\n/, ""));
      if (/text\/plain/i.test(hdr(ph, "Content-Type"))) return decodeBody(pb, hdr(ph, "Content-Transfer-Encoding"), (/charset="?([\w-]+)/i.exec(hdr(ph, "Content-Type")) || [])[1]);
    }
    return "";
  }
  return decodeBody(body, hdr(h, "Content-Transfer-Encoding"), (/charset="?([\w-]+)/i.exec(ct) || [])[1]);
}
const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function summarise(from, subject, rawText) {
  const text = plainText(rawText).replace(/^>.*$/gm, "").replace(/\s+/g, " ").trim();
  const hay = subject + " " + text;
  const cls = CLASSES.find(c => c.re.test(hay)) || { key: "other", icon: "⚪", label: "אחר" };
  return { cls, text: text.slice(0, 700) };
}
// mailing lists, newsletters and auto-replies, by headers only (a "no-reply" sender alone is not bulk)
function isBulk(h) {
  const auto = (h.get("auto-submitted") || "").trim();
  return h.has("list-unsubscribe") || h.has("list-id") || /^\s*(bulk|list|junk)\b/i.test(h.get("precedence") || "") || (!!auto && !/^no\b/i.test(auto));
}
// router level per mail; key = "mail:<class>" (luchit-uptime's morning ring reads the class from it, never the mail)
const LEVEL = { privacy: "day", crash: "day", data: "summary", biz: "summary", other: "summary" };

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

export default {
  async email(message, env) {
    let body = "", tried = false;
    // today's request, verbatim (loud, HTML): the router's legacy, and the only send while ALERT_ROUTE is unset. true = Telegram took it
    const legacy = async () => {
      tried = true;
      try {
        const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: body, parse_mode: "HTML", disable_web_page_preview: true }) });
        if (!r.ok) console.log("telegram", r.status, (await r.text()).slice(0, 200));
        return r.ok;
      } catch (e) { console.log("telegram error", String(e).slice(0, 200)); return false; }
    };
    try {
      const raw = await new Response(message.raw).text();
      const subject = decodeWords(message.headers.get("subject") || "(בלי נושא)");
      const { cls, text } = summarise(message.from, subject, raw);
      body = `${cls.icon} <b>פנייה חדשה ללוחית: ${cls.label}</b>\nמאת: ${esc(message.from)}\nנושא: ${esc(subject)}\n\n${esc(text) || "(אין טקסט רגיל בהודעה)"}\n\nלמענה: השיבו מהמייל (נשמר גם בג'ימייל)`;
      const bulk = isBulk(message.headers);
      await alert(env, bulk ? "silent" : LEVEL[cls.key] || "summary", "mail:" + (bulk ? "bulk" : cls.key), body, "", { legacy });
    } catch (e) {
      console.log("mail error", String(e).slice(0, 200));
      if (body && !tried) await legacy();   // the router broke before any send: today's message
    } finally {
      await message.forward(env.FORWARD_TO);   // always keep the original in the inbox
    }
  },
};
