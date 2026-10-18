// luchit-reviews: drafts a Hebrew reply to every new Google Play review and asks Dudu in Telegram; a reply is published ONLY on his tap.
//   cron */30, by day only (08:00-22:00 Israel): reviews.list -> skip reviews that already have a developer reply or were handled (KV) ->
//   classify -> draft from TEMPLATES -> one message per review with [שלח] [ערוך] [דלג]; 1-2 stars ring, 3-5 arrive silent.
//   POST /tg = Telegram webhook (secret header derived from the bot token + chat id = TELEGRAM_CHAT_ID). שלח: reviews.get (refuse when a
//   developer reply exists) then reviews.reply with the draft read back from the message; ערוך: ForceReply, the answer is validated and
//   comes back as a confirmation with [שלח] [בטל]; דלג: marked handled. Every callback is answered.
//   GET /health = public status (no review text, ids or counts); installs the webhook (<origin>/tg, max_connections 1) when needed.
// Secrets (Dudu pastes them): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, REVIEWS_SA_JSON (a service account with Play "Reply to reviews" only).
// Without all three the cron does nothing. Binding: KV ALERTS (luchit-alerts, shared with luchit-uptime; this Worker uses only "rv:" keys).
// KV writes happen only when something happens: a review posted, a tap, an edit, a list-health change (free plan: 1,000 writes/day).
// The block between the alert-lib v1 markers is a byte-identical copy of worker/lib/alert-lib.js (CI compares them).
const BUILD = "reviews-1", PKG = "com.ddsabag.pratirechev";
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}/reviews`;
const MAX = 350, SIGN = "צוות לוחית", TTL = 60 * 86400, PER_TICK = 20;   // Google rejects replyText over ~350 chars
const M_START = "⬇️ טיוטת התשובה ⬇️", M_END = "⬆️ סוף הטיוטה ⬆️", EDIT_TAG = "✏️ נוסח חדש לתשובה ";
const HKEY = "rv:h", FAIL_TELL = 3 * 36e5;   // list health; Dudu hears once when listing has failed for 3 h of daytime ticks
const PACE = { ms: 1100 };   // between two review messages (Telegram: about 1 message a second per chat); tests lower it

// Reply templates, approved once by Dudu (reports/תבניות-מענה-לביקורות.md). Plural address, no promises, no plate numbers, dealers neutral.
const TEMPLATES = {
  crash: "תודה שסיפרתם לנו, ומצטערים על התקלה. כדי שנוכל לבדוק, נשמח אם תכתבו ל-support@luchit.app מה עשיתם רגע לפני שזה קרה ואיזה מכשיר יש לכם. אין צורך לשלוח מספר רכב.\nצוות לוחית",
  data: "תודה על ההערה. המידע בלוחית מגיע מהמאגרים הפתוחים של משרד התחבורה, ולפעמים פרט מסוים חסר שם או מתעדכן באיחור. אם תכתבו ל-support@luchit.app איזה פרט נראה לכם חסר או לא מעודכן (בלי מספר רכב), זה יעזור לנו לבדוק את המקור.\nצוות לוחית",
  feature: "תודה על ההצעה! אנחנו קוראים כל בקשה ושוקלים אותה כשאנחנו מתכננים את ההמשך. אם יש לכם עוד רעיונות, אפשר לכתוב לנו ל-support@luchit.app.\nצוות לוחית",
  price: "תודה על המשוב. אנחנו קוראים כל הערה על המחיר ועל PRO. אם משהו בתשלום או במנוי לא היה ברור, כתבו לנו ל-support@luchit.app ונשמח לעזור.\nצוות לוחית",
  praise: "תודה רבה על המילים החמות! שמחים שלוחית עוזרת לכם. אם יש משהו שהיה הופך אותה לטובה עוד יותר, נשמח לשמוע ב-support@luchit.app.\nצוות לוחית",
  dealer: "תודה ששיתפתם. לוחית מציגה את המידע מהמאגרים הפתוחים של משרד התחבורה, כך שכל הצדדים בעסקה רואים את אותם הנתונים. אין לנו אפשרות להתייחס לעסקה מסוימת או לגורם מסוים. לפני קנייה כדאי לבדוק כל רכב גם במכון בדיקה מורשה.\nצוות לוחית",
  other: "תודה שכתבתם לנו. אם תרצו לפרט עוד, אפשר לכתוב ל-support@luchit.app ונשמח לשמוע.\nצוות לוחית",
};
const LABEL = { crash: "תקלה או קריסה", data: "מידע חסר או לא מעודכן", feature: "בקשה לתכונה", price: "מחיר או PRO", praise: "שבח",
  dealer: "תלונה על מוכר או סוחר", other: "אחר" };
// Classification: first match wins in this order. Hebrew has no \b, so short Hebrew words are fenced with (?<![א-ת]) / (?![א-ת]).
const HE = s => `(?<![א-ת])(?:${s})(?![א-ת])`;
const RX = {
  crash: new RegExp(`קורס|קריסה|קרסה|נקרס|נתקע|תקוע|לא נפתח|לא נטענ?|מסך (?:לבן|שחור)|לא עובד|לא מגיב|תקלה|באג|שגיאה|\\bcrash|\\bbug|\\berror|\\bfreez|\\bstuck\\b|won'?t (?:open|load|start)|does(?:n'?t| not) (?:open|load|work)|not (?:working|loading|opening)|force clos`, "i"),
  dealer: new RegExp(`סוחר|מגרש|${HE("ה?מוכר(?:ת|ים)?")}|מוכר הרכב|טרייד|יבואן|סוכנות|\\bdealer|\\bseller|salesm[ae]n|\\bimporter|trade-?in`, "i"),
  data: new RegExp(`${HE("חסר(?:ים|ה|ות)?")} (?:מידע|נתונ|פרט)|אין (?:מידע|נתונים|פרטים)|לא (?:מעודכנ?|עדכני|נכונ?|מדויק|תואם|מופיע|נמצא|מצא|מוצא)|מידע ישן|נתונים ישנים|שגוי|טעות ב|\\bmissing\\b|outdated|out of date|\\bwrong\\b|incorrect|inaccurate|not found|no (?:data|info)|(?:can'?t|couldn'?t|cannot) find`, "i"),
  price: new RegExp(`מחיר|${HE("יקר(?:ה|ים)?")}|תשלום|לשלם|משלמ|מנוי|${HE("פרו")}|פרימיום|${HE("כסף")}|החזר כספי|זיכוי|\\bpremium|subscri|\\bprice|\\bpay\\b|\\bpaid\\b|expensive|\\bmoney|refund|\\bpro\\b`, "i"),
  feature: new RegExp(`תוסיפו|להוסיף|אשמח אם|הייתי רוצה|כדאי ש|חסרה אפשרות|חסר כפתור|אפשרות ל|פיצ'?ר|מצב (?:כהה|לילה)|אייפון|iphone|\\bios\\b|please add|would be (?:nice|great)|\\bwish\\b|feature|suggest|dark mode`, "i"),
  praise: new RegExp(`מעולה|מצוינ?|אחלה|תודה|מושלמ|שימושי|עוזר|עזר(?:ה)? לי|נהדר|מדהימ|כל הכבוד|\\bgreat\\b|excellent|\\blove|awesome|useful|helpful|thank|perfect|amazing|\\bgood\\b`, "i"),
};
const NEG = /רמאי|עקץ|עוקץ|(?<![א-ת])נוכל(?:ים|ת)?(?![א-ת])|שיקר|שקר|הסתיר|הונא|רימה|\bscam|\blied\b|\bliar|cheat|fraud|rip-?off/i;
function classify(text, stars) {
  const t = String(text || "");
  if (RX.crash.test(t)) return "crash";
  if (RX.dealer.test(t) && (stars <= 3 || NEG.test(t))) return "dealer";   // a happy review that mentions a seller is praise
  if (RX.data.test(t)) return "data";
  if (RX.price.test(t)) return "price";
  if (RX.feature.test(t)) return "feature";
  if (stars >= 4 || (stars === 3 && RX.praise.test(t))) return "praise";
  return "other";
}
// 7-8 digit plates as written in Israel: 1234567, 12345678, 12-345-67, 123-45-678 (dash, en dash, dot or space); not part of a longer number
const PLATE = /(?<!\d[-–. ]?)(?:\d{7,8}|\d{2}[-–. ]\d{3}[-–. ]\d{2}|\d{3}[-–. ]\d{2}[-–. ]\d{3})(?![-–. ]?\d)/;
const WARN = /מציאה|משתלם|מומלץ|רמאי|עוקץ|(?<![א-ת])נוכל(?![א-ת])|נתקן|נוסיף|בקרוב|בגרסה הבאה/;   // a warning on Dudu's own text, never a block
const chars = s => [...String(s)].length;   // code points, as Play counts characters
function invalid(t) {
  if (!t.trim()) return "הנוסח ריק.";
  if (chars(t) > MAX) return `הנוסח ארוך מדי: ${chars(t)} תווים (מותר עד ${MAX}).`;
  if (PLATE.test(t)) return "נראה שיש בנוסח מספר רכב (7 או 8 ספרות). בתשובה ציבורית אסור מספר רכב.";
  if (t.includes(M_START) || t.includes(M_END)) return "הנוסח מכיל את סימני הטיוטה.";
  return "";
}

const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha = async s => b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const rkey = async id => (await sha("r:" + id)).slice(0, 10);   // short review key: callback_data must stay under 64 bytes
const dkey = async t => (await sha("d:" + t)).slice(0, 8);      // draft fingerprint: a button acts only on the current draft
const ready = env => !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && env.REVIEWS_SA_JSON);
const sa = env => { try { const s = JSON.parse(env.REVIEWS_SA_JSON); return s.client_email && s.private_key ? s : null; } catch { return null; } };
const kvGet = async (env, h, strict) => { try { return await within(env.ALERTS.get("rv:" + h, "json")); } catch (e) { if (strict) throw e; return null; } };
const kvPut = (env, h, v) => within(env.ALERTS.put("rv:" + h, JSON.stringify(v), { expirationTtl: TTL }));

// ---- Google: OAuth JWT (RS256, WebCrypto) and the reviews API ----
let gtok = { t: "", exp: 0, who: "" };
async function gToken(env) {
  const s = sa(env); if (!s) throw new Error("bad REVIEWS_SA_JSON");
  if (gtok.t && gtok.who === s.client_email && Date.now() < gtok.exp) return gtok.t;
  const now = Math.floor(Date.now() / 1000), enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: "RS256", typ: "JWT" }) + "." + enc({ iss: s.client_email, scope: "https://www.googleapis.com/auth/androidpublisher", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 });
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(s.private_key.replace(/-----[^-]+-----|\s/g, "")), c => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = b64u(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", signal: AbortSignal.timeout(10000), headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig }) });
  if (!r.ok) throw new Error("google auth " + r.status);
  gtok = { t: (await r.json()).access_token, exp: Date.now() + 2900e3, who: s.client_email };
  return gtok.t;
}
const gapi = async (env, path, o = {}) => fetch(API + path, { ...o, signal: AbortSignal.timeout(15000),
  headers: { authorization: "Bearer " + await gToken(env), ...(o.body ? { "content-type": "application/json" } : {}) } });
async function listReviews(env) {   // the API returns production reviews with text, created or edited in the last 7 days
  const out = []; let tok = "";
  for (let i = 0; i < 3; i++) {
    const r = await gapi(env, "?maxResults=100" + (tok ? "&token=" + encodeURIComponent(tok) : ""));
    if (!r.ok) throw new Error("list " + r.status);
    const j = await r.json(); out.push(...(j.reviews || []));
    if (!(tok = j.tokenPagination?.nextPageToken)) break;
  }
  return out;
}
const userOf = rv => (rv.comments || []).find(c => c.userComment)?.userComment;
const answered = rv => (rv.comments || []).some(c => c.developerComment);

// ---- Telegram ----
async function tg(env, method, body) {   // the result, or null; buttons need reply_markup, which tgSend (alert-lib) does not take
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(10000), body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) console.log(`tg ${method} ${r.status}`, String(j.description || "").slice(0, 120));
    return j.ok ? j.result : null;
  } catch (e) { console.log(`tg ${method} failed`, String(e).slice(0, 120)); return null; }
}
const hookSecret = async env => {   // what Telegram sends in X-Telegram-Bot-Api-Secret-Token: HMAC-SHA256(bot token, label), hex, 32 chars
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(env.TELEGRAM_BOT_TOKEN)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("luchit-reviews-webhook")))].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
};
const same = (a, b) => { a = String(a); b = String(b); let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0); return !d; };
const botId = env => String(env.TELEGRAM_BOT_TOKEN).split(":")[0];
const keyboard = rows => ({ inline_keyboard: rows.map(r => r.map(([text, callback_data]) => ({ text, callback_data }))) });
const block = (d, extra = "") => `${M_START}\n${esc(d)}\n${M_END}\n${chars(d)}/${MAX} תווים${extra}`;
function card(uc, cls, draft, h, updated) {
  const s = Math.max(1, Math.min(5, +uc.starRating || 0));
  const text = String(uc.text || "").replace(/\t/g, "\n").trim().slice(0, 1500);
  return `${"⭐".repeat(s)}${"☆".repeat(5 - s)} <b>ביקורת ${updated ? "שעודכנה" : "חדשה"} ב-Google Play</b>\nסוג: ${LABEL[cls]} · גרסה: ${esc(uc.appVersionName || "?")}\n` +
    `<blockquote>${esc(text)}</blockquote>\n\n${block(draft, ` · #${h}`)}\nהתשובה תתפרסם רק אחרי "שלח".`;
}
function parseDraft(text) {   // the text between the LAST start marker and the end marker after it (review text comes first)
  const t = String(text || ""), a = t.lastIndexOf(M_START); if (a < 0) return null;
  const b = t.indexOf(M_END, a + M_START.length); if (b < 0) return null;
  return t.slice(a + M_START.length, b).trim();
}
// edit the tapped message: keep its text and formatting, drop the buttons, add a status line
async function settle(env, msg, note) {
  const base = { chat_id: msg.chat.id, message_id: msg.message_id };
  if (await tg(env, "editMessageText", { ...base, text: `${msg.text || ""}\n\n${note}`, entities: msg.entities || [], reply_markup: { inline_keyboard: [] } })) return;
  await tg(env, "editMessageReplyMarkup", { ...base, reply_markup: { inline_keyboard: [] } });
}

// ---- cron ----
async function tick(env) {
  if (!ready(env) || !env.ALERTS) return "off";   // a missing secret or binding: do nothing at all
  const now = Date.now();
  if (!isDaytime(new Date(now))) return "night";
  let ok = true, sent = 0;
  try {
    const todo = (await listReviews(env)).map(rv => ({ rv, uc: userOf(rv) })).filter(x => x.uc && String(x.uc.text || "").trim() && !answered(x.rv))
      .map(x => ({ ...x, ts: +(x.uc.lastModified?.seconds || 0) })).sort((a, b) => a.ts - b.ts);
    for (const x of todo) {
      if (sent >= PER_TICK) break;
      const h = await rkey(x.rv.reviewId); let st;
      try { st = await kvGet(env, h, true); } catch (e) { console.log("KV read failed, posting stops this tick:", String(e).slice(0, 120)); break; }   // never repost blind
      if (st && (st.st !== "open" || st.ts >= x.ts)) continue;   // handled, or this version already posted
      if (sent) await new Promise(r => setTimeout(r, PACE.ms));
      const stars = +x.uc.starRating || 0, cls = classify(x.uc.text, stars), draft = TEMPLATES[cls], d = await dkey(draft);
      const m = await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: card(x.uc, cls, draft, h, !!st), parse_mode: "HTML", disable_web_page_preview: true,
        disable_notification: stars > 2, reply_markup: keyboard([[["✅ שלח", `s|${h}|${d}`], ["✏️ ערוך", `e|${h}|${d}`], ["⏭ דלג", `k|${h}`]]]) });
      if (!m) continue;   // not posted: tried again next tick
      try { await kvPut(env, h, { id: x.rv.reviewId, ts: x.ts, st: "open", cls, d0: d, dh: d }); } catch (e) { console.log("KV write failed:", String(e).slice(0, 120)); }
      sent++;
    }
  } catch (e) { ok = false; console.log("list failed:", String(e).slice(0, 160)); }
  // list health: written only when the flag flips, when the stored tick is over 2 h old, or to say "told"
  let hs = null; try { hs = await within(env.ALERTS.get(HKEY, "json")); } catch {}
  const n = { list: ok, tick: new Date(now).toISOString(), since: ok ? null : hs?.list === false ? hs.since : new Date(now).toISOString(), told: !ok && !!hs?.told };
  if (!ok && !n.told && now - Date.parse(n.since) >= FAIL_TELL)
    n.told = await tgSend(env, "⚠️ <b>מענה לביקורות: Google Play לא עונה</b>\nכבר 3 שעות שלא מצליח לקרוא ביקורות. אם זה נמשך, בדקו את המפתח REVIEWS_SA_JSON ואת ההרשאה \"Reply to reviews\" ב-Play Console.\nמצב: /health של luchit-reviews");
  if (!hs || hs.list !== n.list || n.told !== !!hs.told || now - Date.parse(hs.tick) > 2 * 36e5)
    try { await within(env.ALERTS.put(HKEY, JSON.stringify(n))); } catch {}
  return ok ? `sent ${sent}` : "list failed";
}

// ---- webhook ----
const busy = new Set();   // per isolate; KV "busy" and Google's own state cover the rest, and the webhook runs with max_connections 1
async function onCallback(env, q) {
  const ans = (text, alert = false) => tg(env, "answerCallbackQuery", { callback_query_id: q.id, text, show_alert: alert });
  const m = /^([sekc])\|([\w-]{10})(?:\|([\w-]{8}))?$/.exec(q.data || ""), msg = q.message;
  if (!m || !msg) return ans("כפתור לא מוכר.");
  const [, a, h, d] = m, st = await kvGet(env, h);
  if (!st) return ans("הביקורת לא נמצאה (אולי ישנה מדי). לא בוצע דבר.", true);
  if (st.st === "done") { await settle(env, msg, "✅ כבר נשלחה תשובה לביקורת הזו."); return ans("כבר נשלחה תשובה. לא נשלח שוב.", true); }
  if (st.st === "skip") { await settle(env, msg, "⏭ הביקורת סומנה כ\"דלג\"."); return ans("הביקורת סומנה כ\"דלג\".", true); }
  if (a === "k") { st.st = "skip"; await kvPut(env, h, st); await settle(env, msg, `⏭ דולג (${ilTime()})`); return ans("סומן: דלג"); }
  if (a === "e") {
    const cur = parseDraft(msg.text) || "";
    await tg(env, "sendMessage", { chat_id: msg.chat.id, reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true }, text: `${EDIT_TAG}#${h}\nכתבו בתגובה (Reply) להודעה הזו את הנוסח המלא, עד ${MAX} תווים, בלי מספרי רכב. אם החתימה "${SIGN}" חסרה, היא תתווסף.\n\nהנוסח הנוכחי:\n${cur}`,
      reply_markup: { force_reply: true, input_field_placeholder: `הנוסח החדש, עד ${MAX} תווים` } });
    return ans("כתבו את הנוסח החדש בתגובה להודעה.");
  }
  if (a === "c") {
    if (d !== st.dh) { await settle(env, msg, "↩️ הנוסח הזה כבר לא בתוקף."); return ans("הנוסח הזה כבר לא בתוקף."); }
    st.dh = st.d0; await kvPut(env, h, st);
    await settle(env, msg, "↩️ בוטל. הטיוטה המקורית בתוקף שוב, בהודעה הראשונה של הביקורת.");
    return ans("בוטל.");
  }
  // שלח: only the current draft, read back from this message and matching its fingerprint
  if (d !== st.dh) return ans("זו טיוטה ישנה. השתמשו בהודעה האחרונה של הביקורת הזו.", true);
  const draft = parseDraft(msg.text);
  if (!draft || await dkey(draft) !== d) return ans("לא הצלחתי לקרוא את הטיוטה מההודעה. לא נשלח דבר.", true);
  const bad = invalid(draft); if (bad) return ans(bad + " לא נשלח.", true);
  if (busy.has(h) || (st.busy && Date.now() - st.busy < 90e3)) return ans("כבר בשליחה...");
  busy.add(h);
  try {
    st.busy = Date.now(); await kvPut(env, h, st);
    const g = await gapi(env, "/" + encodeURIComponent(st.id));
    if (!g.ok) throw new Error("get " + g.status);
    if (answered(await g.json())) {   // reviews.reply would overwrite an existing reply: refuse
      delete st.busy; st.st = "done"; await kvPut(env, h, st);
      await settle(env, msg, "⚠️ לא נשלח: לביקורת כבר יש תשובה (אולי מ-Play Console).");
      return ans("לביקורת כבר יש תשובה. לא נשלח, כדי לא לדרוס אותה.", true);
    }
    const r = await gapi(env, "/" + encodeURIComponent(st.id) + ":reply", { method: "POST", body: JSON.stringify({ replyText: draft }) });
    if (!r.ok) throw new Error("reply " + r.status);
    delete st.busy; st.st = "done"; st.at = new Date().toISOString(); await kvPut(env, h, st);
    await settle(env, msg, `✅ נשלח ל-Google Play (${ilTime()})`);
    return ans("נשלח ✅");
  } catch (e) {
    console.log("send failed:", String(e).slice(0, 160));
    delete st.busy; try { await kvPut(env, h, st); } catch {}
    return ans(`השליחה נכשלה (${String(e.message || e).slice(0, 60)}). אפשר ללחוץ שוב; תשובה קיימת לא תידרס.`, true);
  } finally { busy.delete(h); }
}
async function onReply(env, msg) {   // Dudu's answer to the ForceReply prompt
  const p = msg.reply_to_message, hm = new RegExp(`^${EDIT_TAG}#([\\w-]{10})`).exec(p?.text || "");
  if (!hm || String(p.from?.id) !== botId(env)) return;
  const h = hm[1], st = await kvGet(env, h), say = t => tg(env, "sendMessage", { chat_id: msg.chat.id, reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true }, text: t });
  if (!st) return say("הביקורת לא נמצאה (אולי ישנה מדי).");
  if (st.st !== "open") return say(st.st === "done" ? "לביקורת הזו כבר נשלחה תשובה. לא שונה דבר." : "הביקורת סומנה כ\"דלג\". לא שונה דבר.");
  let t = String(msg.text || "").trim();
  if (t && !t.includes(SIGN)) t += "\n" + SIGN;
  const bad = invalid(t); if (bad || !msg.text?.trim()) return say(`❌ ${bad || "הנוסח ריק."} לא נשמר. ענו שוב להודעת העריכה עם נוסח מתוקן.`);
  const d = await dkey(t); st.dh = d; await kvPut(env, h, st);
  const w = WARN.exec(t);
  await tg(env, "sendMessage", { chat_id: msg.chat.id, reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true }, parse_mode: "HTML", disable_web_page_preview: true,
    text: `📝 <b>הנוסח החדש</b>${w ? `\n⚠️ שימו לב למילה "${esc(w[0])}": בלי הבטחות ובלי שבחים לרכב.` : ""}\n\n${block(t, ` · #${h}`)}\nהתשובה תתפרסם רק אחרי "שלח".`,
    reply_markup: keyboard([[["✅ שלח", `s|${h}|${d}`], ["↩️ בטל", `c|${h}|${d}`]]]) });
}

// ---- /health: whitelist only; installs the webhook ----
let hook = { at: 0, ok: false, tg: false };
async function health(req, env) {
  const out = { v: BUILD, tg: false, sa: !!sa(env), list: null, webhook: false, lastTick: null };
  try { const h = env.ALERTS ? await within(env.ALERTS.get(HKEY, "json")) : null; if (h) { out.list = h.list === true; out.lastTick = h.tick || null; } } catch {}
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    if (Date.now() - hook.at > 60e3) {   // at most one getWebhookInfo per minute per isolate
      const want = new URL(req.url).origin + "/tg", info = await tg(env, "getWebhookInfo", {});
      let ok = !!info && info.url === want;
      // a 401/403 in the last hour means Telegram holds another secret (e.g. a rotated bot token): set it again
      const stale = ok && /\b40[13]\b/.test(info.last_error_message || "") && Date.now() / 1000 - (info.last_error_date || 0) < 3600;
      if (info && (!ok || stale)) ok = !!(await tg(env, "setWebhook", { url: want, secret_token: await hookSecret(env), allowed_updates: ["message", "callback_query"], max_connections: 1 }));
      hook = { at: Date.now(), ok, tg: !!info && !!(await tg(env, "getChat", { chat_id: env.TELEGRAM_CHAT_ID })) };   // tg: token and chat id both work
    }
    out.tg = hook.tg; out.webhook = hook.ok;
  }
  return new Response(JSON.stringify(out), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

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

export default {
  async scheduled(event, env) {
    try { console.log("tick:", await tick(env)); } catch (e) { console.log("tick failed:", String(e).slice(0, 200)); }
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") return health(req, env);
    if (req.method !== "POST" || url.pathname !== "/tg") return new Response("not found", { status: 404 });
    // only Telegram (secret header) and only Dudu's chat; a wrong header is 403. A right header from another chat is Telegram delivering
    // a stranger's message: 200 with no work, since a non-2xx makes Telegram redeliver it and hold the queue (max_connections 1).
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !same(req.headers.get("x-telegram-bot-api-secret-token") || "", await hookSecret(env)))
      return new Response("forbidden", { status: 403 });
    let u; try { u = await req.json(); } catch { return new Response("ok"); }
    const chat = u?.callback_query?.message?.chat?.id ?? u?.message?.chat?.id;
    if (chat === undefined || String(chat) !== String(env.TELEGRAM_CHAT_ID).trim() || !env.ALERTS) return new Response("ok");
    try {
      if (u.callback_query) await onCallback(env, u.callback_query);
      else if (u.message?.reply_to_message) await onReply(env, u.message);
    } catch (e) { console.log("update failed:", String(e).slice(0, 200)); }
    return new Response("ok");   // always 2xx once authenticated: a redelivered tap must never become a second action
  },
};
