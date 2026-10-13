// luchit-mail: Cloudflare Email Worker for support@luchit.app.
// Every incoming mail is (1) summarised and classified into a Telegram message and (2) still forwarded to the normal inbox, so nothing is lost.
// Setup: Cloudflare > Email > Email Routing > Routes: point support@luchit.app at this Worker ("Send to a Worker").
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.  Var: FORWARD_TO (a verified destination address in Email Routing).

const CLASSES = [
  { key: "privacy", icon: "🔴", label: "פרטיות או מחיקה", re: /פרטיות|מחיק|למחוק|הסר|להסיר|gdpr|privacy|delete my|unsubscribe|remove my/i },
  { key: "crash", icon: "🔴", label: "תקלה באפליקציה", re: /קורס|קריסה|נתקע|תקוע|לא עובד|לא נפתח|תקלה|שגיאה|crash|bug|error|freez|not working/i },
  { key: "data", icon: "🟡", label: "טעות בנתוני רכב", re: /טעות|שגוי|לא נכון|לא תואם|לא מדויק|נתון|מספר רישוי|מספר יד|ידיים|ריקול|טסט|wrong|incorrect|mistake/i },
  { key: "biz", icon: "🔵", label: "שיתוף פעולה או עיתונות", re: /שיתוף פעולה|פרסום|חסות|עיתונא|כתב|ראיון|partnership|sponsor|press|advertis/i },
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
  const cls = CLASSES.find(c => c.re.test(hay)) || { icon: "⚪", label: "אחר" };
  return { cls, text: text.slice(0, 700) };
}

export default {
  async email(message, env) {
    const raw = await new Response(message.raw).text();
    const subject = decodeWords(message.headers.get("subject") || "(בלי נושא)");
    const { cls, text } = summarise(message.from, subject, raw);
    const body = `${cls.icon} <b>פנייה חדשה ללוחית: ${cls.label}</b>\nמאת: ${esc(message.from)}\nנושא: ${esc(subject)}\n\n${esc(text) || "(אין טקסט רגיל בהודעה)"}\n\nלמענה: השיבו מהמייל (נשמר גם בג'ימייל)`;
    try {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: body, parse_mode: "HTML", disable_web_page_preview: true }) });
      if (!r.ok) console.log("telegram", r.status, (await r.text()).slice(0, 200));
    } catch (e) { console.log("telegram error", String(e).slice(0, 200)); }
    await message.forward(env.FORWARD_TO);   // always keep the original in the inbox
  },
};
