// Alerts (Telegram) on new 1-3 star Google Play reviews from the last 7 days, and when Play vitals cross Google's "bad behavior" thresholds.
import { ilTime } from "./notify.mjs";
import { flash } from "./flash.mjs";
import { tag, todo, folded, heErrors, msg } from "./tg-text.mjs";
// Env: PLAY_SERVICE_ACCOUNT_JSON (falls back to GA_SERVICE_ACCOUNT_JSON), TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
//      optional PLAY_PACKAGE, PLAY_DEVELOPER_ID + PLAY_APP_ID (for a deep link into Play Console), MAX_STARS (default 3), DRY_RUN=1.
//      ALERT_UPTIME_URL (repo variable): luchit-reviews lives on the same workers.dev subdomain as luchit-uptime. When its /health shows
//      Telegram, the key and a working Play list (a tick within 12 h), the Worker announces every review with a reply draft, so the review
//      alerts here are skipped (no double announcement). Anything else (no variable, no answer, a failing list) and they go out as before,
//      so no review is silent. REVIEWS_RESPONDER=off (repo variable) always sends them here. The list, the weekly snapshot, vitals and the
//      error alerts never depend on it.
// State: seen.json (restored/saved by the workflow cache) so the same review is never sent twice, plus the error streak (errOn).
import fs from "node:fs";
import crypto from "node:crypto";
// Google answers 503 now and then; retry server errors a few times before reporting a failed check
const rf = async (u, o) => { for (let i = 0; i < 3; i++) { const r = await fetch(u, o); if (r.status < 500) return r; await new Promise(s => setTimeout(s, 4000 * (i + 1))); } return fetch(u, o); };
const PKG = process.env.PLAY_PACKAGE || "com.ddsabag.pratirechev", MAX_STARS = +(process.env.MAX_STARS || 3), DRY = process.env.DRY_RUN === "1";
const STATE = process.env.STATE_FILE || "seen.json";
const sa = JSON.parse(process.env.PLAY_SERVICE_ACCOUNT_JSON || process.env.GA_SERVICE_ACCOUNT_JSON || "null");
if (!sa) { console.log("no service account secret, nothing to do"); process.exit(0); }

const b64 = b => Buffer.from(b).toString("base64url");
async function token(scope) {
  const now = Math.floor(Date.now() / 1000), head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64(JSON.stringify({ iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 }));
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) });
  if (!r.ok) throw new Error("auth " + r.status);
  return (await r.json()).access_token;
}
const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// since: when the checks started failing, set only on the daily reminder of an error that keeps coming back
const errText = (errors, since) => `${tag(since ? "today" : "info", "reviews")}\n<b>בדיקת הביקורות והקריסות בגוגל פליי לא הצליחה לרוץ</b>\n` +
  `לכן לא ידוע אם יש ביקורות או קריסות חדשות. זה לא אומר שיש בעיה באפליקציה.\n` +
  heErrors(errors, { reviews: "הביקורות", vitals: "שיעור הקריסות" }).replace(/\n<blockquote/, "\n" + (since ? `נמשך מאז ${ilTime(new Date(since))}, תזכורת פעם ביום.\n` : "") + todo(since ? "זה לא עובר מעצמו. לכתוב לי בשרשור \"תפעול, בוטים ומייל\"." : "") + "\n<blockquote") +
  `\n${ilTime()}`;
// true when Telegram took the message (or a dry run printed it). A failed send is only logged, never fails the run; an alert with a
// state key is tried again on the next run, and its /live flash ("f:" + key) goes out once, not on every retry.
// The flash branch and the job log are public: flashText is the alert without business numbers (default: the text itself), and a dry
// run prints the text with every digit masked.
// route = [level, router key]: the alert router (alert.mjs) decides when it reaches Telegram (night items wait for the morning, summary items
// go to the Sunday summary, a repeat within 24 h is deduped); without the router, or when it hands back, the direct send below runs as before.
async function telegram(text, silent = false, key = "", flashText = text, route = null) {
  if (!key || !seen["f:" + key]) { await flash("reviews", silent ? "info" : "alert", flashText); if (key) seen["f:" + key] = Date.now(); }
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (DRY || !tok || !chat) { console.log("--- Telegram (" + (DRY ? "dry run" : "no credentials") + ", digits masked) ---\n" + String(text).replace(/\d/g, "#")); return DRY; }
  if (route) {
    let router = null; try { router = await import("./alert.mjs"); } catch {}
    if (router) { const r = await router.alert(route[0], route[1], text, "", { today: silent ? "silent" : "loud", legacy: () => direct(text, silent, key) }); return !!r?.delivered; }
  }
  return direct(text, silent, key);
}
async function direct(text, silent, key) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  try {
    const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, disable_notification: silent }) });
    if (r.ok) { if (key) delete seen["f:" + key]; return true; }
    console.log(`::warning::Telegram send failed (${r.status}), retried next run: ${(await r.text()).slice(0, 200)}`);
  } catch (e) { console.log(`::warning::Telegram send failed (${e.message}), retried next run`); }
  return false;
}
let seen = {}; try { seen = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}
if (process.env.PREVIEW === "1") { await telegram("🧪 <b>הודעת בדיקה, אין תקלה אמיתית</b>\n\n" + errText(["vitals: vitals crashRateMetricSet 400 (דוגמה)"])); process.exit(0); }
const save = () => fs.writeFileSync(STATE, JSON.stringify(seen));
const errors = [];

// ---- reviews ----
let themed = null;   // the themes call of this run (review-themes.mjs), told and closed at the end
// "" when the responder (Cloudflare Worker luchit-reviews) announces the reviews itself, else why not (written to the log)
async function responder() {
  if (process.env.REVIEWS_RESPONDER === "off") return "REVIEWS_RESPONDER=off";
  let u;
  try { u = new URL(String(process.env.ALERT_UPTIME_URL || "").replace(/\/+$/, "") + "/health"); } catch { return "no ALERT_UPTIME_URL"; }
  if (!/^luchit-uptime\./.test(u.hostname)) return "ALERT_UPTIME_URL is not luchit-uptime's address";
  u.hostname = u.hostname.replace(/^luchit-uptime\./, "luchit-reviews."); u.pathname = "/health"; u.search = "";
  try {
    const r = await fetch(u, { headers: { "user-agent": "luchit-reviews-monitor/1" }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return `health answered ${r.status}`;
    const j = await r.json(), age = Date.now() - Date.parse(j?.lastTick);
    return j?.tg === true && j?.sa === true && j?.list === true && age > -5 * 6e4 && age <= 12 * 36e5 ? "" : `not ready (tg ${j?.tg}, sa ${j?.sa}, list ${j?.list}, tick ${j?.lastTick || "none"})`;
  } catch (e) { return "health did not answer (" + (e?.name || "error") + ")"; }
}
try {
  const t = await token("https://www.googleapis.com/auth/androidpublisher");
  const r = await rf(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}/reviews?maxResults=100`, { headers: { authorization: "Bearer " + t } });
  if (!r.ok) throw new Error(`reviews API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const list = (await r.json()).reviews || [];
  const since = Date.now() / 1000 - 7 * 24 * 3600;   // the reviews API itself only returns the last week
  const dev = process.env.PLAY_DEVELOPER_ID, app = process.env.PLAY_APP_ID;
  const base = dev && app ? `https://play.google.com/console/developers/${dev}/app/${app}/user-feedback/reviews` : "https://play.google.com/console";
  const by = await responder();
  console.log(by ? `reviews: alerts sent here (luchit-reviews: ${by})` : "reviews: luchit-reviews announces them with a reply draft, no alert here");
  let sent = 0, failed = 0, left = 0;
  for (const rv of list) {
    const c = (rv.comments || []).find(x => x.userComment)?.userComment; if (!c) continue;
    const ts = +(c.lastModified?.seconds || 0), key = `${rv.reviewId}:${ts}`;
    if (ts < since || c.starRating > MAX_STARS || seen[key]) continue;
    if (!by) { seen[key] = Date.now(); left++; continue; }   // the responder has it: never announced here later, even if it stops
    const dm = c.deviceMetadata || {}, replied = (rv.comments || []).some(x => x.developerComment);
    const low = c.starRating <= 2;
    if (await telegram(`${tag(low ? "today" : "info", "reviews")}\n${"⭐".repeat(c.starRating)}${"☆".repeat(5 - c.starRating)} <b>ביקורת חדשה בגוגל פליי, ${c.starRating} מתוך 5</b>${replied ? " (כבר נענתה)" : ""}\n` +
      `מה נכתב: ${esc((c.text || "(בלי טקסט)").trim().slice(0, 900))}\n` +
      `${replied ? todo() : todo(low ? `לענות בקצרה ובנימוס ב-<a href="${base}">Play Console</a>. תשובה עניינית מרככת את הרושם אצל מי שקורא את הביקורות.` : `אפשר לענות ב-<a href="${base}">Play Console</a>, לא חובה.`)}` +
      folded(`גרסה ${c.appVersionName || "?"} (${c.appVersionCode || "?"}) · ${[dm.manufacturer, dm.productName].filter(Boolean).join(" ") || c.device || "?"} · אנדרואיד ${c.androidOsVersion ?? "?"} · מזהה ${rv.reviewId}`, "פרטי המכשיר"), c.starRating >= 3, key, undefined, low ? ["day", "review:" + rv.reviewId] : ["summary", "review3:" + rv.reviewId])) { seen[key] = Date.now(); sent++; } else failed++;
  }
  // weekly feedback digest (ops thread task, Dudu "כולם" 25.10): every review of the week, all stars, without author names, encrypted with
  // the seo-data public key and published by the workflow on the branch feedback-data (the repo is public; only the private key reads it).
  // Themes (Dudu 28.10, the monthly API credit): review-themes.mjs tags each review for the digest, inside the snapshot only; without them
  // (no key, an API error) the snapshot goes out as before and `themes` says why.
  if (!DRY) try {
    const week = list.map(rv => { const c = (rv.comments || []).find(x => x.userComment)?.userComment; return c && +(c.lastModified?.seconds || 0) >= since ?
      { stars: c.starRating, text: (c.text || "").trim().slice(0, 900), version: c.appVersionName || "", day: new Date(+c.lastModified.seconds * 1000).toISOString().slice(0, 10),
        replied: (rv.comments || []).some(x => x.developerComment) } : null; }).filter(Boolean);
    let T = null;
    try { T = await import("./review-themes.mjs"); themed = await T.tagThemes(week); } catch (e) { themed = { tags: null, why: "themes: " + String(e?.message || e).slice(0, 80), key: false }; }
    if (themed.tags) week.forEach((r, i) => { r.themes = themed.tags[i]; });
    console.log(themed.called ? "themes: tagged" : themed.tags ? "themes: nothing to tag" : `themes: none (${themed.why})`);   // never a tag or a count
    const k = crypto.randomBytes(32), iv = crypto.randomBytes(12), ci = crypto.createCipheriv("aes-256-gcm", k, iv);
    const themes = themed.tags ? { by: T.MODEL, names: T.THEMES } : { why: themed.why };
    const data = Buffer.concat([ci.update(JSON.stringify({ at: new Date().toISOString(), reviews: week, themes })), ci.final()]);
    const ek = crypto.publicEncrypt({ key: fs.readFileSync(".github/seo-data.pub.pem", "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, k);
    fs.mkdirSync("feedback-out", { recursive: true });
    fs.writeFileSync("feedback-out/reviews.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: ci.getAuthTag().toString("base64"), data: data.toString("base64") }));
  } catch (e) { console.log("feedback snapshot skipped:", e.message); }
  console.log(`reviews: ${list.length} returned, ${sent} alerts sent${left ? `, ${left} left to luchit-reviews` : ""}${failed ? `, ${failed} not delivered (tried again next run)` : ""}`);
} catch (e) { errors.push("reviews: " + e.message); console.log("reviews failed:", e.message); }

// ---- Play vitals (crash / ANR rate), Google's "bad behavior" thresholds: 1.09% crashes, 0.47% ANR (user-perceived) ----
const fine = [];   // router keys of the checks that came back under the threshold, closed below
try {
  const t = await token("https://www.googleapis.com/auth/playdeveloperreporting");
  const day = x => ({ year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate() });
  const H = { authorization: "Bearer " + t };
  for (const [kind, metric, limit, label] of [["crashRateMetricSet", "userPerceivedCrashRate", 1.09, "קריסות"], ["anrRateMetricSet", "userPerceivedAnrRate", 0.47, "ANR (אפליקציה לא מגיבה)"]]) {
    // the newest day Google has already computed moves during the day: ask the set itself instead of guessing "two days ago" (a fixed guess answered 400 whenever it was ahead of the data)
    let end = new Date(Date.now() - 2 * 864e5); end.setUTCHours(0, 0, 0, 0);
    try {
      const fr = await rf(`https://playdeveloperreporting.googleapis.com/v1beta1/apps/${PKG}/${kind}`, { headers: H });
      const f = fr.ok ? ((await fr.json()).freshnessInfo?.freshnesses || []).find(x => x.aggregationPeriod === "DAILY") : null;
      const le = f && f.latestEndTime; if (le && le.year) end = new Date(Date.UTC(le.year, le.month - 1, le.day));
    } catch {}
    const d = new Date(end.getTime() - 864e5);
    const body = { timelineSpec: { aggregationPeriod: "DAILY", startTime: { ...day(d), timeZone: { id: "America/Los_Angeles" } }, endTime: { ...day(end), timeZone: { id: "America/Los_Angeles" } } }, metrics: [metric, "distinctUsers"] };
    const r = await rf(`https://playdeveloperreporting.googleapis.com/v1beta1/apps/${PKG}/${kind}:query`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`vitals ${kind} ${r.status} ${(await r.text()).replace(/\s+/g, " ").slice(0, 200)}`);
    const row = ((await r.json()).rows || [])[0]; if (!row) continue;
    const m = Object.fromEntries((row.metrics || []).map(x => [x.metric, +(x.decimalValue?.value ?? NaN)]));
    const pct = m[metric] * 100, users = m.distinctUsers, k = `vitals:${kind}:${JSON.stringify(row.startTime)}`;
    console.log(`${kind}: ${pct.toFixed(2)}%${users >= 20 ? "" : " (too few users to alert)"}`);   // the user count is a business number: never in the public log
    if (pct < limit) fine.push("vitals:" + (kind.startsWith("crash") ? "crash" : "anr"));
    if (pct >= limit && users >= 20 && !seen[k]) {
      const head = `${tag("urgent", "app")}\n<b>שיעור ${label} גבוה בגוגל פליי</b>\n${pct.toFixed(2)}% מהמשתמשים חוו את זה ביום ${d.toISOString().slice(0, 10)}, מעל הסף של גוגל (${limit}%). מעל הסף גוגל מציגה את האפליקציה פחות בחנות.\n`;
      const what = todo("לכתוב בשרשור \"מוצר ושחרורים\" כדי לבדוק איזו גרסה ואיזה מכשיר. הפירוט ב-Play Console ← Android vitals.");
      if (await telegram(head + `(מתוך ${users} משתמשים)\n` + what, false, k, head + what, ["critical", "vitals:" + (kind.startsWith("crash") ? "crash" : "anr")])) seen[k] = Date.now();
    }
  }
} catch (e) { errors.push("vitals: " + e.message); console.log("vitals failed:", e.message); }

for (const k of Object.keys(seen)) if (k !== "errOn" && Date.now() - seen[k] > 14 * 864e5) delete seen[k];
// a broken monitor must not be silent: tell at once about a new error, then at most once a day while it keeps showing up, clean runs in between or not
// (a repeated error used to alert once and then stay quiet for 14 days). errOn: when the trouble began, kept until a full day passes with
// no failed check; errAt: the last failed check.
const now = Date.now(), DAY = 20 * 36e5;   // 20 h: scheduled runs start late by varying amounts
if (errors.length) { seen.errOn ||= now; seen.errAt = now; } else if (now - (seen.errAt || 0) > DAY) { delete seen.errOn; delete seen.errAt; }
const ek = "err:" + errors.join("|").slice(0, 80), lasting = errors.length && now - seen.errOn > DAY;
if (errors.length && (!seen[ek] || now - seen[ek] > DAY) && await telegram(errText(errors, lasting && seen.errOn), !lasting, ek, undefined, [lasting ? "day" : "summary", "reviews:error"])) seen[ek] = Date.now();
// the Claude call behind the themes (router families agreed 28.10): the key or the credit is ai:key (day: Dudu has to act), anything else
// this bot's own ai:themes (summary: the digest still reads the texts); a good call closes both. No key at all: nothing to tell.
if (themed && !themed.tags && !themed.none) {
  const k = themed.key ? "ai:key" : "ai:themes";
  await telegram(msg({ kind: themed.key ? "today" : "info", area: "bots", title: themed.key ? "מפתח ה-Claude API לא עובד או שהקרדיט החודשי נגמר" : "תיוג הנושאים בביקורות לא רץ הפעם",
    text: themed.key ? "הבוטים שנעזרים ב-Claude ממשיכים בלעדיו: טיוטות התשובה לביקורות חוזרות לתבנית, והסיכום השבועי קורא את הביקורות בלי תיוג." : "הסיכום השבועי יקרא את הביקורות בלי התיוג, כמו קודם. בהרצה הבאה זה ינסה שוב.",
    what: themed.key ? "לבדוק ב-Console של Claude (סביבת העבודה luchit-bots) אם המפתח בוטל או שהתקרה החודשית נוצלה. מפתח חדש מדביקים פעמיים: כסוד ANTHROPIC_API_KEY ב-GitHub, ובאותו שם ב-Worker luchit-reviews ב-Cloudflare." : "", raw: themed.why }),
    !themed.key, k, undefined, [themed.key ? "day" : "summary", k]);
}
// what is fine again closes its open alert in the router, which says so once, quietly (Dudu 26.10: every problem, and how it ended)
if (!DRY) { const done = [...fine, ...(errors.length ? [] : ["reviews:error"]), ...(themed?.called ? ["ai:themes", "ai:key"] : [])]; if (done.length) try { await (await import("./alert.mjs")).resolve(done); } catch { /* the morning ledger still lists it */ } }
save();
// finish green: an alert already told you, and a failed send is logged above and tried again next run (no "workflow failed" mail on top)
process.exit(0);
