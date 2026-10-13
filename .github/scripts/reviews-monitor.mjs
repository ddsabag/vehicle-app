// Alerts (Telegram) on new 1-3 star Google Play reviews from the last 24h, and when Play vitals cross Google's "bad behavior" thresholds.
// Env: PLAY_SERVICE_ACCOUNT_JSON (falls back to GA_SERVICE_ACCOUNT_JSON), TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
//      optional PLAY_PACKAGE, PLAY_DEVELOPER_ID + PLAY_APP_ID (for a deep link into Play Console), MAX_STARS (default 3), DRY_RUN=1.
// State: seen.json (restored/saved by the workflow cache) so the same review is never sent twice.
import fs from "node:fs";
import crypto from "node:crypto";
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
async function telegram(text) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (DRY || !tok || !chat) { console.log("--- Telegram (" + (DRY ? "dry run" : "no credentials") + ") ---\n" + text); return; }
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }) });
  if (!r.ok) throw new Error("telegram " + r.status);
}
let seen = {}; try { seen = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}
const save = () => fs.writeFileSync(STATE, JSON.stringify(seen));
const errors = [];

// ---- reviews ----
try {
  const t = await token("https://www.googleapis.com/auth/androidpublisher");
  const r = await fetch(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}/reviews?maxResults=100`, { headers: { authorization: "Bearer " + t } });
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
      `${esc((c.text || "(בלי טקסט)").trim().slice(0, 900))}\n\n<a href="${base}">למענה ב-Console</a> · מזהה: <code>${esc(rv.reviewId)}</code>`);
    seen[key] = Date.now(); sent++;
  }
  console.log(`reviews: ${list.length} returned, ${sent} alerts sent`);
} catch (e) { errors.push("reviews: " + e.message); console.log("reviews failed:", e.message); }

// ---- Play vitals (crash / ANR rate), Google's "bad behavior" thresholds: 1.09% crashes, 0.47% ANR (user-perceived) ----
try {
  const t = await token("https://www.googleapis.com/auth/playdeveloperreporting");
  const d = new Date(Date.now() - 2 * 864e5), day = x => ({ year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate() });
  const end = new Date(d.getTime() + 864e5);
  for (const [kind, metric, limit, label] of [["crashRateMetricSet", "userPerceivedCrashRate", 1.09, "קריסות"], ["anrRateMetricSet", "userPerceivedAnrRate", 0.47, "ANR (אפליקציה לא מגיבה)"]]) {
    const body = { timelineSpec: { aggregationPeriod: "DAILY", startTime: { ...day(d), timeZone: { id: "America/Los_Angeles" } }, endTime: { ...day(end), timeZone: { id: "America/Los_Angeles" } } }, metrics: [metric, "distinctUsers"] };
    const r = await fetch(`https://playdeveloperreporting.googleapis.com/v1beta1/apps/${PKG}/${kind}:query`, { method: "POST", headers: { authorization: "Bearer " + t, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`vitals ${kind} ${r.status}`);
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
if (errors.length && !seen[ek]) { seen[ek] = Date.now(); save(); await telegram(`⚠️ <b>מנטר הביקורות של לוחית נכשל</b>\n${errors.map(esc).join("\n")}`); process.exit(1); }
if (!errors.length) process.exit(0);
