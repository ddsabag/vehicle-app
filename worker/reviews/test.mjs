// Offline test of luchit-reviews (worker/reviews/worker.js): mocked fetch (Google + Telegram), KV and clock; WebCrypto is real
// (a generated RSA key signs the OAuth JWT and the mocked token endpoint verifies it). The file is loaded as a data: URL (Node 20+),
// twice, to stand for two isolates that share one KV.
//   node worker/reviews/test.mjs
import fs from "node:fs";

// the Worker exports only its default handler; the test appends a named export of the internals it checks
const SRC = fs.readFileSync(new URL("./worker.js", import.meta.url), "utf8") + "\nexport { classify, TEMPLATES, PACE, PLATE, invalid, parseDraft, chars, hookSecret };";
const W = await import("data:text/javascript," + encodeURIComponent(SRC));
const worker = W.default;
const W2 = (await import("data:text/javascript," + encodeURIComponent(SRC + "\n// isolate 2"))).default;   // a second isolate: own memory, same KV
W.PACE.ms = 0;
const RealDate = Date;
let clock = RealDate.parse("2026-10-20T09:00:00Z");   // 12:00 Israel
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } };
const DAY = clock, NIGHT = RealDate.parse("2026-10-20T21:30:00Z");   // 00:30 Israel

// ---- a service account with a real RSA key ----
const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64").replace(/.{64}/g, "$&\n");
const SA = JSON.stringify({ type: "service_account", client_email: "luchit-reviews-reply@luchit.iam.gserviceaccount.com", private_key: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n` });
const TOKEN = "123456789:AAtestTOKEN", CHAT = "4242";
const ENV = () => ({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT, REVIEWS_SA_JSON: SA, ALERTS: kv });

// ---- mocks ----
let kv, kvMap, puts, gets, calls, reviews, replies, jwtOk, tgMsgs, tgNext, webhookUrl, failList, tokenFail;
function reset() {
  kvMap = new Map(); puts = 0; gets = 0; calls = []; reviews = []; replies = []; jwtOk = 0; tgMsgs = new Map(); tgNext = 100; webhookUrl = ""; failList = false; tokenFail = false;
  kv = { get: async (k, t) => { gets++; const v = kvMap.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; },
    put: async (k, v) => { puts++; kvMap.set(k, v); }, delete: async k => { kvMap.delete(k); }, list: async () => ({ keys: [] }) };
}
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const plain = h => h.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const review = (id, stars, text, { ts = 1760950000, answered = false } = {}) => ({ reviewId: id, authorName: "x",
  comments: [{ userComment: { text, starRating: stars, appVersionName: "1.32", lastModified: { seconds: String(ts) } } }, ...(answered ? [{ developerComment: { text: "old", lastModified: { seconds: "1" } } }] : [])] });
globalThis.fetch = async (u, o = {}) => {
  u = String(u); calls.push(u);
  if (u === "https://oauth2.googleapis.com/token") {
    if (tokenFail) return J({}, 400);
    const [h, p, s] = new URLSearchParams(o.body).get("assertion").split(".");
    const pay = JSON.parse(new TextDecoder().decode(unb64u(p)));
    const v = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", kp.publicKey, unb64u(s), new TextEncoder().encode(h + "." + p));
    if (!v || pay.scope !== "https://www.googleapis.com/auth/androidpublisher" || pay.aud !== "https://oauth2.googleapis.com/token" || JSON.parse(atob(h)).alg !== "RS256") return J({}, 401);
    jwtOk++; return J({ access_token: "ya29.t" });
  }
  if (u.startsWith("https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.ddsabag.pratirechev/reviews")) {
    if (o.headers?.authorization !== "Bearer ya29.t") return J({}, 401);
    const rest = decodeURIComponent(u.split("/reviews")[1]);
    if (rest.startsWith("?")) return failList ? J({ error: {} }, 403) : J({ reviews: structuredClone(reviews) });
    const reply = rest.endsWith(":reply"), id = rest.slice(1).replace(/:reply$/, ""), rv = reviews.find(r => r.reviewId === id);
    if (!rv) return J({}, 404);
    if (!reply) return J(structuredClone(rv));
    await new Promise(r => setTimeout(r, 40));   // a reply takes time: a second tap can arrive meanwhile
    const { replyText } = JSON.parse(o.body);
    if ([...replyText].length > 350) return J({}, 400);
    replies.push({ id, replyText });
    rv.comments = rv.comments.filter(c => !c.developerComment).concat({ developerComment: { text: replyText, lastModified: { seconds: "2" } } });
    return J({ result: { replyText, lastEdited: { seconds: "2" } } });
  }
  if (u.startsWith(`https://api.telegram.org/bot${TOKEN}/`)) {
    const m = u.split("/").pop(), b = JSON.parse(o.body || "{}");
    if (m === "sendMessage") { const msg = { message_id: tgNext++, chat: { id: +b.chat_id }, text: b.parse_mode ? plain(b.text) : b.text, entities: [], body: b }; tgMsgs.set(msg.message_id, msg); return J({ ok: true, result: msg }); }
    if (m === "editMessageText") { const msg = tgMsgs.get(b.message_id); msg.text = b.text; msg.edited = (msg.edited || 0) + 1; msg.kb = b.reply_markup; /* body keeps the buttons as sent, so a test can tap a stale one */ return J({ ok: true, result: msg }); }
    if (m === "getChat" && globalThis.chatFail) return J({ ok: false, description: "chat not found" }, 400);
    if (m === "getWebhookInfo") return J({ ok: true, result: { url: webhookUrl, pending_update_count: 0 } });
    if (m === "setWebhook") { webhookUrl = b.url; calls.push("setWebhook " + JSON.stringify(b)); return J({ ok: true, result: true }); }
    return J({ ok: true, result: true });
  }
  return J({}, 599);
};
const log = console.log;
let n = 0, bad = 0;
const ok = (c, m) => { n++; if (!c) { bad++; log("FAIL " + m); } };
const quiet = async f => { console.log = () => {}; try { return await f(); } finally { console.log = log; } };
const tick = (at = DAY, env = ENV()) => { clock = at; return quiet(() => worker.scheduled({}, env)); };
const tgCalls = m => calls.filter(c => c.endsWith("/" + m));
const sent = () => [...tgMsgs.values()];
const cards = () => sent().filter(m => m.body.reply_markup?.inline_keyboard?.[0]?.length === 3);
const SECRET = await W.hookSecret({ TELEGRAM_BOT_TOKEN: TOKEN });
const post = (upd, { secret = SECRET, env = ENV(), wk = worker } = {}) => quiet(() => wk.fetch(new Request("https://luchit-reviews.dd.workers.dev/tg",
  { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}) }, body: JSON.stringify(upd) }), env));
let qid = 0;
const tap = (msg, data, chat = CHAT, wk = worker) => post({ callback_query: { id: "q" + ++qid, data, from: { id: +CHAT }, message: { ...msg, chat: { id: +chat } } } }, { wk });
const btn = (msg, i) => msg.body.reply_markup.inline_keyboard[0][i].callback_data;
const answers = () => calls.filter(c => c.endsWith("/answerCallbackQuery")).length;

// ---- 1. classification ----
const CASES = [
  ["crash", 1, "האפליקציה קורסת כל פעם שאני לוחץ על חיפוש"], ["crash", 2, "לא נפתח בכלל אחרי העדכון, מסך לבן"], ["crash", 1, "App crashes on startup, useless"],
  ["crash", 3, "Doesn't work on my Galaxy, keeps freezing"], ["data", 2, "חסר מידע על מספר ידיים ברכב שלי"], ["data", 3, "הנתונים לא מעודכנים, הטסט מופיע מלפני שנה"],
  ["data", 2, "The mileage is wrong and the owner history is missing"], ["data", 1, "לא מצא את הרכב שלי בכלל"],
  ["feature", 4, "אפליקציה טובה, אשמח אם תוסיפו מצב כהה"], ["feature", 5, "Great app, please add an iPhone version"],
  ["price", 2, "יקר מדי, למה צריך לשלם על PRO?"], ["price", 1, "Subscription is too expensive for what you get"], ["price", 3, "המנוי לא שווה את הכסף"],
  ["praise", 5, "אחלה אפליקציה, עזרה לי לבדוק רכב לפני קנייה ממוכר"], ["praise", 5, "Excellent and very useful, thanks!"], ["praise", 4, "טובה מאוד"], ["praise", 3, "מעולה, פשוטה ונוחה"],
  ["dealer", 1, "הסוחר במגרש שיקר לי והרכב היה אחרי תאונה"], ["dealer", 2, "המוכר הסתיר שהרכב היה ליסינג"], ["dealer", 1, "The dealer lied to me about the car"],
  ["dealer", 5, "היבואן רימה אותי, טוב שיש את האפליקציה"], ["other", 1, "גרוע"], ["other", 2, "meh"], ["other", 3, "סבבה"],
];
for (const [want, s, t] of CASES) ok(W.classify(t, s) === want, `classify ${JSON.stringify(t)} (${s}*) = ${W.classify(t, s)}, want ${want}`);
ok(W.classify("עובד מצוין, מוכר מצוין", 5) === "praise", "happy review naming a seller is praise");
ok(W.classify("בעיקר טוב", 4) === "praise" && W.classify("פרופיל נוח", 4) === "praise", "יקר/פרו fenced (בעיקר, פרופיל)");

// ---- 2. drafts ----
const BANNED = /מציאה|משתלם|מומלץ|ממליצ|רמאי|עוקץ|(?<![א-ת])נוכל(?![א-ת])|נתקן|נוסיף|בקרוב|בגרסה הבאה|מבטיח|\d{7}/;
for (const [k, t] of Object.entries(W.TEMPLATES)) {
  ok(W.chars(t) <= 350 && t.trim().endsWith("צוות לוחית") && !W.PLATE.test(t) && !BANNED.test(t) && !W.invalid(t), `template ${k}: ${W.chars(t)} chars, signed, clean`);
}
ok(Object.keys(W.TEMPLATES).sort().join() === "crash,data,dealer,feature,other,praise,price", "one template per class");
for (const p of ["1234567", "12345678", "12-345-67", "123-45-678", "12 345 67", "123.45.678", "רכב 8212345 נבדק", "12–345–67"]) ok(W.PLATE.test(p), "plate " + p);
for (const p of ["2020-2024", "050-1234567", "0501234567", "1.32.1", "120,000 ק\"מ", "123456", "123456789"]) ok(!W.PLATE.test(p), "not a plate " + p);

// ---- 3. secrets missing / KV missing -> no work ----
for (const miss of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "REVIEWS_SA_JSON", "ALERTS"]) {
  reset(); reviews = [review("gp:a", 1, "קורס")];
  const env = ENV(); delete env[miss];
  await tick(DAY, env);
  ok(calls.length === 0 && puts === 0 && gets === 0, `missing ${miss}: no fetch, no KV (${calls.length} fetches, ${puts} puts)`);
}

// ---- 4. night silence ----
reset(); reviews = [review("gp:a", 1, "קורס כל הזמן")];
await tick(NIGHT);
ok(calls.length === 0 && puts === 0, "night: nothing fetched or written");
clock = RealDate.parse("2026-10-20T19:05:00Z");   // 22:05 Israel
await tick(clock);
ok(calls.length === 0, "22:05 Israel is night");

// ---- 5. a tick: loud 1-2, silent 3-5, skips answered, KV writes ----
reset();
reviews = [review("gp:one", 1, "האפליקציה קורסת <b>תמיד</b> & לא נפתחת", { ts: 1 }), review("gp:two", 2, "המוכר שיקר לי", { ts: 2 }), review("gp:three", 3, "סבבה", { ts: 3 }),
  review("gp:five", 5, "מעולה! 12-345-67", { ts: 4 }), review("gp:done", 1, "גרוע", { ts: 5, answered: true }), review("gp:empty", 1, "  ", { ts: 6 })];
await tick();
let c = cards();
ok(c.length === 4, "4 cards (answered and empty skipped): " + c.length);
ok(c.map(m => m.body.disable_notification).join() === "false,false,true,true", "1-2 loud, 3-5 silent: " + c.map(m => m.body.disable_notification));
ok(c[0].body.text.includes("&lt;b&gt;תמיד&lt;/b&gt; &amp;") && c[0].body.parse_mode === "HTML", "review text HTML-escaped");
ok(c[0].body.text.includes("⭐☆☆☆☆") && c[0].body.text.includes("גרסה: 1.32"), "stars and version shown");
ok(c.every(m => W.parseDraft(m.text) && !W.PLATE.test(W.parseDraft(m.text))), "drafts parse back and hold no plate");
ok(W.parseDraft(c[1].text) === W.TEMPLATES.dealer, "dealer draft for the seller complaint");
const allData = c.flatMap(m => m.body.reply_markup.inline_keyboard.flat().map(b => b.callback_data));
ok(allData.every(d => new TextEncoder().encode(d).length <= 64) && Math.max(...allData.map(d => d.length)) <= 25, "callback_data under 64 bytes: max " + Math.max(...allData.map(d => d.length)));
ok(jwtOk === 1, "JWT RS256 signed with WebCrypto, verified by the mock token endpoint");
ok(puts === 5, "KV writes on a tick with 4 new reviews: 4 + health = " + puts);
let p0 = puts, m0 = tgMsgs.size; await tick();
ok(puts === p0 && tgMsgs.size === m0, "next tick, nothing new: 0 KV writes, 0 messages");
clock += 3 * 36e5; p0 = puts; await tick(clock);
ok(puts === p0 + 1, "health refreshed at most every 2 h: 1 write after 3 h");
clock = DAY;

// ---- 6. webhook auth ----
let r = await post({ callback_query: { id: "x", data: btn(c[1], 0), message: { ...c[1], chat: { id: +CHAT } } } }, { secret: "wrong" });
ok(r.status === 403, "wrong secret header -> 403");
r = await post({ callback_query: { id: "x", data: btn(c[1], 0), message: { ...c[1], chat: { id: +CHAT } } } }, { secret: "" });
ok(r.status === 403, "no secret header -> 403");
const before = calls.length, pb = puts, gb = gets;
r = await tap(c[1], btn(c[1], 0), "999");
ok(r.status === 200 && calls.length === before && puts === pb && gets === gb, "wrong chat -> no work (no fetch, no KV read or write)");
r = await quiet(() => worker.fetch(new Request("https://luchit-reviews.dd.workers.dev/tg", { method: "GET" }), ENV()));
ok(r.status === 404, "GET /tg -> 404");

// ---- 7. שלח: once, also on a double tap ----
await tap(c[0], btn(c[0], 0));
ok(replies.length === 1 && replies[0].id === "gp:one" && replies[0].replyText === W.TEMPLATES.crash, "שלח published the crash draft");
ok(c[0].text.includes("✅ נשלח ל-Google Play") && c[0].kb.inline_keyboard.length === 0, "message edited: sent, buttons gone");
await tap(c[0], btn(c[0], 0));
ok(replies.length === 1, "second tap on שלח: no second publish");
const a0 = answers();
await Promise.all([tap(c[3], btn(c[3], 0)), tap(c[3], btn(c[3], 0))]);
ok(replies.filter(x => x.id === "gp:five").length === 1, "two concurrent taps: published once");
ok(answers() === a0 + 2, "every callback answered");
reviews.push(review("gp:iso", 5, "מעולה", { ts: 30 })); await tick(); const ci = cards().at(-1);
const t1 = tap(ci, btn(ci, 0)); await new Promise(r => setTimeout(r, 15)); const t2 = tap(ci, btn(ci, 0), CHAT, W2); await Promise.all([t1, t2]);
ok(replies.filter(x => x.id === "gp:iso").length === 1, "tap redelivered to another isolate while the first reply is in flight: published once (KV busy)");

// ---- 8. already answered elsewhere ----
reviews.find(x => x.reviewId === "gp:three").comments.push({ developerComment: { text: "from console", lastModified: { seconds: "9" } } });
await tap(c[2], btn(c[2], 0));
ok(!replies.some(x => x.id === "gp:three") && c[2].text.includes("כבר יש תשובה"), "review with a developer reply: refused, not overwritten");

// ---- 9. ערוך ----
const card2 = c[1], fr0 = tgMsgs.size;
await tap(card2, btn(card2, 1));
const prompt = sent().at(-1);
ok(tgMsgs.size === fr0 + 1 && prompt.body.reply_markup.force_reply === true && prompt.text.startsWith("✏️ נוסח חדש לתשובה #"), "ערוך -> ForceReply prompt");
const answer = text => post({ message: { message_id: 900 + qid++, chat: { id: +CHAT }, from: { id: +CHAT }, text, reply_to_message: { ...prompt, from: { id: 123456789, is_bot: true } } } });
p0 = puts;
await answer("א".repeat(351));
ok(sent().at(-1).text.includes("ארוך מדי") && puts === p0, "too long edit refused, nothing stored");
await answer("תודה, נבדוק את רכב 12-345-67");
ok(sent().at(-1).text.includes("מספר רכב") && puts === p0, "plate in edit refused");
await answer("   ");
ok(sent().at(-1).text.includes("ריק") && puts === p0, "empty edit refused");
await post({ message: { message_id: 950, chat: { id: +CHAT }, from: { id: +CHAT }, text: "סתם", reply_to_message: { ...prompt, from: { id: 5555, is_bot: true } } } });
ok(!sent().at(-1).text.includes("סתם"), "a reply to someone else's message is ignored");
await answer("תודה על הפנייה, נשמח לשמוע עוד ב-support@luchit.app");
const conf = sent().at(-1);
ok(conf.body.reply_markup.inline_keyboard[0].length === 2 && W.parseDraft(conf.text) === "תודה על הפנייה, נשמח לשמוע עוד ב-support@luchit.app\nצוות לוחית", "edit confirmed, signature appended, [שלח] [בטל]");
await tap(card2, btn(card2, 0));
ok(!replies.some(x => x.id === "gp:two"), "שלח on the original card after an edit: stale, refused");
await tap(conf, btn(conf, 1));
ok(conf.text.includes("בוטל"), "בטל reverts to the original draft");
await tap(conf, btn(conf, 0));
ok(!replies.some(x => x.id === "gp:two"), "שלח on a cancelled edit: refused");
await tap(card2, btn(card2, 1)); const prompt2 = sent().at(-1);
await post({ message: { message_id: 990, chat: { id: +CHAT }, from: { id: +CHAT }, text: "נוסח שני וסופי. צוות לוחית", reply_to_message: { ...prompt2, from: { id: 123456789, is_bot: true } } } });
const conf2 = sent().at(-1);
await tap(conf2, btn(conf2, 0)); await tap(conf2, btn(conf2, 0));
ok(replies.filter(x => x.id === "gp:two").length === 1 && replies.find(x => x.id === "gp:two").replyText === "נוסח שני וסופי. צוות לוחית", "שלח on the edit publishes the edited text once");
reviews.push(review("gp:six", 2, "לא מעודכן", { ts: 20 })); await tick(); const c6 = cards().at(-1);
await tap({ ...c6, text: c6.text.replace("תודה", "שלום") }, btn(c6, 0));
ok(!replies.some(x => x.id === "gp:six"), "a draft that does not match its fingerprint is not sent");

// ---- 10. דלג ----
await tap(c6, btn(c6, 2));
ok(c6.text.includes("⏭ דולג") && JSON.parse(kvMap.get([...kvMap.keys()].find(k => kvMap.get(k).includes("gp:six")))).st === "skip", "דלג marks handled and edits the message");
await tap(c6, btn(c6, 0));
ok(!replies.some(x => x.id === "gp:six"), "שלח after דלג refused");
m0 = tgMsgs.size; await tick();
ok(tgMsgs.size === m0, "skipped review is not posted again");
reviews.find(x => x.reviewId === "gp:six").comments[0].userComment.lastModified.seconds = "99"; await tick();
ok(tgMsgs.size === m0, "skipped review edited by the user: still not posted");

// ---- 11. an edited open review is posted again, marked updated ----
reset(); reviews = [review("gp:u", 4, "טובה", { ts: 1 })]; await tick();
reviews[0].comments[0].userComment = { ...reviews[0].comments[0].userComment, text: "טובה אבל קורסת", starRating: 2, lastModified: { seconds: "50" } }; await tick();
ok(cards().length === 2 && cards()[1].text.includes("שעודכנה") && W.parseDraft(cards()[1].text) === W.TEMPLATES.crash, "edited review posted again as updated");

// ---- 11b. KV read failing: nothing posted (never repost blind) ----
reset(); reviews = [review("gp:k", 1, "קורס")]; await tick(); m0 = tgMsgs.size;
kv.get = async () => { throw new Error("kv down"); }; await tick();
ok(tgMsgs.size === m0, "KV read failure: no repost");

// ---- 12. list failure: health, one message after 3 h ----
reset(); failList = true; await tick();
ok(JSON.parse(kvMap.get("rv:h")).list === false && tgMsgs.size === 0, "list failure recorded, no message yet");
p0 = puts; clock = DAY + 36e5; await tick(clock);
ok(puts === p0, "second failing tick: no KV write");
clock = DAY + 3.1 * 36e5; await tick(clock); clock = DAY + 3.6 * 36e5; await tick(clock);
ok(sent().filter(m => m.text.includes("Google Play לא עונה")).length === 1, "told once after 3 h of failures");
failList = false; await tick(clock);
ok(JSON.parse(kvMap.get("rv:h")).list === true, "recovery recorded");
reset(); tokenFail = true; await tick(DAY, { ...ENV(), REVIEWS_SA_JSON: SA.replace("luchit-reviews-reply@", "other@") });   // another key: no cached token
ok(JSON.parse(kvMap.get("rv:h")).list === false, "auth failure counts as a failed list");
clock = DAY;

// ---- 13. /health ----
reset(); reviews = []; await tick();
const H = async (env = ENV()) => quiet(async () => JSON.parse(await (await worker.fetch(new Request("https://luchit-reviews.dd.workers.dev/health"), env)).text()));
let h = await H();
ok(Object.keys(h).sort().join() === "lastTick,list,sa,tg,v,webhook", "health fields whitelist: " + Object.keys(h).join());
ok(h.v === "reviews-1" && h.tg === true && h.sa === true && h.list === true && h.webhook === true && typeof h.lastTick === "string", "health all true " + JSON.stringify(h));
const sw = calls.find(x => x.startsWith("setWebhook "));
ok(sw && JSON.parse(sw.slice(11)).url === "https://luchit-reviews.dd.workers.dev/tg" && JSON.parse(sw.slice(11)).secret_token === SECRET && JSON.parse(sw.slice(11)).max_connections === 1, "setWebhook to <origin>/tg with the derived secret, max_connections 1");
ok(/^[0-9a-f]{32}$/.test(SECRET), "secret token is 32 hex chars (Telegram allows A-Z a-z 0-9 _ -)");
const body = JSON.stringify(h);
ok(!/gp:|קורס|\d{4,}(?!-)/.test(body.replace(h.lastTick, "")), "health holds no ids, text or numbers");
globalThis.chatFail = true; clock += 61e3; h = await H(); globalThis.chatFail = false; clock = DAY;
ok(h.tg === false && h.webhook === true, "health: a wrong chat id shows tg false");
reset(); h = await H({ ALERTS: kv });
ok(h.tg === false && h.sa === false && h.webhook === false && h.list === null && calls.length === 0, "health without secrets: all false, no Telegram call");

log(bad ? `reviews test: ${bad} of ${n} checks FAILED` : `reviews test ok (${n} checks)`);
process.exit(bad ? 1 : 0);
