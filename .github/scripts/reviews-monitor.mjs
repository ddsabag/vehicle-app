// Alerts (Telegram) on new 1-3 star Google Play reviews from the last 24h, and when Play vitals cross Google's "bad behavior" thresholds.
import { ilTime } from "./notify.mjs";
import { flash } from "./flash.mjs";
// Env: PLAY_SERVICE_ACCOUNT_JSON (falls back to GA_SERVICE_ACCOUNT_JSON), TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
//      optional PLAY_PACKAGE, PLAY_DEVELOPER_ID + PLAY_APP_ID (for a deep link into Play Console), MAX_STARS (default 3), DRY_RUN=1.
// State: seen.json (restored/saved by the workflow cache) so the same review is never sent twice.
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
const errText = errors => `⚠️ <b>הבדיקה האוטומטית של גוגל פליי לא הצליחה לרוץ</b>\nהיא בודקת כל שעתיים ביקורות חדשות עם 1 עד 3 כוכבים ושיעור קריסות. הפעם לא הצליחה לקבל תשובה מגוגל, ולכן לא ידוע אם יש ביקורות או קריסות חדשות. זה לא אומר שיש בעיה באפליקציה.\nפירוט: ${errors.map(esc).join("; ")}\n\nמה לעשות: בדרך כלל כלום, והבדיקה הבאה תרוץ בעוד שעתיים. אם זה חוזר, כתבו לי.\n\nזמן: ${ilTime()} (שעון ישראל)`;
async function telegram(text, silent = false) {
  await flash("reviews", silent ? "info" : "alert", text);
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (DRY || !tok || !chat) { console.log("--- Telegram (" + (DRY ? "dry run" : "no credentials") + ") ---\n" + text); return DRY; }
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, disable_notification: silent }) });
  if (!r.ok) throw new Error("telegram " + r.status);
  return true;
}
if (process.env.PREVIEW === "1") { await telegram("🧪 <b>הודעת בדיקה, אין תקלה אמיתית</b>\n\n" + errText(["vitals: vitals crashRateMetricSet 400 (דוגמה)"])); process.exit(0); }
let seen = {}; try { seen = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}
const save = () => fs.writeFileSync(STATE, JSON.stringify(seen));
const errors = [];

// ---- reviews ----
try {
  const t = await token("https://www.googleapis.com/auth/androidpublisher");
  const r = await rf(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}/reviews?maxResults=100`, { headers: { authorization: "Bearer " + t } });
  if (!r.ok) throw new Error(`reviews API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const list = (await r.json()).reviews || [];
  const since = Date.now() / 1000 - 24 * 3600;
  const dev = process.env.PLAY_DEVELOPER_ID, app = process.env.PLAY_APP_ID;
  const base = dev && app ? `https://play.google.com/console/developers/${dev}/app/${app}/user-feedback/reviews` : "https://play.google.com/console";
  let sent = 0;
  for (const rv of list) {
    const c = (rv.comments || []).find(x => x.userComment)?.userComment; if (!c) continue;
    const ts = +(c.lastModified?.seconds || 0), key = `${rv.reviewId}:${ts}`;
    if (ts < since || c.starRating > MAX_STARS || seen[key]) continue;
    const dm = c.deviceMetadata || {}, replied = (rv.comments || []).some(x => x.developerComment);
    await telegram(`${"⭐".repeat(c.starRating)}${"☆".repeat(5 - c.starRating)} <b>ביקורת חדשה בגוגל פליי</b>${replied ? " (כבר נענתה)" : ""}\n` +
      `גרסה: ${esc(c.appVersionName || "?")} (${esc(c.appVersionCode || "?")})\nמכשיר: ${esc([dm.manufacturer, dm.productName].filter(Boolean).join(" ") || c.device || "?")}\nאנדרואיד: ${esc(c.androidOsVersion ?? "?")}\n\n` +
      `${esc((c.text || "(בלי טקסט)").trim().slice(0, 900))}\n\n<a href="${base}">למענה ב-Console</a> · מזהה: <code>${esc(rv.reviewId)}</code>`, c.starRating >= 3);
    seen[key] = Date.now(); sent++;
  }
  console.log(`reviews: ${list.length} returned, ${sent} alerts sent`);
} catch (e) { errors.push("reviews: " + e.message); console.log("reviews failed:", e.message); }

// ---- Play vitals (crash / ANR rate), Google's "bad behavior" thresholds: 1.09% crashes, 0.47% ANR (user-perceived) ----
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
    console.log(`${kind}: ${pct.toFixed(2)}% (${users} users)`);
    if (pct >= limit && users >= 20 && !seen[k]) {
      await telegram(`🚨 <b>שיעור ${label} גבוה בגוגל פליי</b>\n${pct.toFixed(2)}% ממשתמשים (סף גוגל ${limit}%), מתוך ${users} משתמשים ביום ${d.toISOString().slice(0, 10)}.\nפירוט לפי גרסה ומכשיר: Play Console ← Android vitals.`);
      seen[k] = Date.now();
    }
  }
} catch (e) { errors.push("vitals: " + e.message); console.log("vitals failed:", e.message); }

for (const k of Object.keys(seen)) if (Date.now() - seen[k] > 14 * 864e5) delete seen[k];
save();
// a broken monitor must not be silent: tell once per distinct error
const ek = "err:" + errors.join("|").slice(0, 80);
if (errors.length && !seen[ek]) { seen[ek] = Date.now(); save(); /* alert sent: finish green so GitHub does not also mail "workflow failed" */ process.exit((await telegram(errText(errors))) ? 0 : 1); }
if (!errors.length) process.exit(0);
