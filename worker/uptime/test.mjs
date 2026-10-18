// Offline test of luchit-uptime (worker/uptime/worker.js): probes, paging, observe mode, reminders, recovery, the mail morning ring,
// the GitHub heartbeat watch, one KV write per tick and the /health whitelist. Mocked fetch, KV and clock (timers run 100x faster);
// a stub cloudflare:email module. The Worker is loaded as a data: URL, so any Node 20+ reads it as ESM.
//   node worker/uptime/test.mjs
import fs from "node:fs";
import { register } from "node:module";

register("data:text/javascript," + encodeURIComponent(`export async function resolve(s, c, next) {
  return s === "cloudflare:email" ? { url: "data:text/javascript,export class EmailMessage { constructor(f, t, r) { this.raw = r; } }", shortCircuit: true } : next(s, c);
}`));
const src = fs.readFileSync(new URL("./worker.js", import.meta.url), "utf8");
const w = (await import("data:text/javascript," + encodeURIComponent(src))).default;
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (f, t, ...a) => realTimeout(f, (t || 0) / 100, ...a);

const RealDate = Date;
let clock = 0;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } };
const T = s => RealDate.parse(s), M = 6e4, H = 36e5;
const enc = s => (typeof s === "string" ? new TextEncoder().encode(s) : s);
const HB = "https://raw.githubusercontent.com/ddsabag/vehicle-app/alert-state/heartbeat.json";
const OKPAGE = ["<!doctype html><html><head>", '<input id="pl', 'ate" type="text">', "</body></html>"];   // the marker split across chunks
let site, tg, chk, mails, brevo, hb, hbReads, tgDown, tgCode, chkCodes, homeHits, pulled, cancels, logs;
const reset = () => { site = { home: { status: 200, chunks: OKPAGE }, api: { status: 302, loc: "https://luchit.app/magazine/?subscribed=expired" } }; hb = undefined; tgDown = false; tgCode = 0; chkCodes = []; };
globalThis.fetch = async (u, o = {}) => {
  u = String(u);
  if (u.startsWith("https://api.telegram.org/")) {
    if (u.includes("/getChat?")) { chk++; ok(u.endsWith("?chat_id=SECRET"), "getChat names the chat"); return new Response("{}", { status: chkCodes.shift() || (tgDown ? 401 : 200) }); }
    tg.push(JSON.parse(o.body)); return new Response("{}", { status: tgCode || (tgDown ? 500 : 200) });
  }
  if (u.startsWith("https://api.brevo.com/")) { brevo.push(JSON.parse(o.body)); return new Response("{}", { status: 201 }); }
  if (u === HB) { hbReads++; return hb === undefined ? new Response("404: Not Found", { status: 404 }) : new Response(JSON.stringify({ t: hb })); }
  const home = /^https:\/\/luchit\.app\/\?u=\d+$/.test(u); homeHits += home;
  let s = u.startsWith("https://luchit.app/api/confirm?") ? site.api : home ? site.home : null;
  if (Array.isArray(s)) s = s.length > 1 ? s.shift() : s[0];   // one answer per try
  if (!s) return new Response("unexpected", { status: 599 });
  if (s === "timeout") throw new DOMException("timed out", "TimeoutError");
  if (s === "net") throw new TypeError("fetch failed");
  if (s.loc !== undefined || s.status === 302) { ok(o.redirect === "manual", "api probe uses redirect: manual"); return new Response(null, { status: s.status, headers: s.loc ? { location: s.loc } : {} }); }
  let i = 0;
  return new Response(new ReadableStream({ pull(c) { if (i < (s.chunks || []).length) { pulled++; c.enqueue(enc(s.chunks[i++])); } else c.close(); }, cancel() { cancels++; } }), { status: s.status });
};
function KV(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  return { m, puts: 0, dels: 0, fail: false,
    async get(k, t) { if (this.fail) throw new Error("kv down"); const v = m.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; },
    async put(k, v) { this.puts++; m.set(k, v); },
    async list({ prefix }) { return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
    async delete(k) { this.dels++; m.delete(k); } };
}
const log = console.log;
let n = 0, bad = 0;
function ok(c, m) { n++; if (!c) { bad++; log("FAIL " + m); } }
async function tick(env, at) {
  clock = at; tg = []; chk = 0; homeHits = 0; mails = []; brevo = []; hbReads = 0; pulled = 0; cancels = 0; logs = [];
  const p0 = env.ALERTS?.puts || 0;
  console.log = (...a) => logs.push(a.join(" "));
  try { await w.scheduled({ scheduledTime: at, cron: "*/10 * * * *" }, env, {}); } finally { console.log = log; }
  ok(!logs.some(l => /[֐-׿]|TOKEN|SECRET/.test(l)), "logs hold no Hebrew text and no secret " + JSON.stringify(logs));
  return { tg, mails, brevo, puts: (env.ALERTS?.puts || 0) - p0, logs };
}
const U = env => JSON.parse(env.ALERTS.m.get("u"));
async function health(env, path = "/health", method = "GET") {
  const r = await w.fetch(new Request("https://luchit-uptime.example.workers.dev" + path, { method }), env);
  return { status: r.status, j: r.status === 404 ? null : await r.json() };
}
const mailEnv = () => ({ send: async m => { mails.push(m.raw); } });
const PAGE = () => ({ ALERTS: KV(), TELEGRAM_BOT_TOKEN: "TOKEN", TELEGRAM_CHAT_ID: "SECRET", ALERT_ROUTE: "critical", MAIL: mailEnv() });
const DAY = T("2026-10-20T09:00:00Z");   // 12:00 in Israel, not a heartbeat hour

// 0. the block is a byte-identical copy of worker/lib/alert-lib.js
{
  const lib = fs.readFileSync(new URL("../lib/alert-lib.js", import.meta.url), "utf8"), A = "// >>> alert-lib v1", B = "// <<< alert-lib v1";
  const blk = s => s.slice(s.indexOf(A), s.indexOf(B) + B.length);
  ok(src.includes(A) && blk(src) === blk(lib), "alert-lib v1 block is byte-identical to worker/lib/alert-lib.js");
}

// 1. paging mode: hello, 1 bad tick -> nothing, 2 -> one critical + email, 3rd -> nothing, recovery -> one silent line
reset();
let env = PAGE(), x;
x = await tick(env, DAY);
ok(x.tg.length === 1 && x.tg[0].disable_notification === true && /בדיקת הזמינות פועלת/.test(x.tg[0].text) && x.puts === 1, "first tick: one silent hello, one KV write " + JSON.stringify(x.tg));
let h = await health(env);
ok(h.status === 200 && h.j.mode === "page" && h.j.armed.home && h.j.armed.api && h.j.tg === true && h.j.email === true && h.j.tick === new RealDate(DAY).toISOString(), "/health after a good tick " + JSON.stringify(h.j));
ok(JSON.stringify(Object.keys(h.j)) === '["v","mode","tick","armed","tg","email"]' && JSON.stringify(Object.keys(h.j.armed)) === '["home","api"]' && h.j.v === "uptime-1", "/health field whitelist");
ok((await health(env, "/")).status === 404 && (await health(env, "/health", "POST")).status === 404 && (await health(env, "/u")).status === 404, "anything else -> 404");
x = await tick(env, DAY + 10 * M);
ok(x.tg.length === 0 && x.puts === 1, "healthy tick: no message");
site.home = { status: 503, chunks: ["down"] };
x = await tick(env, DAY + 20 * M);
ok(x.tg.length === 0 && x.mails.length === 0 && x.puts === 1 && U(env).probes.home.fails === 1, "1 bad tick -> nothing");
x = await tick(env, DAY + 30 * M);
ok(x.tg.length === 1 && x.tg[0].disable_notification === false && /לוחית לא זמינה/.test(x.tg[0].text) && /דף הבית לא עונה כבר 10 דקות \(2 בדיקות ברצף/.test(x.tg[0].text) && /HTTP 503/.test(x.tg[0].text),
  "2 bad ticks -> one loud page " + JSON.stringify(x.tg));
ok(x.mails.length === 1 && /Subject: =\?UTF-8\?B\?/.test(x.mails[0]) && x.puts === 1, "page: email in parallel, one KV write");
x = await tick(env, DAY + 40 * M);
ok(x.tg.length === 0 && x.mails.length === 0 && x.puts === 1, "3rd bad tick -> nothing");
site.home = { status: 200, chunks: OKPAGE };
x = await tick(env, DAY + 50 * M);
ok(x.tg.length === 1 && x.tg[0].disable_notification === true && /^✅ דף הבית חזר לעבוד אחרי 30 דקות$/.test(x.tg[0].text) && x.mails.length === 0, "recovery -> one silent line " + JSON.stringify(x.tg));
x = await tick(env, DAY + 60 * M);
ok(x.tg.length === 0 && U(env).probes.home.fails === 0 && !U(env).probes.home.pagedAt, "after recovery: quiet, state reset");

// 2. both probes down in the same tick -> one message; a timeout and a wrong redirect are failures
site.home = "timeout"; site.api = { status: 302, loc: "https://luchit.app/magazine/?subscribed=error" };
await tick(env, DAY + 70 * M);
x = await tick(env, DAY + 80 * M);
ok(x.tg.length === 1 && /דף הבית/.test(x.tg[0].text) && /שירות ההרשמה \(\/api\)/.test(x.tg[0].text) && /פג הזמן/.test(x.tg[0].text) && /הפניה לא צפויה/.test(x.tg[0].text) && x.mails.length === 1,
  "two probes down -> one page, one email " + JSON.stringify(x.tg));
reset();
x = await tick(env, DAY + 90 * M);
ok(x.tg.length === 1 && /דף הבית חזר/.test(x.tg[0].text) && /שירות ההרשמה \(\/api\) חזר/.test(x.tg[0].text), "both recover -> one silent message");

// 2b. the retry 5 s later in the same tick: 503 then 200 is no failure; two failed tries are one
reset(); env = PAGE();
await tick(env, DAY);
site.home = [{ status: 503, chunks: ["down"] }, { status: 200, chunks: OKPAGE }];
await tick(env, DAY + 10 * M);
ok(homeHits === 2 && U(env).probes.home.fails === 0 && U(env).probes.home.last === "200", "first try fails, retry works -> fails 0 (" + homeHits + " home fetches)");
site.home = [{ status: 503, chunks: [] }, { status: 502, chunks: [] }];
await tick(env, DAY + 20 * M);
ok(homeHits === 2 && U(env).probes.home.fails === 1 && U(env).probes.home.last === "502", "both tries fail -> fails 1");
// a recovery line that Telegram refused is sent on the next OK tick, once; a new page drops it
site.home = { status: 503, chunks: [] };
x = await tick(env, DAY + 30 * M);
ok(x.tg.length === 1 && !!U(env).probes.home.pagedAt, "paged");
site.home = { status: 200, chunks: OKPAGE }; tgDown = true;
x = await tick(env, DAY + 40 * M);
ok(x.tg.length === 2 && U(env).probes.home.back > 0 && !U(env).probes.home.pagedAt, "recovery line refused: kept for later");
tgDown = false;
x = await tick(env, DAY + 50 * M);
ok(x.tg.length === 1 && /^✅ דף הבית חזר לעבוד אחרי 20 דקות$/.test(x.tg[0].text) && x.tg[0].disable_notification === true && U(env).probes.home.back === null, "recovery line sent on the next OK tick " + JSON.stringify(x.tg));
x = await tick(env, DAY + 60 * M);
ok(x.tg.length === 0, "and only once");
site.home = { status: 503, chunks: [] }; await tick(env, DAY + 70 * M); await tick(env, DAY + 80 * M);
site.home = { status: 200, chunks: OKPAGE }; tgDown = true; await tick(env, DAY + 90 * M); tgDown = false;
site.home = { status: 503, chunks: [] }; await tick(env, DAY + 100 * M);
x = await tick(env, DAY + 110 * M);
ok(x.tg.length === 1 && /לוחית לא זמינה/.test(x.tg[0].text) && U(env).probes.home.back === null, "a new page drops a pending recovery line");
site.home = { status: 200, chunks: OKPAGE };
x = await tick(env, DAY + 120 * M);
ok(x.tg.length === 1 && /אחרי 20 דקות$/.test(x.tg[0].text), "the next recovery is for the new outage");

// 3. reminders: one after 22.5 h at the first daytime tick, none at night; paged at night (critical rings at night)
reset(); env = PAGE();
const N0 = T("2026-10-20T22:40:00Z");   // 01:40 in Israel
await tick(env, N0);
site.api = { status: 500 };
await tick(env, N0 + 10 * M);
x = await tick(env, N0 + 20 * M);   // 23:00Z: paged
ok(x.tg.length === 1 && x.tg[0].disable_notification === false && x.mails.length === 1, "night page is loud with email");
x = await tick(env, T("2026-10-21T11:00:00Z"));
ok(x.tg.length === 0, "12 h later by day: no reminder yet");
x = await tick(env, T("2026-10-21T21:40:00Z"));   // 22.7 h, 00:40 in Israel
ok(x.tg.length === 0 && x.mails.length === 0, "22.5 h passed at night: no reminder");
x = await tick(env, T("2026-10-22T05:00:00Z"));   // 08:00 in Israel
ok(x.tg.length === 1 && /^🔁 תזכורת: זה עדיין קורה/.test(x.tg[0].text) && x.tg[0].disable_notification === false && x.mails.length === 1, "first daytime tick -> one reminder " + JSON.stringify(x.tg));
x = await tick(env, T("2026-10-22T05:10:00Z"));
ok(x.tg.length === 0, "the tick after the reminder: nothing");
x = await tick(env, T("2026-10-22T20:00:00Z"));   // 15 h after the reminder
ok(x.tg.length === 0, "no second reminder within 22.5 h");

// 4. a probe that never worked never pages
reset(); env = PAGE(); site.home = { status: 404, chunks: ["nope"] };
let sent = 0;
for (let i = 0; i < 4; i++) { x = await tick(env, DAY + i * 10 * M); sent += x.tg.filter(m => !/בדיקת הזמינות פועלת/.test(m.text)).length + x.mails.length; }
ok(sent === 0, "unarmed probe: no page in 4 bad ticks");
h = await health(env);
ok(h.j.armed.home === false && h.j.armed.api === true, "/health shows home unarmed " + JSON.stringify(h.j));

// 5. observe mode (no ALERT_ROUTE): silent "(מצב ניסיון)" only, no email
reset(); env = { ...PAGE(), ALERT_ROUTE: undefined };
await tick(env, DAY);
site.home = { status: 502, chunks: [] };
await tick(env, DAY + 10 * M);
x = await tick(env, DAY + 20 * M);
ok(x.tg.length === 1 && x.tg[0].disable_notification === true && x.tg[0].text.startsWith("🧪 (מצב ניסיון) 🚨") && x.mails.length === 0 && x.brevo.length === 0, "observe: one silent trial message, no email " + JSON.stringify(x.tg));
ok((await health(env)).j.mode === "observe", "/health mode observe");
site.home = { status: 200, chunks: OKPAGE };
x = await tick(env, DAY + 30 * M);
ok(x.tg.length === 1 && x.tg[0].disable_notification === true && x.tg[0].text.startsWith("🧪 (מצב ניסיון) ✅"), "observe: recovery silent, marked as a trial");
env.ALERT_ROUTE = "silent,day";   // a list without "critical" is observe too
site.home = { status: 502, chunks: [] };
await tick(env, DAY + 40 * M); x = await tick(env, DAY + 50 * M);
ok(x.tg.length === 1 && x.tg[0].disable_notification === true && x.mails.length === 0, "ALERT_ROUTE without critical -> observe");

// 6. no Telegram secrets: probes run and record, nothing is sent, /health tg false; Telegram down: the page is retried next tick
reset(); env = { ALERTS: KV(), ALERT_ROUTE: "critical" };
await tick(env, DAY); site.home = { status: 503, chunks: [] };
await tick(env, DAY + 10 * M); x = await tick(env, DAY + 20 * M);
h = await health(env);
ok(x.tg.length === 0 && x.puts === 1 && h.j.tg === false && h.j.email === false && h.j.armed.home, "no secrets: silent, recorded " + JSON.stringify(h.j));
reset(); env = PAGE(); delete env.MAIL;
await tick(env, DAY); site.home = { status: 503, chunks: [] }; tgDown = true;
await tick(env, DAY + 10 * M); x = await tick(env, DAY + 20 * M);
ok(x.tg.length >= 2 && !U(env).probes.home.pagedAt && U(env).tg === false && (await health(env)).j.tg === false, "Telegram down, no email path: not marked paged, tg false");
tgDown = false; x = await tick(env, DAY + 30 * M);
ok(x.tg.length === 1 && x.tg[0].disable_notification === false && !!U(env).probes.home.pagedAt && U(env).tg === true, "next tick retries the page; tg true again");
reset(); env = { ...PAGE(), BREVO_KEY: "KEYX" }; delete env.MAIL;
await tick(env, DAY); site.api = { status: 404 };
await tick(env, DAY + 10 * M); x = await tick(env, DAY + 20 * M);
ok(x.brevo.length === 1 && x.tg.length === 1, "no MAIL binding: the email goes through BREVO_KEY");

// 7. the marker: across a chunk edge (above), absent within 256 KB, early in a long body (the rest is not read)
const K64 = "x".repeat(65536);
reset(); env = PAGE();
site.home = { status: 200, chunks: [K64, K64, K64, K64, 'id="plate"'] };
await tick(env, DAY);
ok(U(env).probes.home.last === "marker" && !U(env).probes.home.armed, "marker after 256 KB -> missing");
site.home = { status: 200, chunks: [K64, K64, K64, K64.slice(0, 65536 - 10), 'id="plate"', K64] };
await tick(env, DAY + 10 * M);
ok(U(env).probes.home.last === "200", "marker ending exactly at 256 KB -> found");
site.home = { status: 200, chunks: [K64, K64, K64, K64.slice(0, 65536 - 9), 'id="plate"'] };
await tick(env, DAY + 20 * M);
ok(U(env).probes.home.last === "marker", "marker crossing the 256 KB line -> missing");
site.home = { status: 200, chunks: ['<b id="', 'plate">', ...Array(40).fill(K64)] };
await tick(env, DAY + 30 * M);
ok(U(env).probes.home.last === "200" && pulled < 6 && cancels === 1, "marker found early: the body is cancelled (" + pulled + " chunks read)");
site.home = { status: 200, chunks: ["id='plate'", 'id="Plate"'] };
await tick(env, DAY + 40 * M);
ok(U(env).probes.home.last === "marker", "only the exact bytes count");
x = await tick(env, DAY + 50 * M);
ok(/הסימן id="plate" חסר/.test(x.tg[0]?.text || ""), "page text names the missing marker");

// 8. mail morning ring: by day, keys deleted; a failed ring keeps them; expired pointers are dropped quietly; the daily getChat
const seeded = (extra = {}) => KV({ u: { v: 1, tick: new RealDate(DAY - 10 * M).toISOString(), hello: true, tg: true, morning: "2026-10-19",
  probes: { home: { armed: true, fails: 0 }, api: { armed: true, fails: 0 } } }, ...extra });
reset(); env = { ...PAGE(), ALERTS: seeded({ "p:1": { c: "mail:privacy", at: "2026-10-19T23:05:00Z" }, "p:2": { c: "mail:crash", at: "2026-10-19T22:10:00Z" } }) };
x = await tick(env, T("2026-10-20T03:00:00Z"));   // 06:00 in Israel: night
ok(x.tg.length === 0 && env.ALERTS.m.has("p:1"), "no ring at night");
tgDown = true;
x = await tick(env, T("2026-10-20T05:10:00Z"));   // 08:10
ok(env.ALERTS.m.has("p:1") && env.ALERTS.m.has("p:2") && chk === 1 && U(env).tg === false && x.puts === 1, "failed ring keeps the keys");
tgDown = false;
x = await tick(env, T("2026-10-20T05:20:00Z"));
ok(x.tg.length === 1 && x.tg[0].disable_notification === false && /^☀️ <b>מהלילה<\/b>\n• פנייה בנושא תקלה באפליקציה התקבלה ב-01:10\n• פנייה בנושא פרטיות או מחיקה התקבלה ב-02:05\n/.test(x.tg[0].text),
  "one loud ring, in time order " + JSON.stringify(x.tg));
ok(!env.ALERTS.m.has("p:1") && !env.ALERTS.m.has("p:2") && U(env).morning === "2026-10-20" && U(env).tg === true && x.puts === 1 && chk === 0, "keys deleted, getChat once a day, one KV write");
x = await tick(env, T("2026-10-20T05:30:00Z"));
ok(x.tg.length === 0 && chk === 0, "ring done: nothing more");
reset(); env = { ...PAGE(), ALERTS: seeded() };
x = await tick(env, T("2026-10-20T05:20:00Z"));
ok(x.tg.length === 0 && U(env).morning === "2026-10-20" && U(env).tg === true && chk === 1, "no pointers: no message, the check ran");
reset(); env = { ...PAGE(), ALERTS: seeded() }; tgDown = true;
await tick(env, T("2026-10-20T05:20:00Z"));
ok(U(env).tg === false && chk === 1, "getChat 401 -> tg false at once (no deferral for luchit-mail)");
reset(); env = { ...PAGE(), ALERTS: seeded() }; chkCodes = [502];
await tick(env, T("2026-10-20T05:20:00Z"));
ok(U(env).tg === true && chk === 2, "one getChat 502 is retried: tg stays true");
// the check runs before the tick's sends: a page that Telegram refuses (chat gone) leaves tg false all night although getChat said OK
reset(); env = { ...PAGE(), ALERTS: seeded() }; site.home = { status: 503, chunks: [] };
await tick(env, T("2026-10-20T04:40:00Z")); tgCode = 400;
x = await tick(env, T("2026-10-20T05:00:00Z"));   // 08:00: the check, then the page
ok(chk === 1 && x.mails.length === 1 && U(env).tg === false, "page refused after a good getChat -> tg false");
tgCode = 0; site.home = { status: 200, chunks: OKPAGE }; tgDown = true;
await tick(env, T("2026-10-20T20:00:00Z"));   // 23:00
ok(U(env).tg === false && (await health(env)).j.tg === false, "still false at night");
// a pointer written just after the 08:00 tick rings at 08:10; over 20 -> "ועוד N"; older than 12 h -> with its date
reset(); env = { ...PAGE(), ALERTS: seeded() };
await tick(env, T("2026-10-20T05:00:00Z"));
env.ALERTS.m.set("p:9", JSON.stringify({ c: "mail:privacy", at: "2026-10-20T04:59:58Z" }));
x = await tick(env, T("2026-10-20T05:10:00Z"));
ok(x.tg.length === 1 && /• פנייה בנושא פרטיות או מחיקה התקבלה ב-07:59\n/.test(x.tg[0].text) && !env.ALERTS.m.has("p:9"), "late pointer rings on the next daytime tick " + JSON.stringify(x.tg));
const many = {}; for (let i = 0; i < 25; i++) many["p:" + i] = { c: "mail:crash", at: new RealDate(T("2026-10-19T20:00:00Z") + i * M).toISOString() };
many["p:old"] = { c: "mail:other", at: "2026-10-19T03:00:00Z" };
reset(); env = { ...PAGE(), ALERTS: seeded(many) };
x = await tick(env, T("2026-10-20T05:20:00Z"));
ok(x.tg.length === 1 && x.tg[0].text.split("\n").filter(l => l.startsWith("• ")).length === 20 && /\nועוד 6 פניות\n/.test(x.tg[0].text) && /^☀️ <b>מהלילה<\/b>\n• פנייה התקבלה ב-19\.10 06:00\n• פנייה בנושא תקלה באפליקציה התקבלה ב-23:00\n/.test(x.tg[0].text),
  "26 pointers: 20 lines, 'ועוד 6', the old one dated " + JSON.stringify(x.tg));
ok(![...env.ALERTS.m.keys()].some(k => k.startsWith("p:")), "all listed pointers deleted");

// 9. GitHub heartbeat: 4 checks a day, armed after first sight, over 50 h old -> one daytime alert (+ email in page mode)
reset(); env = { ...PAGE(), ALERTS: seeded() };
x = await tick(env, T("2026-10-20T05:00:00Z"));
ok(hbReads === 0, "no heartbeat read outside hours 0/6/12/18 UTC");
for (const t of ["2026-10-20T06:00:00Z", "2026-10-20T12:00:00Z", "2026-10-22T18:00:00Z"]) x = await tick(env, T(t));
ok(x.tg.length === 0 && !U(env).gh.seenAt, "heartbeat never seen (404): never alerts");
x = await tick(env, T("2026-10-22T18:10:00Z"));
ok(hbReads === 0, "one heartbeat read per hour");
hb = "2026-10-23T05:30:00Z";
x = await tick(env, T("2026-10-23T06:00:00Z"));
ok(hbReads === 1 && U(env).gh.seenAt && x.tg.length === 0, "fresh heartbeat seen: armed, quiet");
hb = undefined;   // GitHub stops; the file cannot be read either
x = await tick(env, T("2026-10-25T06:00:00Z"));   // 48.5 h
ok(x.tg.length === 0, "48.5 h: not yet");
x = await tick(env, T("2026-10-26T00:00:00Z"));   // 66.5 h, 02:00 in Israel
ok(x.tg.length === 0, "stale at night: no alert");
x = await tick(env, T("2026-10-26T06:00:00Z"));   // 08:00 in Israel (winter)
ok(x.tg.length === 1 && /האוטומציות ב-GitHub לא רצו כבר יומיים \(דופק אחרון: 23\.10 08:30\)/.test(x.tg[0].text) && x.tg[0].disable_notification === false && x.mails.length === 1,
  "stale by day: one loud alert plus email " + JSON.stringify(x.tg));
for (const t of ["2026-10-26T12:00:00Z", "2026-10-26T18:00:00Z"]) { x = await tick(env, T(t)); ok(x.tg.length === 0, "at most once per 22.5 h (" + t + ")"); }
x = await tick(env, T("2026-10-27T06:00:00Z"));
ok(x.tg.length === 1, "next day: once more");
reset(); env = { ...PAGE(), ALERT_ROUTE: undefined, ALERTS: seeded() };
hb = "2026-10-20T00:00:00Z";
x = await tick(env, T("2026-10-23T06:00:00Z"));
ok(x.tg.length === 1 && x.tg[0].disable_notification === true && x.tg[0].text.startsWith("🧪") && x.mails.length === 0, "observe: stale heartbeat is a silent trial line, no email");

// 10. KV: unreadable -> the tick is skipped with no write and no message; corrupt "u" -> starts over; no binding -> nothing
reset(); env = PAGE(); env.ALERTS.fail = true;
x = await tick(env, DAY);
ok(x.puts === 0 && x.tg.length === 0, "KV read fails: no write, no message");
h = await health(env);
ok(h.status === 503 && h.j.tick === null, "/health when KV fails");
reset(); env = PAGE(); env.ALERTS.m.set("u", "{broken");
x = await tick(env, DAY);
ok(x.puts === 1 && U(env).v === 1 && U(env).probes.home.armed, "corrupt u -> fresh state");
reset(); env = { ...PAGE(), ALERTS: undefined };
x = await tick(env, DAY);
ok(x.tg.length === 0, "no KV binding: nothing sent");
h = await health(env);
ok(h.status === 200 && h.j.tick === null && h.j.armed.home === false, "/health without KV");

log(bad ? `uptime test: ${bad} of ${n} checks FAILED` : `uptime test ok (${n} checks)`);
process.exit(bad ? 1 : 0);
