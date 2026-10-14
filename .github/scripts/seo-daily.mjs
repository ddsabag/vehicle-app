// Daily Google Search digest to Telegram: impressions, clicks, CTR, position, top queries and pages, split by page type.
// Search Console numbers arrive about 2-3 days late, so the digest reports the latest day that has data and says which day it is.
// DRY_RUN=1 prints instead of sending. Alerts and digest go to Telegram only.
import crypto from "node:crypto";
const DRY = process.env.DRY_RUN === "1", SITE = "sc-domain:luchit.app", ORIGIN = "https://luchit.app/";
const sa = JSON.parse(process.env.GA_SERVICE_ACCOUNT_JSON || "null");
if (!sa) { console.log("no service account secret, nothing to do"); process.exit(0); }
const b64 = b => Buffer.from(b).toString("base64url");
async function token() {
  const now = Math.floor(Date.now() / 1000), head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/webmasters.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 }));
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) });
  if (!r.ok) throw new Error("auth " + r.status);
  return (await r.json()).access_token;
}
const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
async function telegram(text) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (DRY || !tok || !chat) { console.log("--- Telegram (" + (DRY ? "dry run" : "no credentials") + ") ---\n" + text); return DRY; }
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }) });
  if (!r.ok) console.log("telegram failed", r.status);
  return r.ok;
}
const iso = d => d.toISOString().slice(0, 10), addDays = (s, n) => iso(new Date(Date.parse(s + "T00:00:00Z") + n * 864e5));
const dm = s => s.slice(8) + "." + s.slice(5, 7);
const n = x => Math.round(x).toLocaleString("en-US");
const pctChange = (a, b) => b ? Math.round((a - b) / b * 100) : null;
const arrow = c => c === null ? "" : c > 0 ? ` (▲ ${c}%)` : c < 0 ? ` (▼ ${Math.abs(c)}%)` : " (ללא שינוי)";
const SECTIONS = [["model", "דפי דגמים"], ["magazine", "מגזין"], ["guide", "מדריכים"], ["home", "דף הבית"]];
const sectionOf = u => { const p = u.replace(ORIGIN, "/"); return p.startsWith("/model") ? "model" : p.startsWith("/magazine") ? "magazine" : p.startsWith("/guide") ? "guide" : p === "/" ? "home" : "other"; };
const pagePath = u => u.replace(ORIGIN, "/");

try {
  const t = await token();
  const q = async body => {
    const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`, { method: "POST", headers: { authorization: "Bearer " + t, "content-type": "application/json" }, body: JSON.stringify({ rowLimit: 1000, ...body }) });
    if (!r.ok) throw new Error(`Search Console ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()).rows || [];
  };
  const end = addDays(iso(new Date()), -1), start = addDays(end, -20);
  const days = (await q({ startDate: start, endDate: end, dimensions: ["date"] })).map(r => ({ d: r.keys[0], c: r.clicks, i: r.impressions, p: r.position })).sort((a, b) => a.d.localeCompare(b.d));
  if (!days.length) {
    await telegram("📈 <b>לוחית בגוגל, עדכון יומי</b>\n\nעדיין אין נתוני חיפוש ב-Search Console. גוגל מתחיל להציג חשיפות אחרי כמה ימים מהגשת מפת האתר, והנתונים מתעכבים בכ-2 עד 3 ימים. אעדכן כשיופיעו.");
    process.exit(0);
  }
  const last = days[days.length - 1];
  const win = (a, b) => days.filter(x => x.d >= a && x.d <= b).reduce((s, x) => ({ c: s.c + x.c, i: s.i + x.i, pw: s.pw + x.p * x.i }), { c: 0, i: 0, pw: 0 });
  const cur = win(addDays(last.d, -6), last.d), prev = win(addDays(last.d, -13), addDays(last.d, -7));
  const prior7 = days.filter(x => x.d >= addDays(last.d, -7) && x.d < last.d);
  const avgPriorI = prior7.length ? prior7.reduce((s, x) => s + x.i, 0) / 7 : 0;
  const ctr = (c, i) => i ? (c / i * 100).toFixed(1) + "%" : "0%";
  const pos = w => w.i ? (w.pw / w.i).toFixed(1) : "-";
  const a7 = addDays(last.d, -6);
  const qs = (await q({ startDate: a7, endDate: last.d, dimensions: ["query"], rowLimit: 200 })).sort((x, y) => y.impressions - x.impressions).slice(0, 5);
  const pgAll = await q({ startDate: a7, endDate: last.d, dimensions: ["page"], rowLimit: 1000 });
  const pgs = [...pgAll].sort((x, y) => y.impressions - x.impressions).slice(0, 4);
  const sec = {}; for (const r of pgAll) { const k = sectionOf(r.keys[0]); sec[k] = (sec[k] || 0) + r.impressions; }
  const pageNo = w => w.i ? Math.ceil(Number(pos(w)) / 10) : null;
  const verdict = !cur.i ? "האתר עדיין לא מופיע בתוצאות החיפוש של גוגל."
    : !cur.c ? "האתר כבר מופיע בגוגל, אבל עדיין אף אחד לא נכנס דרכו. בתחילת הדרך זה צפוי."
    : `האתר מקבל כניסות מגוגל: ${n(cur.c)} ב-7 הימים האחרונים.`;
  const lines = [
    `📈 <b>לוחית בגוגל</b> · נתוני ${dm(last.d)}`,
    "<i>גוגל מעדכן בעיכוב של 2 עד 3 ימים</i>",
    "",
    `<b>${verdict}</b>`,
    "",
    "<b>7 ימים אחרונים</b>",
    `👀 הופענו בחיפוש: ${n(cur.i)} פעמים${arrow(pctChange(cur.i, prev.i))}`,
    `👆 נכנסו דרך גוגל: ${n(cur.c)}${arrow(pctChange(cur.c, prev.c))}`,
    `📍 מקום ממוצע: ${pos(cur)}${pageNo(cur) ? ` (עמוד ${pageNo(cur)} בתוצאות)` : ""}`,
    `🗓 ביום ${dm(last.d)} לבד: ${n(last.i)} הופעות, ${n(last.c)} כניסות`,
  ];
  if (qs.length) lines.push("", "<b>מה חיפשו כשהאתר הופיע</b>", ...qs.map(r => `• ${esc(r.keys[0])}: ${n(r.impressions)} פעמים${r.clicks ? `, ${n(r.clicks)} נכנסו` : ""}`));
  const secLine = SECTIONS.filter(([k]) => sec[k]).map(([k, l]) => `${l} ${n(sec[k])}`).join(" · ");
  if (secLine) lines.push("", `<b>באיזה דפים הופענו:</b> ${secLine}`);
  lines.push("", "<i>הופעה = האתר הוצג למישהו בתוצאות. כניסה = הוא לחץ עליו. עמוד ראשון בגוגל = מקומות 1 עד 10.</i>");
  const ok = await telegram(lines.join("\n"));
  process.exit(ok ? 0 : 1);
} catch (e) {
  const ok = await telegram(`⚠️ <b>הדוח היומי מ-Search Console לא הצליח לרוץ</b>\nהסיבה: ${esc(String(e.message || e).slice(0, 300))}\nהבדיקה תרוץ שוב מחר. אם זה חוזר, כנראה שחשבון השירות אינו מחובר לנכס luchit.app ב-Search Console (הרשאת Restricted מספיקה) או ש-Google Search Console API כבוי בפרויקט.`);
  process.exit(ok ? 0 : 1);
}
