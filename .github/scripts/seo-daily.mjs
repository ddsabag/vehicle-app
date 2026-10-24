// Daily Google Search digest to Telegram: impressions, clicks, CTR, position, top queries and pages, split by page type.
// Search Console numbers arrive about 2-3 days late, so the digest reports the latest day that has data and says which day it is.
// DRY_RUN=1 prints instead of sending, with every digit masked (the Actions log is public: no business numbers in it). Alerts and digest go to Telegram only.
// Mondays: SEO_WEEKLY names a file with the weekly ranking report (analytics/seo_track.py --out, the job before this one); it is added at the end of
// the digest, so Monday has one SEO message. Too long for one Telegram message, or the digest itself failed: the weekly part goes as its own silent message.
import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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
async function telegram(text, silent = false) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (DRY || !tok || !chat) { console.log("--- Telegram (" + (DRY ? "dry run" : "no credentials") + ", digits masked) ---\n" + String(text).replace(/\d/g, "#")); return DRY; }
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, disable_notification: silent }) });
  if (!r.ok) console.log("telegram failed", r.status);
  return r.ok;
}
let WEEKLY = "";   // the Monday weekly ranking report, plain text ("" on other days)
if (process.env.SEO_WEEKLY) { try { WEEKLY = readFileSync(process.env.SEO_WEEKLY, "utf8").trim(); } catch (e) { console.log("no weekly report:", e.message); } }
const weeklyAlone = () => telegram(esc(WEEKLY), true);   // silent, like the SEO tracker message it replaces
// Re-run of a Monday run whose daily part was already delivered (Re-run failed jobs also re-runs this job when the weekly part failed):
// SEO_DIGEST_SENT=1 sends only the weekly report, as re-running SEO tracker did, never the same digest twice (also a manual weekly_only run, as running SEO tracker did). SEO_SENT_MARK names the file
// written once the daily part is delivered (the workflow keeps it for the run's later attempts).
const markSent = () => { if (process.env.SEO_SENT_MARK && !DRY) try { writeFileSync(process.env.SEO_SENT_MARK, new Date().toISOString()); } catch (e) { console.log("could not mark the digest sent:", e.message); } };
if (process.env.SEO_DIGEST_SENT === "1") {
  if (!WEEKLY) { console.log("the digest was already sent in an earlier attempt of this run (or a manual weekly_only run) and there is no weekly report: nothing to send"); process.exit(0); }
  console.log("the digest was already sent in an earlier attempt of this run (or a manual weekly_only run): sending only the weekly report");
  process.exit((await weeklyAlone()) ? 0 : 1);
}
// the digest with the weekly report at the end; split in two when that is longer than one Telegram message (4096 characters)
async function sendDigest(text, silent) {
  const one = WEEKLY ? text + "\n\n" + esc(WEEKLY) : text;
  if (!WEEKLY || one.length <= 4000) { const ok = await telegram(one, silent); if (ok) markSent(); return ok; }
  const a = await telegram(text, silent);
  if (a) markSent();
  return (await weeklyAlone()) && a;
}
const iso = d => d.toISOString().slice(0, 10), addDays = (s, n) => iso(new Date(Date.parse(s + "T00:00:00Z") + n * 864e5));
const dm = s => s.slice(8) + "." + s.slice(5, 7);
const n = x => Math.round(x).toLocaleString("en-US");
const pctChange = (a, b) => b ? Math.round((a - b) / b * 100) : null;
const arrow = c => c === null ? "" : c > 0 ? ` (▲ ${c}%)` : c < 0 ? ` (▼ ${Math.abs(c)}%)` : " (ללא שינוי)";
const SECTIONS = [["model", "דפי דגמים"], ["magazine", "מגזין"], ["guide", "מדריכים"], ["home", "דף הבית"]];
const sectionOf = u => { const p = u.replace(ORIGIN, "/"); return p.startsWith("/model") ? "model" : p.startsWith("/magazine") ? "magazine" : p.startsWith("/guide") ? "guide" : p === "/" ? "home" : "other"; };
const pagePath = u => u.replace(ORIGIN, "/");

// Cloudflare Web Analytics keeps luchit.app as two sites (the home page's own beacon, and the one Cloudflare adds to every page; a page reports
// through one of them only), so both are counted, without the owner's /live screen and without automated browsers (headless Chrome). Days
// are Israel days, like the rest of the reports.
const CF_SITES = ["03eb6fb7a75440649781d7a00b29c4ff", "5c0a33a14f5f4201b25fd680a29ae723"];
const ilDay = t => new Date(t).toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
const ilStart = day => { for (const h of [3, 2]) { const t = Date.parse(day + "T00:00:00Z") - h * 3600e3; if (ilDay(t) === day && ilDay(t - 1) !== day) return new Date(t).toISOString(); } return day + "T00:00:00Z"; };
async function cfVisits(day) {   // real visits to the site on one Israel day, from Cloudflare Web Analytics; null when unavailable (never a made-up 0)
  const tok = process.env.CF_API_TOKEN, acc = process.env.CF_ACCOUNT_ID;
  if (!tok || !acc) return null;
  try {
    const qry = "query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){rumPageloadEventsAdaptiveGroups(filter:$f,limit:1){count sum{visits}}}}}";
    const f = { AND: [{ datetime_geq: ilStart(day), datetime_lt: ilStart(addDays(day, 1)) }, { siteTag_in: CF_SITES }, { requestPath_notlike: "/live%" }, { userAgentBrowser_neq: "ChromeHeadless" }] };
    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify({ query: qry, variables: { acc, f } }) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.errors) { console.log("cloudflare visits unavailable:", r.status); return null; }
    const g = j.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups?.[0];
    return g ? Math.round(g.sum.visits) : 0;
  } catch { return null; }
}
async function sitemapCount() {
  try { const x = await (await fetch("https://luchit.app/sitemap.xml")).text(); return (x.match(/<loc>/g) || []).length || null; } catch { return null; }
}

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
    const ok = await sendDigest("📈 <b>לוחית בגוגל, עדכון יומי</b>\n\nעדיין אין נתוני חיפוש ב-Search Console. גוגל מתחיל להציג חשיפות אחרי כמה ימים מהגשת מפת האתר, והנתונים מתעכבים בכ-2 עד 3 ימים. אעדכן כשיופיעו.", true);
    process.exit(WEEKLY && !ok ? 1 : 0);   // a weekly report that was not delivered fails the run (and its state is not saved), as SEO tracker did
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
  const seen28 = new Set((await q({ startDate: addDays(last.d, -27), endDate: last.d, dimensions: ["page"], rowLimit: 1000 })).map(r => r.keys[0]));
  const total = await sitemapCount();
  const older = new Set((await q({ startDate: addDays(last.d, -27), endDate: addDays(last.d, -7), dimensions: ["query"], rowLimit: 1000 })).map(r => r.keys[0]));
  const fresh = (await q({ startDate: a7, endDate: last.d, dimensions: ["query"], rowLimit: 1000 })).filter(r => !older.has(r.keys[0])).sort((x, y) => y.impressions - x.impressions).slice(0, 3);
  const yday = addDays(ilDay(Date.now()), -1), visits = await cfVisits(yday);
  const topClick = [...pgAll].filter(r => r.clicks > 0).sort((x, y) => y.clicks - x.clicks)[0];
  const sunday = new Date().getUTCDay() === 0;
  const pageNo = w => w.i ? Math.ceil(Number(pos(w)) / 10) : null;
  const verdict = !cur.i ? "האתר עדיין לא מופיע בתוצאות החיפוש של גוגל."
    : !cur.c ? "האתר כבר מופיע בגוגל, אבל עדיין אף אחד לא נכנס דרכו. בתחילת הדרך זה צפוי."
    : `האתר מקבל כניסות מגוגל: ${n(cur.c)} ב-7 הימים האחרונים.`;
  // Daily view: the verdict, four numbers, and only what changed. Position, page-type split and the glossary are for Sundays.
  const lines = [
    `📈 <b>לוחית בגוגל</b> · נתוני ${dm(last.d)} <i>(גוגל מתעכב 2 עד 3 ימים)</i>`,
    "",
    `<b>${verdict}</b>`,
    "",
    `👀 הופענו בחיפוש: ${n(cur.i)}${arrow(pctChange(cur.i, prev.i))} <i>(7 ימים)</i>`,
    `👆 נכנסו דרך גוגל: ${n(cur.c)}${arrow(pctChange(cur.c, prev.c))}`,
    `📚 דפים שגוגל מציג: ${n(seen28.size)}${total ? ` מתוך ${n(total)}` : ""}`,
  ];
  if (visits !== null) lines.push(`🌐 ביקורים באתר אתמול, מכל המקורות: ${n(visits)}`);
  if (qs.length) lines.push("", "<b>מה חיפשו כשהאתר הופיע</b>", ...qs.slice(0, 3).map(r => `• ${esc(r.keys[0])}: ${n(r.impressions)}${r.clicks ? `, ${n(r.clicks)} נכנסו` : ""}`));
  if (fresh.length) lines.push("", "<b>חדש השבוע</b>", ...fresh.map(r => `• ${esc(r.keys[0])}: ${n(r.impressions)}`));
  if (topClick) lines.push("", `<b>הדף שהכניס הכי הרבה:</b> ${esc(pagePath(topClick.keys[0]))} (${n(topClick.clicks)})`);
  if (sunday) {
    lines.push("", "<b>סיכום שבועי</b>", `📍 מקום ממוצע: ${pos(cur)}${pageNo(cur) ? ` (עמוד ${pageNo(cur)} בתוצאות)` : ""}`);
    const secLine = SECTIONS.filter(([k]) => sec[k]).map(([k, l]) => `${l} ${n(sec[k])}`).join(" · ");
    if (secLine) lines.push(`הופענו לפי סוג דף: ${secLine}`);
    lines.push("", "<i>הופעה = האתר הוצג למישהו בתוצאות. כניסה = הוא לחץ עליו. עמוד ראשון בגוגל = מקומות 1 עד 10.</i>");
  }
  const ok = await sendDigest(lines.join("\n"), true);
  process.exit(ok ? 0 : 1);
} catch (e) {
  let ok = await telegram(`⚠️ <b>הדוח היומי מ-Search Console לא הצליח לרוץ</b>\nהסיבה: ${esc(String(e.message || e).slice(0, 300))}\nהבדיקה תרוץ שוב מחר. אם זה חוזר, כנראה שחשבון השירות אינו מחובר לנכס luchit.app ב-Search Console (הרשאת Restricted מספיקה) או ש-Google Search Console API כבוי בפרויקט.`);
  if (ok) markSent();   // that error message stands for the day's digest: a re-run sends only the weekly report
  if (WEEKLY) ok = (await weeklyAlone()) && ok;   // the weekly report was built by its own job: still deliver it, silently and apart from the loud error
  process.exit(ok ? 0 : 1);
}
