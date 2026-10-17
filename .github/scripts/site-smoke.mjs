// End-to-end check of the live site (runs on GitHub: the dev container cannot reach luchit.app or data.gov.il).
// 1. static pages answer, 2. a real plate lookup works in a real browser, 3. TLS certificate and domain registration are not about to expire.
// Alerts go to Telegram only. DRY_RUN=1 prints instead of sending, PREVIEW=1 sends a labelled sample.
import tls from "node:tls";
import { flash } from "./flash.mjs";
import { ilTime } from "./notify.mjs";
const SITE = (process.env.SITE || "https://luchit.app/").replace(/\/?$/, "/"), HOST = new URL(SITE).hostname;
const DRY = process.env.DRY_RUN === "1", sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function telegram(text) {
  await flash("infra", "alert", text);
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (DRY || !token || !chat) { console.log("--- Telegram (" + (DRY ? "dry run" : "no credentials") + ") ---\n" + text); return DRY; }
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }) });
  if (!r.ok) console.log("telegram failed", r.status);
  return r.ok;
}
const alertText = items => `⚠️ <b>לוחית: בדיקת האתר החי מצאה בעיה</b>\nהבדיקה פותחת את luchit.app בדפדפן אמיתי, בודקת מספר רישוי אמיתי ואת הדפים החשובים, ובודקת מתי פוקעים הדומיין והאישור.\n\n${items.map(i => `❌ <b>${esc(i.title)}</b>\n${esc(i.detail)}\nהשפעה: ${esc(i.impact)}`).join("\n\n")}\n\nמה לעשות: ${items.some(i => i.renew) ? "לחדש את הדומיין אצל החברה שבה נרכש. " : ""}אם זו בעיה בדף או בבדיקת הרכב, כתבו לי ואבדוק. ייתכן שהיא זמנית ותיפתר לבד, ולכן הבדיקה כבר ניסתה פעמיים.\n\nזמן: ${ilTime()} (שעון ישראל)`;

if (process.env.PREVIEW === "1") {
  const ok = await telegram("🧪 <b>הודעת בדיקה, אין תקלה אמיתית</b>\n\n" + alertText([{ title: "בדיקת מספר רישוי בדפדפן (דוגמה)", detail: "בדיקת מספר רישוי לא החזירה תוצאה תוך 30 שניות.", impact: "משתמשים לא יוכלו לבדוק רכב." }, { title: "הדומיין פוקע בעוד 12 ימים (דוגמה)", detail: "תאריך פקיעה: 26.10.2026.", impact: "אם לא יחודש, האתר והקישורים באפליקציה יפסיקו לעבוד.", renew: true }]));
  process.exit(ok ? 0 : 1);
}

async function get(url, opt = {}) { const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20000), headers: { "user-agent": "luchit-smoke/1.0" }, ...opt }); return { r, t: await r.text() }; }

// ---- 1. static pages
async function pagesCheck() {
  const out = [];
  const need = async (name, url, test, impact) => { try { const { r, t } = await get(url); if (!r.ok) out.push({ title: name, detail: `${url} החזיר HTTP ${r.status}.`, impact }); else if (test && !test(t)) out.push({ title: name, detail: `${url} נפתח אבל התוכן לא כצפוי.`, impact }); } catch (e) { out.push({ title: name, detail: `${url} לא נענה (${e.name === "TimeoutError" ? "פג הזמן" : e.message}).`, impact }); } };
  await need("דף הבית", SITE, t => t.includes("לוחית") && t.includes('id="plate"'), "אף אחד לא יוכל לבדוק רכב באתר.");
  await need("דף המגזין", SITE + "magazine/", t => t.includes('id="nl"'), "אי אפשר להירשם למגזין.");
  await need("קובץ אימות הקישורים לאפליקציה", SITE + ".well-known/assetlinks.json", t => t.includes("com.ddsabag.pratirechev"), "קישורים של luchit.app לא יפתחו את האפליקציה.");
  await need("מדיניות הפרטיות", SITE + "privacy.html", t => t.includes("פרטיות"), "גוגל פליי דורש שהקישור לפרטיות יעבוד.");
  try { const { t } = await get(SITE + "sitemap.xml"); const u = (t.match(/<loc>([^<]*\/model\/[^<]*)<\/loc>/) || [])[1]; if (u) await need("דף דגם", u, t2 => t2.includes("לוחית"), "דפי הדגם (מקור עיקרי לכניסות מגוגל) לא נפתחים."); else out.push({ title: "מפת האתר", detail: "לא נמצאו בה דפי דגם.", impact: "גוגל לא יאנדקס את דפי הדגם." }); }
  catch (e) { out.push({ title: "מפת האתר", detail: `sitemap.xml לא נפתח (${e.message}).`, impact: "גוגל לא יאנדקס את הדפים." }); }
  return out;
}

// ---- 2. a real lookup in a real browser, with a plate taken from the ministry's active register
async function lookupCheck() {
  let plate = "38548003";
  try { const { t } = await get("https://data.gov.il/api/3/action/datastore_search?resource_id=053cea08-09bc-40ec-8f7a-156f0677aff3&limit=1&offset=500&filters=" + encodeURIComponent(JSON.stringify({ shnat_yitzur: 2018 }))); const p = JSON.parse(t).result.records[0].mispar_rechev; if (p) plate = String(p); } catch {}
  const { chromium } = await import("playwright");
  const b = await chromium.launch(); const errs = [];
  try {
    const ctx = await b.newContext({ viewport: { width: 390, height: 800 }, locale: "he-IL" });
    await ctx.addInitScript(() => { try { localStorage.setItem("analyticsOff", "1"); } catch {} });   // a test lookup must not count as a real one on /live
    const page = await ctx.newPage();
    page.on("pageerror", e => errs.push(String(e).slice(0, 120)));
    await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.fill("#plate", plate); await page.click("#go");
    const t0 = Date.now();
    await page.waitForFunction(() => { const o = document.querySelector("#out"); return o && (o.querySelector(".msg.edge") || /סקירה/.test(o.innerText)); }, null, { timeout: 40000 });
    const bad = await page.evaluate(() => { const m = document.querySelector("#out .msg.edge"); return m ? m.innerText.slice(0, 80) : ""; });
    if (bad) return { title: "בדיקת מספר רישוי בדפדפן", detail: `מספר ${plate} החזיר: "${bad}".`, impact: "משתמשים יראו הודעת שגיאה במקום תוצאת בדיקה (אם זו תקלה זמנית של משרד התחבורה, היא תחלוף בעצמה)." };
    console.log(`lookup ok in ${Date.now() - t0}ms for ${plate}`);
    if (errs.length) console.log("page errors:", errs.join(" | "));
    return null;
  } catch (e) { return { title: "בדיקת מספר רישוי בדפדפן", detail: `בדיקת מספר ${plate} לא החזירה תוצאה (${e.name === "TimeoutError" ? "פג הזמן, 40 שניות" : e.message.slice(0, 100)}).`, impact: "משתמשים לא יוכלו לבדוק רכב." }; }
  finally { await b.close(); }
}

// ---- 3. certificate + domain registration expiry
const certDays = () => new Promise((res, rej) => { const s = tls.connect({ host: HOST, port: 443, servername: HOST }, () => { const c = s.getPeerCertificate(); s.end(); res({ days: Math.floor((new Date(c.valid_to) - Date.now()) / 864e5), to: new Date(c.valid_to) }); }); s.on("error", rej); s.setTimeout(15000, () => { s.destroy(); rej(new Error("timeout")); }); });
async function expiryCheck() {
  const out = [], d = x => new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" }).format(x);
  try { const c = await certDays(); console.log("cert days left:", c.days); if (c.days < 14) out.push({ title: `אישור האבטחה (SSL) פוקע בעוד ${c.days} ימים`, detail: `תאריך: ${d(c.to)}. בדרך כלל Cloudflare מחדש אותו לבד, ולכן זו חריגה.`, impact: "הדפדפן יציג אזהרת אבטחה ומשתמשים לא ייכנסו לאתר." }); }
  catch (e) { out.push({ title: "אי אפשר היה לבדוק את אישור האבטחה", detail: e.message, impact: "לא ידוע אם האישור תקין." }); }
  try {
    const { r, t } = await get("https://rdap.org/domain/" + HOST, { headers: { accept: "application/rdap+json", "user-agent": "luchit-smoke/1.0" } });
    if (!r.ok) throw new Error("RDAP HTTP " + r.status);
    const ev = (JSON.parse(t).events || []).find(e => e.eventAction === "expiration"); if (!ev) throw new Error("אין תאריך פקיעה בתשובה");
    const exp = new Date(ev.eventDate), days = Math.floor((exp - Date.now()) / 864e5); console.log("domain days left:", days);
    if (days < 30) out.push({ title: `הדומיין ${HOST} פוקע בעוד ${days} ימים`, detail: `תאריך פקיעה: ${d(exp)}.`, impact: "אם לא יחודש, האתר והקישורים באפליקציה יפסיקו לעבוד.", renew: true });
  } catch (e) { console.log("domain expiry not checked:", e.message); }
  return out;
}

const delay = process.env.GITHUB_EVENT_NAME === "push" ? 180000 : 0;
if (delay) { console.log("push run: waiting for GitHub Pages to publish"); await sleep(delay); }
let problems = [];
for (let attempt = 1; attempt <= 2; attempt++) {
  problems = [...(await pagesCheck()), ...[await lookupCheck()].filter(Boolean)];
  if (!problems.length) break;
  if (attempt < 2) { console.log("attempt 1 found", problems.length, "problem(s):", JSON.stringify(problems.map(p => p.title)), "- retrying in 60s"); await sleep(60000); }
}
problems.push(...(await expiryCheck()));
if (!problems.length) { console.log("all checks passed"); process.exit(0); }
console.log(JSON.stringify(problems, null, 1));
process.exit((await telegram(alertText(problems))) ? 0 : 1);
