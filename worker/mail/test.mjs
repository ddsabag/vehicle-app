// Offline test of luchit-mail (worker/mail/worker.js): the classifier, the bulk check on headers, routing per class x ALERT_ROUTE x
// day/night x KV state, today's request kept byte-identical while a level is not routed, no mail content in KV or logs, and exactly one
// forward whatever fails. Mocked fetch, KV, message and clock (timers run 100x faster). Loaded as a data: URL, so any Node 20+ reads it as ESM.
//   node worker/mail/test.mjs
import fs from "node:fs";

const src = fs.readFileSync(new URL("./worker.js", import.meta.url), "utf8");
const load = async s => import("data:text/javascript," + encodeURIComponent(s));
const { default: w, summarise } = await load(src);
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (f, t, ...a) => realTimeout(f, (t || 0) / 100, ...a);

const RealDate = Date;
let clock = 0;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } };
const DAY = RealDate.parse("2026-10-20T09:00:00Z"), NIGHT = RealDate.parse("2026-10-20T21:30:00Z");   // 12:00 and 00:30 in Israel
const DAY_W = RealDate.parse("2026-10-26T07:00:00Z"), NIGHT_W = RealDate.parse("2026-10-25T20:30:00Z");   // winter time (UTC+2): 09:00, 22:30

let n = 0, bad = 0;
const log = console.log, ok = (c, m) => { n++; if (!c) { bad++; log("FAIL " + m); } };
let tg = [], tgPlan = "ok";
globalThis.fetch = async (u, o = {}) => {
  u = String(u);
  if (!u.startsWith("https://api.telegram.org/bot")) return new Response("unexpected", { status: 599 });
  tg.push({ raw: o.body, ...JSON.parse(o.body) });
  if (tgPlan === "throw") throw new TypeError("fetch failed");
  return new Response(JSON.stringify({ ok: tgPlan === "ok" }), { status: tgPlan === "ok" ? 200 : tgPlan });
};

const FROM = "dana.cohen@example.com";
const b2047 = s => `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`;   // header values are bytes: a Hebrew subject travels encoded, as in real mail
const mime = (subject, body, hdr = {}) => Object.entries({ Subject: b2047(subject), "Content-Type": "text/plain; charset=utf-8", ...hdr })
  .map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n" + body;
function msg(subject, body, hdr = {}, { rawThrows = false, forwardThrows = false } = {}) {
  const m = { from: FROM, to: "support@luchit.app", forwards: [], headers: new Headers({ subject: b2047(subject), ...hdr }),
    raw: rawThrows ? new ReadableStream({ start(c) { c.error(new Error("stream broke")); } }) : new Response(mime(subject, body, hdr)).body,
    async forward(to) { m.forwards.push(to); if (forwardThrows) throw new Error("forward failed"); } };
  return m;
}
const BASE = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c", FORWARD_TO: "inbox@example.com" };
function kv(state, { putThrows = false } = {}) {   // state: "alive" (tick 1 min old), "stale" (30 min), "empty"
  const k = { puts: [], async get(key) { return key === "u" && state !== "empty" ? { tick: new RealDate(clock - (state === "alive" ? 1 : 30) * 6e4).toISOString(), tg: true } : null; },
    async put(key, v, o) { if (putThrows) throw new Error("kv down"); k.puts.push({ key, v, o }); } };
  return k;
}
let logs = [];
async function run(m, env, { at = DAY, plan = "ok", other = {} } = {}) {
  clock = at; tg = []; tgPlan = plan; logs = [];
  console.log = (...a) => logs.push(a.join(" "));
  let err = null;
  try { await (other.worker || w).email(m, { ...BASE, ...env }); } catch (e) { err = e; } finally { console.log = log; }
  return err;
}

// 1. classifier (spec 13.1, 15.1 item 7)
const cls = (subject, body = "") => summarise(FROM, subject, mime(subject, body)).cls.key;
for (const t of ["אנא מחקו את המידע שלי", "תמחקו את הפרטים שלי", "Please erase my data", "Please delete all my data", "בקשה להסיר את הפרטים שלי",
  "Please delete my account", "שאלה על מדיניות הפרטיות", "בקשת מחיקה"]) ok(cls("פנייה", t) === "privacy", "privacy: " + t);
for (const t of ["Your weekly digest. To unsubscribe, click here.", "להסרה מרשימת התפוצה לחצו כאן", "הסר", "אפשר להסיר פרסומות מהאפליקציה?"])
  ok(cls("עדכון", t) !== "privacy", "not privacy: " + t);
ok(cls("שלום", "כתבתי לכם לגבי הבדיקה") !== "biz", "not biz: כתבתי לכם");
for (const t of ["אני עיתונאית מ-ynet", "רוצים לכתוב כתבה על האפליקציה", "הוא כתב בעיתון", "הצעה לשיתוף פעולה"]) ok(cls("שלום", t) === "biz", "biz: " + t);
ok(cls("האפליקציה קורסת") === "crash" && cls("נתון שגוי ברכב") === "data" && cls("שאלה כללית", "תודה רבה") === "other", "crash, data, other unchanged");

// 2. routing matrix (spec 13.3): class x ALERT_ROUTE x day/night x KV
const MAILS = {
  privacy: { m: () => msg("בקשה", "תמחקו את הפרטים שלי"), level: "day", key: "mail:privacy",
    text: "🔴 <b>פנייה חדשה ללוחית: פרטיות או מחיקה</b>\nמאת: dana.cohen@example.com\nנושא: בקשה\n\nתמחקו את הפרטים שלי\n\nלמענה: השיבו מהמייל (נשמר גם בג'ימייל)" },
  crash: { m: () => msg("האפליקציה קורסת", "נפתחת ונסגרת <מיד> & זהו"), level: "day", key: "mail:crash",
    text: "🔴 <b>פנייה חדשה ללוחית: תקלה באפליקציה</b>\nמאת: dana.cohen@example.com\nנושא: האפליקציה קורסת\n\nנפתחת ונסגרת &lt;מיד&gt; &amp; זהו\n\nלמענה: השיבו מהמייל (נשמר גם בג'ימייל)" },
  data: { m: () => msg("טעות", "שנת הייצור לא נכונה"), level: "summary",
    text: "🟡 <b>פנייה חדשה ללוחית: טעות בנתוני רכב</b>\nמאת: dana.cohen@example.com\nנושא: טעות\n\nשנת הייצור לא נכונה\n\nלמענה: השיבו מהמייל (נשמר גם בג'ימייל)" },
  biz: { m: () => msg("הצעה לשיתוף פעולה", ""), level: "summary",
    text: "🔵 <b>פנייה חדשה ללוחית: שיתוף פעולה או עיתונות</b>\nמאת: dana.cohen@example.com\nנושא: הצעה לשיתוף פעולה\n\n(אין טקסט רגיל בהודעה)\n\nלמענה: השיבו מהמייל (נשמר גם בג'ימייל)" },
  other: { m: () => msg("שלום", "כתבתי לכם לגבי הבדיקה"), level: "summary",
    text: "⚪ <b>פנייה חדשה ללוחית: אחר</b>\nמאת: dana.cohen@example.com\nנושא: שלום\n\nכתבתי לכם לגבי הבדיקה\n\nלמענה: השיבו מהמייל (נשמר גם בג'ימייל)" },
  bulk: { m: () => msg("הניוזלטר השבועי", "להסרה מרשימת התפוצה", { "List-Unsubscribe": "<https://news.example.com/u>" }), level: "silent",
    text: "⚪ <b>פנייה חדשה ללוחית: אחר</b>\nמאת: dana.cohen@example.com\nנושא: הניוזלטר השבועי\n\nלהסרה מרשימת התפוצה\n\nלמענה: השיבו מהמייל (נשמר גם בג'ימייל)" },
};
// today's request (worker.js before the router), byte for byte
const today = text => JSON.stringify({ chat_id: "c", text, parse_mode: "HTML", disable_web_page_preview: true });
const isRouted = (r, lv) => { const l = String(r ?? "").split(",").map(s => s.trim().toLowerCase()); return l.includes("all") || l.includes(lv); };
const NIGHT_LINE = "\n\n🌙 נשלח בשקט כי עכשיו לילה. צלצול תזכורת יגיע בבוקר.";
const PRIVATE = ["dana", "example.com", "תמחקו", "קורסת", "שנת הייצור", "שיתוף", "כתבתי", "הניוזלטר", "בקשה"];
let cases = 0;
for (const [name, c] of Object.entries(MAILS))
  for (const route of [undefined, "", "critical", "silent", "summary", "day", "critical,silent", "summary,day", "all", "ALL", " day , summary ", "bogus"])
    for (const [when, at] of [["day", DAY], ["night", NIGHT], ["winter day", DAY_W], ["winter night", NIGHT_W]])
      for (const kvState of ["none", "empty", "stale", "alive"]) {
        cases++;
        const m = c.m(), ALERTS = kvState === "none" ? undefined : kv(kvState), env = { ...(route === undefined ? {} : { ALERT_ROUTE: route }), ...(ALERTS ? { ALERTS } : {}) };
        const err = await run(m, env, { at });
        const id = `${name} route=${JSON.stringify(route)} ${when} kv=${kvState}`, r = isRouted(route, c.level), night = when.includes("night");
        ok(!err, id + ": no throw " + err);
        ok(m.forwards.length === 1 && m.forwards[0] === "inbox@example.com", id + ": forwarded once");
        const puts = ALERTS ? ALERTS.puts : [];
        if (!r) {
          ok(tg.length === 1 && tg[0].raw === today(c.text), id + ": unrouted = today's request " + JSON.stringify(tg));
          ok(!puts.length, id + ": unrouted writes no KV");
        } else if (c.level === "silent") ok(tg.length === 0 && !puts.length, id + ": bulk = Gmail only");
        else if (c.level === "summary") ok(tg.length === 1 && tg[0].text === c.text && tg[0].disable_notification === true && tg[0].parse_mode === "HTML", id + ": one silent message");
        else if (night && kvState === "alive") {
          ok(tg.length === 1 && tg[0].text === c.text + NIGHT_LINE && tg[0].disable_notification === true, id + ": night silent with the moon line");
          ok(puts.length === 1 && /^p:\d+$/.test(puts[0].key) && puts[0].o?.expirationTtl === 172800, id + ": one pointer");
          const v = JSON.parse(puts[0]?.v || "{}");
          ok(Object.keys(v).join() === "c,at" && v.c === c.key && v.at === new RealDate(at).toISOString(), id + ": pointer holds class and time only " + puts[0]?.v);
        } else {
          ok(tg.length === 1 && tg[0].text === c.text && tg[0].disable_notification === false && tg[0].parse_mode === "HTML", id + ": loud " + JSON.stringify(tg));
          ok(!puts.length, id + ": no pointer");
        }
        ok(logs.every(l => !PRIVATE.some(p => l.includes(p))), id + ": no mail content in logs " + JSON.stringify(logs));
      }

// 3. bulk by headers only (spec 13.2): routed silent = no Telegram; anything else is not bulk
const ALL = { ALERT_ROUTE: "all" };
for (const h of [{ "List-Unsubscribe": "<mailto:u@x.example>" }, { "List-Id": "<news.x.example>" }, { Precedence: "bulk" }, { Precedence: "list" },
  { Precedence: "Junk" }, { "Auto-Submitted": "auto-replied" }, { "Auto-Submitted": "auto-generated" }]) {
  const m = msg("תמחקו את הפרטים שלי", "תמחקו את הפרטים שלי", h);
  await run(m, ALL);
  ok(tg.length === 0 && m.forwards.length === 1, "bulk by " + JSON.stringify(h));
}
for (const h of [{}, { "Auto-Submitted": "no" }, { Precedence: "first-class" }, { "Reply-To": "no-reply@x.example" }]) {
  const m = msg("תמחקו את הפרטים שלי", "", h);
  await run(m, ALL);
  ok(tg.length === 1 && tg[0].disable_notification === false && m.forwards.length === 1, "not bulk: " + JSON.stringify(h));
}
{ const m = msg("שאלה", "שלום"); m.from = "no-reply@shop.example"; await run(m, ALL); ok(tg.length === 1 && tg[0].disable_notification === true, "a no-reply sender alone is not bulk"); }

// 4. failures (spec 13.4, 15.1 item 7): forward exactly once, a message still goes out where today it would
for (const route of [undefined, "all"]) for (const at of [DAY, NIGHT]) for (const cl of ["privacy", "data", "bulk"]) {
  const id = `${cl} route=${route} ${at === DAY ? "day" : "night"}`, env = route ? { ALERT_ROUTE: route, ALERTS: kv("alive") } : {};
  let m = MAILS[cl].m(), err = await run(m, env, { at, plan: "throw" });
  ok(!err && m.forwards.length === 1, id + ": Telegram throws -> forwarded once");
  ok(route && cl === "bulk" ? tg.length === 0 : tg.length >= 1 && tg.at(-1).raw === today(MAILS[cl].text), id + ": Telegram throws -> today's request is the last try");
  m = MAILS[cl].m(); err = await run(m, env, { at, plan: 500 });
  ok(!err && m.forwards.length === 1 && (route && cl === "bulk" ? !tg.length : tg.at(-1).raw === today(MAILS[cl].text)), id + ": Telegram 500 -> legacy last, forwarded once");
  m = MAILS[cl].m(); err = await run(m, { ...env, ...(route ? { ALERTS: kv("alive", { putThrows: true }) } : {}) }, { at });
  ok(!err && m.forwards.length === 1, id + ": KV.put throws -> forwarded once");
  if (route && cl === "privacy" && at === NIGHT) ok(tg.length === 1 && tg[0].raw === today(MAILS[cl].text), id + ": KV.put throws -> today's loud message");
  m = msg("x", "y", {}, { rawThrows: true }); err = await run(m, env, { at });
  ok(!err && m.forwards.length === 1 && tg.length === 0, id + ": reading raw throws -> forwarded once (today: not forwarded)");
}
{ const m = MAILS.privacy.m(), err = await run(m, {}, { plan: 403 }); ok(!err && tg.length === 1 && m.forwards.length === 1, "unrouted Telegram 403: one try, as today"); }
{ const m = msg("בקשה", "תמחקו", {}, { forwardThrows: true }), err = await run(m, {});
  ok(err?.message === "forward failed" && tg.length === 1 && m.forwards.length === 1, "a failing forward still throws, as today"); }
{ const m = MAILS.privacy.m(), err = await run(m, { TELEGRAM_BOT_TOKEN: undefined, ALERT_ROUTE: "all" });
  ok(!err && tg.length === 1 && m.forwards.length === 1, "no Telegram secrets, routed: today's request (fails as today), forwarded"); }
// the router block missing or broken (a bad paste): today's message once, forwarded once
const S = "// >>> alert-lib v1", E = "// <<< alert-lib v1";
const broken = (await load(src.slice(0, src.indexOf(S)) + src.slice(src.indexOf(E) + E.length))).default;
for (const route of [undefined, "all"]) {
  const m = MAILS.privacy.m(), err = await run(m, route ? { ALERT_ROUTE: route } : {}, { other: { worker: broken } });
  ok(!err && tg.length === 1 && tg[0].raw === today(MAILS.privacy.text) && m.forwards.length === 1, `no router block, route=${route}: today's message once, forwarded once`);
}

log(bad ? `luchit-mail test: ${bad} of ${n} checks FAILED` : `luchit-mail test ok (${n} checks, ${cases} routing cases)`);
process.exit(bad ? 1 : 0);
