// End-to-end check of the live site (runs on GitHub: the dev container cannot reach luchit.app or data.gov.il).
// 1. static pages answer, and the share path works: a compare link and a car link get their WhatsApp preview, a /go/ link its 302 with the
//    campaign tags (luchit-og rewrites the page's meta tags, so a web deploy can break it while the home page still answers 200),
// 2. a real plate lookup works in a real browser, 3. TLS certificate and domain registration are not about to expire.
// No plate is printed: the run log is public, and the alert text also goes to the public flashes branch.
// Alerts go to Telegram only. DRY_RUN=1 prints instead of sending, PREVIEW=1 sends a labelled sample.
// A push run first waits 3 minutes for the deploy.
// In the daily run INFRA_REPORT carries what the infra part (infra-watch.mjs, INFRA_HANDOFF=1) found, as JSON {alert, notice}: it goes out in the same
// Telegram message as this check's findings (one morning message), and gets its own line on /live as before. Empty when the infra part did not run.
import fs from "node:fs";
import tls from "node:tls";
import { flash } from "./flash.mjs";
import { ministryDown } from "./datasets.mjs";
import { msg, heError } from "./tg-text.mjs";
const SITE = (process.env.SITE || "https://luchit.app/").replace(/\/?$/, "/"), HOST = new URL(SITE).hostname;
const DRY = process.env.DRY_RUN === "1", sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// a raw error (HTTP code, e.message) -> one Hebrew sentence; the raw text goes to the item's folded detail
const he = raw => heError(raw).split("\n<blockquote")[0].replace(/\.$/, "");

async function telegram(text, silent = false) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (DRY || !token || !chat) { console.log("--- Telegram (" + (DRY ? "dry run" : "no credentials") + ") ---\n" + text); return DRY; }
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, ...(silent ? { disable_notification: true } : {}) }) });
  if (!r.ok) console.log("telegram failed", r.status);
  return r.ok;
}
// through the alert router (alert.mjs): this check's findings as smoke:<ids> (expiry:<ids> when only renewals are due), the infra part under its
// own key; the router dedupes repeats and rings by level. The direct send stays the fallback (legacy). /live gets one line per finding as before.
let router = null;
async function route(level, key, text, silent) {
  if (!router) try { router = await import("./alert.mjs"); } catch { router = false; }
  if (!router) return telegram(text, silent);
  return !!(await router.alert(level, key, text, RUN_URL, { today: silent ? "silent" : "loud", legacy: () => telegram(text, silent) })).delivered;
}
const RUN_URL = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : "";
const RENEW = ["cert", "domain", "certcheck"];
async function send(items, infra, quiet = false) {
  const own = items.length ? alertText(items) : "", infraText = infra.alert || infra.notice || "";
  if (own) await flash("infra", "alert", own);
  if (infraText && await flash("infra", infra.alert ? "alert" : "info", infraText)) markOutput("infra_flashed=1");   // the fallback step must not add it to /live again
  let ok = true;
  if (own) {
    const ids = [...new Set(items.map(i => i.id || "page"))].sort(), fam = ids.every(i => RENEW.includes(i)) ? "expiry" : "smoke";
    ok = await route(items.some(i => i.urgent) ? "critical" : "day", `${fam}:${ids.join("+")}`, own, quiet);
  }
  if (infraText) {
    const silent = !infra.alert, sent = await route(infra.level || (silent ? "summary" : "day"), infra.key || (silent ? "infra-branches" : "infra:site"), infraText, silent);
    if (sent) markOutput("infra_sent=1");
    ok = ok && (sent || silent);   // the monthly branch list alone is a silent notice: not delivering it never failed the run
  }
  return ok;
}
const markOutput = line => { if (process.env.GITHUB_OUTPUT) try { fs.appendFileSync(process.env.GITHUB_OUTPUT, line + "\n"); } catch {} };
let infra = {};
try { infra = JSON.parse(process.env.INFRA_REPORT || "{}") || {}; } catch (e) { console.log("INFRA_REPORT unreadable:", e.message); infra = {}; }
if (infra.alert || infra.notice) console.log("infra part handed over:", infra.alert ? "an alert" : "the monthly branch list");
// one message for all findings: 🔴 when users feel it now (the home page, a car lookup, a domain or certificate about to lapse), else 🟠
const alertText = items => msg({ kind: items.some(i => i.urgent) ? "urgent" : "today", area: "site",
  title: items.length === 1 ? "בדיקת האתר החי מצאה בעיה" : `בדיקת האתר החי מצאה ${items.length} בעיות`,
  text: items.map(i => `• <b>${esc(i.title)}</b>: ${esc(i.detail)} ${esc(i.impact)}`).join("\n") + "\nבעיה בדף או בבדיקת הרכב נבדקה פעמיים, דקה בהפרש, ולכן היא לא תקלה של רגע.",
  what: (items.some(i => i.renew) ? "לחדש את הדומיין אצל החברה שבה נרכש. " : "") + 'אם זו בעיה בדף או בבדיקת הרכב, לכתוב בשרשור "מוצר ושחרורים".',
  raw: items.map(i => i.raw).filter(Boolean).join(" · ") })

if (process.env.PREVIEW === "1") {
  const sample = "🧪 <b>הודעת בדיקה, אין תקלה אמיתית</b>\n\n" + alertText([{ title: "בדיקת מספר רישוי בדפדפן (דוגמה)", detail: "בדיקת מספר רישוי לא החזירה תוצאה תוך 30 שניות.", impact: "משתמשים לא יוכלו לבדוק רכב.", urgent: true, raw: "TimeoutError" }, { title: "הדומיין פוקע בעוד 12 ימים (דוגמה)", detail: "תאריך פקיעה: 26.10.2026.", impact: "אם לא יחודש, האתר והקישורים באפליקציה יפסיקו לעבוד.", renew: true }]);
  await flash("infra", "alert", sample);   // as before: flash() drops sample texts ("הודעת בדיקה"), so /live gets nothing
  const ok = await telegram(sample);
  process.exit(ok ? 0 : 1);
}

async function get(url, opt = {}) { const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20000), headers: { "user-agent": "luchit-smoke/1.0" }, ...opt }); return { r, t: await r.text() }; }

// ---- 1. static pages
async function pagesCheck() {
  const out = [];
  const need = async (name, url, test, impact, urgent = false, id = "page") => { try { const { r, t } = await get(url); if (!r.ok) out.push({ id, title: name, detail: `הדף לא נפתח: ${he(`HTTP ${r.status}`)}.`, impact, urgent, raw: `${url} HTTP ${r.status}` }); else if (test && !test(t)) out.push({ id, title: name, detail: "הדף נפתח, אבל התוכן לא כצפוי.", impact, urgent, raw: url }); } catch (e) { out.push({ id, title: name, detail: `הדף לא ענה: ${he(e.name === "TimeoutError" ? "timeout" : e.message)}.`, impact, urgent, raw: `${url} ${e.name}: ${String(e.message).slice(0, 100)}` }); } };
  await need("דף הבית", SITE, t => t.includes("לוחית") && t.includes('id="plate"'), "אף אחד לא יוכל לבדוק רכב באתר.", true, "home");
  await need("דף המגזין", SITE + "magazine/", t => t.includes('id="nl"'), "אי אפשר להירשם למגזין.", false, "magazine");
  await need("קובץ אימות הקישורים לאפליקציה", SITE + ".well-known/assetlinks.json", t => t.includes("com.ddsabag.pratirechev"), "קישורים של luchit.app לא יפתחו את האפליקציה.", false, "applinks");
  await need("מדיניות הפרטיות", SITE + "privacy.html", t => t.includes("פרטיות"), "גוגל פליי דורש שהקישור לפרטיות יעבוד.", false, "privacy");
  try { const { t } = await get(SITE + "sitemap.xml"); const u = (t.match(/<loc>([^<]*\/model\/[^<]*)<\/loc>/) || [])[1]; if (u) await need("דף דגם", u, t2 => t2.includes("לוחית"), "דפי הדגם (מקור עיקרי לכניסות מגוגל) לא נפתחים.", false, "model"); else out.push({ id: "sitemap", title: "מפת האתר", detail: "לא נמצאו בה דפי דגם.", impact: "גוגל לא יאנדקס את דפי הדגם." }); }
  catch (e) { out.push({ id: "sitemap", title: "מפת האתר", detail: `מפת האתר לא נפתחה: ${he(e.message)}.`, impact: "גוגל לא יאנדקס את הדפים.", raw: `sitemap.xml: ${String(e.message).slice(0, 100)}` }); }
  out.push(...await shareCheck());
  return out;
}

// ---- 1b. the share path, as a messaging app sees it (the same URLs the Workers deploy checks, .github/ship-tail.json)
const WA = "WhatsApp/2.23.20.0 A", ogTitle = t => ((t.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/) || [])[1] || "");
async function shareCheck() {
  const out = [], st = "&st=" + Date.now();
  try {
    const { r, t } = await get(SITE + "?cmp=W3t9LHt9XQ" + st, { headers: { "user-agent": WA } });
    if (!r.ok || !ogTitle(t).includes("השוואת 2 רכבים בלוחית")) out.push({ id: "og", title: "תצוגה מקדימה של קישור השוואה", detail: "קישור השוואה לא קיבל את הכותרת \"השוואת 2 רכבים בלוחית\".", impact: "קישורים שנשלחים בוואטסאפ יופיעו בלי תצוגה מקדימה. כנראה תקלה בשירות התצוגה המקדימה.", raw: `cmp HTTP ${r.status}, og:title "${ogTitle(t).slice(0, 60)}", Worker luchit-og / luchit.app/*` });
  } catch (e) { out.push({ id: "og", title: "תצוגה מקדימה של קישור השוואה", detail: `הבקשה נכשלה: ${he(e.message)}.`, impact: "קישורים שנשלחים בוואטסאפ יופיעו בלי תצוגה מקדימה.", raw: `cmp: ${e.message.slice(0, 80)}` }); }
  try {
    const r = await fetch(SITE + "go/wa?c=probe" + st, { redirect: "manual", signal: AbortSignal.timeout(20000), headers: { "user-agent": "luchit-smoke/1.0" } });
    const loc = r.headers.get("location") || "";
    if (r.status !== 302 || !loc.includes("utm_source=whatsapp")) out.push({ id: "go", title: "קישורי הקמפיין (פוסטים וביו)", detail: "קישור קמפיין לוואטסאפ לא הפנה כמו שצריך.", impact: "קישורי הקמפיין לא ייפתחו או לא ייספרו לפי מקור. כנראה תקלה בשירות התצוגה המקדימה.", raw: `/go/wa HTTP ${r.status}${loc ? " -> " + loc.slice(0, 80) : ""}, expected 302 with utm_source=whatsapp, Worker luchit-og` });
  } catch (e) { out.push({ id: "go", title: "קישורי הקמפיין (פוסטים וביו)", detail: `הבקשה נכשלה: ${he(e.message)}.`, impact: "קישורי הקמפיין לא ייפתחו.", raw: `/go/wa: ${e.message.slice(0, 80)}` }); }
  // once a day: a car link names the car (the preview's own 2.5 s ministry budget), with the app's public example plate
  if (process.env.GITHUB_EVENT_NAME !== "push") try {
    const html = await get(SITE).then(x => x.t), ex = (html.match(/const EXAMPLE_PLATE = "(\d+)"/) || [])[1];
    if (ex) { const { t } = await get(SITE + "?plate=" + ex + st, { headers: { "user-agent": WA } }); if (!ogTitle(t).includes(" · ")) out.push({ id: "carlink", ministry: true, title: "תצוגה מקדימה של קישור לרכב", detail: "קישור לרכב הדוגמה קיבל כותרת כללית במקום שם הרכב.", impact: "רכב שנשלח בוואטסאפ יופיע בלי שם ובלי מצב הטסט. ייתכן שמשרד התחבורה איטי כרגע; אם זה חוזר מחר, זו תקלה בשירות התצוגה המקדימה.", raw: `og:title "${ogTitle(t).slice(0, 60)}", Worker luchit-og` }); }
  } catch (e) { console.log("car preview not checked:", e.message.slice(0, 80)); }
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
    if (bad) return { id: "lookup", ministry: true, urgent: true, title: "בדיקת מספר רישוי בדפדפן", detail: `רכב מהמאגר החזיר: "${bad}".`, impact: "משתמשים יראו הודעת שגיאה במקום תוצאת בדיקה (אם זו תקלה זמנית של משרד התחבורה, היא תחלוף בעצמה)." };
    console.log(`lookup ok in ${Date.now() - t0}ms`);
    if (errs.length) console.log("page errors:", errs.join(" | "));
    return null;
  } catch (e) { return { id: "lookup", ministry: true, urgent: true, title: "בדיקת מספר רישוי בדפדפן", detail: `בדיקת רכב מהמאגר לא החזירה תוצאה (${e.name === "TimeoutError" ? "פג הזמן, 40 שניות" : he(e.message)}).`, impact: "משתמשים לא יוכלו לבדוק רכב.", raw: `${e.name}: ${String(e.message).slice(0, 100)}` }; }
  finally { await b.close(); }
}

// ---- 3. certificate + domain registration expiry
const certDays = () => new Promise((res, rej) => { const s = tls.connect({ host: HOST, port: 443, servername: HOST }, () => { const c = s.getPeerCertificate(); s.end(); res({ days: Math.floor((new Date(c.valid_to) - Date.now()) / 864e5), to: new Date(c.valid_to) }); }); s.on("error", rej); s.setTimeout(15000, () => { s.destroy(); rej(new Error("timeout")); }); });
async function expiryCheck() {
  const out = [], d = x => new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" }).format(x);
  try { const c = await certDays(); console.log("cert days left:", c.days); if (c.days < 14) out.push({ id: "cert", urgent: c.days < 7, title: `אישור האבטחה (SSL) פוקע בעוד ${c.days} ימים`, detail: `תאריך: ${d(c.to)}. בדרך כלל Cloudflare מחדש אותו לבד, ולכן זו חריגה.`, impact: "הדפדפן יציג אזהרת אבטחה ומשתמשים לא ייכנסו לאתר." }); }
  catch (e) { out.push({ id: "certcheck", title: "אי אפשר היה לבדוק את אישור האבטחה", detail: `${he(e.message)}.`, impact: "לא ידוע אם האישור תקין.", raw: `TLS: ${String(e.message).slice(0, 100)}` }); }
  try {
    const { r, t } = await get("https://rdap.org/domain/" + HOST, { headers: { accept: "application/rdap+json", "user-agent": "luchit-smoke/1.0" } });
    if (!r.ok) throw new Error("RDAP HTTP " + r.status);
    const ev = (JSON.parse(t).events || []).find(e => e.eventAction === "expiration"); if (!ev) throw new Error("אין תאריך פקיעה בתשובה");
    const exp = new Date(ev.eventDate), days = Math.floor((exp - Date.now()) / 864e5); console.log("domain days left:", days);
    if (days < 30) out.push({ id: "domain", urgent: days < 7, title: `הדומיין ${HOST} פוקע בעוד ${days} ימים`, detail: `תאריך פקיעה: ${d(exp)}.`, impact: "אם לא יחודש, האתר והקישורים באפליקציה יפסיקו לעבוד.", renew: true });
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
// a car lookup or car-link preview that failed while Ministry watch found the active register down this morning: the same outage it already
// rang for. Each such finding says so, and when they are all there is, the daily run sends silently (after a deploy it still rings: the new
// page may be the cause)
let quiet = false;
if (problems.some(p => p.ministry)) {
  const down = (await ministryDown()) || [], active = down.find(d => d.key === "active");
  if (active) {
    for (const p of problems) if (p.ministry) { p.detail += ` שומר מאגרי משרד התחבורה כבר דיווח הבוקר שהמאגר "${active.title}" לא ענה, כנראה זו אותה תקלה.`; p.urgent = false; }
    quiet = process.env.GITHUB_EVENT_NAME === "schedule" && problems.every(p => p.ministry);
    console.log("same outage Ministry watch reported" + (quiet ? ": sent silently" : ""));
  }
}
if (!problems.length) console.log("all checks passed"); else console.log(JSON.stringify(problems, null, 1));
if (!problems.length && !infra.alert && !infra.notice) process.exit(0);
process.exit((await send(problems, infra, quiet)) ? 0 : 1);
