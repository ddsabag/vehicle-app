// Offline test of the alert-lib v1 block (worker/lib/alert-lib.js): a hung binding or a slow alert() must end in exactly one legacy call.
// Mocked fetch, bindings and clock; a stub cloudflare:email module. The file is loaded as a data: URL, so any Node 20+ reads it as ESM.
//   node worker/lib/test.mjs
import fs from "node:fs";
import { register } from "node:module";

register("data:text/javascript," + encodeURIComponent(`export async function resolve(s, c, next) {
  return s === "cloudflare:email" ? { url: "data:text/javascript,export class EmailMessage { constructor(f, t, r) { this.raw = r; } }", shortCircuit: true } : next(s, c);
}`));
const lib = await import("data:text/javascript," + encodeURIComponent(fs.readFileSync(new URL("./alert-lib.js", import.meta.url), "utf8")));
lib.ALERT_MS.call = 100; lib.ALERT_MS.deadline = 3000;

const RealDate = Date;
let clock = RealDate.parse("2026-10-20T09:00:00Z");   // 12:00 in Israel
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } };
const NIGHT = RealDate.parse("2026-10-20T21:30:00Z"), DAY = clock;
const never = () => new Promise(() => {});
let tg = [], tgPlan = [];
globalThis.fetch = async (u, o = {}) => {
  if (u.startsWith("https://api.telegram.org/")) {
    tg.push(JSON.parse(o.body));
    const v = tgPlan.shift();
    if (v === "hang") return never();
    return new Response(JSON.stringify({ ok: !v }), { status: v || 200 });
  }
  return new Response("{}", { status: 500 });
};
const BASE = { ALERT_ROUTE: "all", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c" };
const log = console.log;
let n = 0, bad = 0;
const ok = (c, m) => { n++; if (!c) { bad++; log("FAIL " + m); } };
async function run(name, { level = "day", env = {}, at = DAY, plan = [], max = 2900 } = {}) {
  clock = at; tg = []; tgPlan = plan.slice();
  let legacy = 0;
  const t1 = performance.now();
  console.log = () => {};
  let r;
  try { r = await lib.alert({ ...BASE, ...env }, level, "mail:privacy", "<b>בדיקה</b>", "", { legacy: async () => { legacy++; return true; } }); }
  finally { console.log = log; }
  const el = performance.now() - t1;
  ok(el < max, `${name}: took ${Math.round(el)} ms`);
  return { r, legacy, el };
}
const alive = { get: async () => ({ tick: new RealDate(NIGHT - 6e4).toISOString() }), put: async () => {} };

let x = await run("critical, Telegram 500 x2, MAIL.send never settles", { level: "critical", plan: [500, 500], env: { MAIL: { send: never } } });
ok(x.legacy === 1 && x.r.action === "legacy" && tg.length === 2, "hung MAIL.send -> legacy once " + JSON.stringify(x));
x = await run("night day, ALERTS.put never settles", { at: NIGHT, env: { ALERTS: { ...alive, put: never } } });
ok(x.legacy === 1 && tg.length === 0, "hung KV put -> legacy once, no message " + JSON.stringify(x));
x = await run("night day, ALERTS.get never settles", { at: NIGHT, env: { ALERTS: { ...alive, get: never } } });
ok(x.legacy === 0 && x.r.action === "loud" && tg[0]?.disable_notification === false, "hung KV get -> no deferral, loud " + JSON.stringify(x));
x = await run("summary, Telegram fetch never settles (deadline)", { level: "summary", plan: ["hang"], max: 3500 });
ok(x.legacy === 1 && x.el >= 2900, "past the deadline -> legacy once " + JSON.stringify(x));
let sent = 0;
x = await run("critical, both paths work", { level: "critical", env: { MAIL: { send: async m => { sent++; ok(/Subject: =\?UTF-8\?B\?/.test(m.raw), "MIME subject"); } } } });
ok(x.legacy === 0 && x.r.delivered && x.r.action === "loud" && sent === 1 && tg.length === 1, "critical: Telegram and mail, no legacy " + JSON.stringify(x));
x = await run("night day, uptime alive", { at: NIGHT, env: { ALERTS: alive } });
ok(x.legacy === 0 && x.r.action === "night" && tg[0]?.disable_notification === true, "night: silent with pointer");
x = await run("not routed", { env: { ALERT_ROUTE: "" } });
ok(x.legacy === 1 && tg.length === 0, "unrouted -> legacy once");
log(bad ? `alert-lib test: ${bad} of ${n} checks FAILED` : `alert-lib test ok (${n} checks)`);
process.exit(bad ? 1 : 0);
