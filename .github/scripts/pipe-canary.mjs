// Pipe canary (Web watch, daily): reads yesterday (an Israel day: the GA4 property keeps Israel time) from GA4 and from Cloudflare Web Analytics,
// and raises one alert when the analytics pipe looks broken, so a lost event is caught the next morning and not at the 22.11 read:
//   web     the site had real visits (Cloudflare, at least WEB_VISITS) but GA4 got no car check from the web (worker/api dropped them, or track broke)
//   app     the app had new installs (first_open, at least APP_INSTALLS) but GA4 got no car check from the app
//   errors  code errors (js_error, and lookup_failed of kind js_err) at least ERR_MIN and at least ERR_X times the median of the 7 days before;
//           js_error of kind "iab" (scripts of the Facebook / Instagram / TikTok in-app browser, not ours) does not count
//   ga      GA4 has no event at all for yesterday while Cloudflare counted real visits
// A source that does not answer leaves its checks unknown (never a made-up 0). The repo's logs are public, so this prints states only and never
// a count; the counts go to Telegram, through the alert router (key pipe:<ids>).
// Node 20, node: builtins only. Commands:
//   node pipe-canary.mjs            GA_SERVICE_ACCOUNT_JSON, CF_API_TOKEN, CF_ACCOUNT_ID, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DRY_RUN=1 (print, send nothing)
//   node pipe-canary.mjs selftest   offline (mocked fetch)
import fs from "node:fs";
import crypto from "node:crypto";
import { msg } from "./tg-text.mjs";

export const WEB_VISITS = 50, APP_INSTALLS = 3, ERR_MIN = 5, ERR_X = 3;
const CF_SITES = ["03eb6fb7a75440649781d7a00b29c4ff", "5c0a33a14f5f4201b25fd680a29ae723"];   // as seo-daily.mjs: both site tags, no /live, no headless
const EVENTS = ["car_lookup", "first_open", "js_error", "lookup_failed"];
const IAB = new Set(["facebook", "instagram", "tiktok"]);   // customEvent:src of a visit opened inside that app
const PROPERTY = (() => { try { return String(JSON.parse(fs.readFileSync(new URL("../../analytics/ga4-admin.json", import.meta.url), "utf8")).property || ""); } catch { return ""; } })();

const IO = { env: process.env, fetch: (u, o) => fetch(u, o), out: s => process.stdout.write(s + "\n"), now: () => Date.now(), router: () => import("./alert.mjs") };
const J = s => { try { return JSON.parse(s); } catch { return null; } };
const ilDay = t => new Date(t).toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
const addDays = (s, n) => new Date(Date.parse(s + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const ilStart = day => { for (const h of [3, 2]) { const t = Date.parse(day + "T00:00:00Z") - h * 3600e3; if (ilDay(t) === day && ilDay(t - 1) !== day) return new Date(t).toISOString(); } return day + "T00:00:00Z"; };
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };

async function gaToken(sa) {
  const b64 = x => Buffer.from(x).toString("base64url"), now = Math.floor(IO.now() / 1000);
  const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 }));
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key, "base64url");
  const r = await IO.fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }), signal: AbortSignal.timeout(30000) });
  const j = J(await r.text());
  return r.ok && j?.access_token ? j.access_token : null;
}

// one report: date x platform x event x kind for the 8 days that end yesterday; null when GA4 does not answer
export async function readGa(env = IO.env) {
  const sa = J(env.GA_SERVICE_ACCOUNT_JSON || "");
  if (!sa?.client_email || !sa?.private_key || !PROPERTY) return null;
  try {
    const tok = await gaToken(sa);
    if (!tok) return null;
    const body = { dateRanges: [{ startDate: "8daysAgo", endDate: "yesterday" }], metrics: [{ name: "eventCount" }], limit: 2000,
      dimensions: [{ name: "date" }, { name: "platform" }, { name: "eventName" }, { name: "customEvent:kind" }, { name: "customEvent:src" }],
      dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: EVENTS } } } };
    const r = await IO.fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:runReport`, { method: "POST",
      headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const j = J(await r.text());
    if (!r.ok || !j) return null;
    return (j.rows || []).map(x => { const [d, platform, ev, kind, src] = x.dimensionValues.map(v => v.value);
      return { day: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, platform: platform.toLowerCase(), ev, kind, src: String(src || "").toLowerCase(), n: +x.metricValues[0].value || 0 }; });
  } catch { return null; }
}

// real visits to the site on one Israel day; null when Cloudflare does not answer
export async function readCf(day, env = IO.env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return null;
  try {
    const query = "query($acc:String!,$f:AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject){viewer{accounts(filter:{accountTag:$acc}){rumPageloadEventsAdaptiveGroups(filter:$f,limit:1){count sum{visits}}}}}";
    const f = { AND: [{ datetime_geq: ilStart(day), datetime_lt: ilStart(addDays(day, 1)) }, { siteTag_in: CF_SITES }, { requestPath_notlike: "/live%" }, { userAgentBrowser_neq: "ChromeHeadless" }] };
    const r = await IO.fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: "Bearer " + env.CF_API_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { acc: env.CF_ACCOUNT_ID, f } }), signal: AbortSignal.timeout(30000) });
    const j = J(await r.text());
    if (!r.ok || !j || j.errors) return null;
    const g = j.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups?.[0];
    return g ? +(g.sum?.visits ?? g.count) || 0 : 0;
  } catch { return null; }
}

// the verdict: { state: {web, app, errors, ga} each "ok" | "alarm" | "unknown", alarms: [{id, text}] }
export function judge(rows, visits, day) {
  const state = { web: "unknown", app: "unknown", errors: "unknown", ga: "unknown" }, alarms = [];
  if (!rows) return { state, alarms };
  const sum = (d, pred) => rows.filter(r => r.day === d && pred(r)).reduce((a, r) => a + r.n, 0);
  const lookups = p => sum(day, r => r.ev === "car_lookup" && r.platform === p);
  const any = sum(day, () => true), webLook = lookups("web"), appLook = lookups("android"), installs = sum(day, r => r.ev === "first_open" && r.platform === "android");
  // errors from inside the Facebook, Instagram and TikTok apps' browsers are their noise, not ours (24-25.10): by the GA source until 1.38,
  // and by the site's own kind "iab" from 1.38 on
  const errs = d => sum(d, r => ((r.ev === "js_error" && r.kind !== "iab") || (r.ev === "lookup_failed" && r.kind === "js_err")) && !IAB.has(r.src));
  if (visits !== null) {
    state.ga = any === 0 && visits >= WEB_VISITS ? "alarm" : "ok";
    if (state.ga === "alarm") alarms.push({ id: "ga", text: `Google Analytics לא קיבל אף אירוע, לא מהאתר ולא מהאפליקציה, למרות ${visits} כניסות לאתר.` });
  }
  if (any > 0) {   // GA4 has processed yesterday: a zero below is a real zero, not a report that is not ready
    if (visits !== null) {
      state.web = webLook === 0 && visits >= WEB_VISITS ? "alarm" : "ok";
      if (state.web === "alarm") alarms.push({ id: "web", text: `באתר נספרו 0 בדיקות רכב, למרות ${visits} כניסות. כנראה המדידה מהאתר לא עוברת.` });
    }
    state.app = appLook === 0 && installs >= APP_INSTALLS ? "alarm" : "ok";
    if (state.app === "alarm") alarms.push({ id: "app", text: `באפליקציה נספרו 0 בדיקות רכב, למרות ${installs} התקנות חדשות. כנראה המדידה מהאפליקציה לא עוברת.` });
    const base = median([1, 2, 3, 4, 5, 6, 7].map(k => errs(addDays(day, -k)))), y = errs(day);
    state.errors = y >= ERR_MIN && y >= ERR_X * base ? "alarm" : "ok";
    if (state.errors === "alarm") alarms.push({ id: "errors", text: `באתר נרשמו ${y} שגיאות קוד אתמול, ובדרך כלל ${base}. ייתכן שמשהו שעלה לאחרונה נשבר.` });
  }
  return { state, alarms };
}

async function telegram(text) {
  try { const r = await IO.fetch(`https://api.telegram.org/bot${IO.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: IO.env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }), signal: AbortSignal.timeout(20000) }); IO.out(`telegram ${r.status}`); return r.ok; }
  catch (e) { IO.out("telegram failed"); return false; }
}

export async function main() {
  const day = addDays(ilDay(IO.now()), -1);
  const [rows, visits] = await Promise.all([readGa(), readCf(day)]);
  const { state, alarms } = judge(rows, visits, day);
  IO.out(`pipe canary ${day}: ga4 ${rows ? "read" : "unavailable"}, cloudflare ${visits === null ? "unavailable" : "read"}; ` + Object.entries(state).map(([k, v]) => `${k} ${v}`).join(", "));
  if (!alarms.length) {
    // every check ok again: an open pipe item is closed, and the router says so once, quietly (Dudu 26.10: every problem, and how it ended)
    if (IO.env.DRY_RUN !== "1" && Object.values(state).every(v => v === "ok")) try { await (await IO.router())?.resolve(["pipe:"]); } catch { /* the morning ledger still lists it */ }
    return 0;
  }
  const text = msg({ kind: "today", area: "measure", title: `בדיקת המדידה של ${day.slice(8)}.${day.slice(5, 7)} מצאה בעיה`,
    text: alarms.map(a => "• " + a.text).join("\n") + "\nזה משפיע על המספרים בדשבורד, לא על המשתמשים.",
    what: 'לכתוב לי בשרשור "תפעול, בוטים ומייל" ואבדוק אם זו תקלה אמיתית או רעש.' });
  const ids = alarms.map(a => a.id).join("+"), link = IO.env.RUN_URL || "";
  if (IO.env.DRY_RUN === "1" || !IO.env.TELEGRAM_BOT_TOKEN || !IO.env.TELEGRAM_CHAT_ID) { IO.out(`(no message sent: ${IO.env.DRY_RUN === "1" ? "dry run" : "no Telegram secrets"}) pipe:${ids}`); return 0; }
  let router = null; try { router = await IO.router(); } catch { /* the direct send below */ }
  const r = router ? await router.alert("day", "pipe:" + ids, text, link, { today: "loud", legacy: () => telegram(text) }) : { delivered: await telegram(text) };
  return r && r.delivered ? 0 : 1;
}

async function selftest() {
  const fails = [], ok = (c, m) => { if (!c) fails.push(m); };
  const D = "2026-10-21", day = k => addDays(D, -k);
  const rowsOf = (spec) => Object.entries(spec).flatMap(([k, list]) => list.map(([platform, ev, n, kind = "(not set)"]) => ({ day: day(+k), platform, ev, kind, n })));
  const week = k => [["web", "car_lookup", 300, "car"], ["android", "car_lookup", 500, "car"], ["android", "first_open", 20], ["web", "js_error", k % 3, "run"], ["android", "lookup_failed", 2, "net_err"]];
  const normal = { 0: week(0), 1: week(1), 2: week(2), 3: week(3), 4: week(4), 5: week(5), 6: week(6), 7: week(7) };
  let v = judge(rowsOf(normal), 900, D);
  ok(v.alarms.length === 0 && Object.values(v.state).every(s => s === "ok"), "a normal day: all ok " + JSON.stringify(v.state));
  v = judge(rowsOf({ ...normal, 0: week(0).filter(r => !(r[0] === "web" && r[1] === "car_lookup")) }), 900, D);
  ok(v.state.web === "alarm" && v.alarms.map(a => a.id).join() === "web", "no web car check with real visits: web alarm");
  v = judge(rowsOf({ ...normal, 0: week(0).filter(r => !(r[0] === "web" && r[1] === "car_lookup")) }), 20, D);
  ok(v.state.web === "ok" && !v.alarms.length, "no web car check on a quiet day: no alarm");
  v = judge(rowsOf({ ...normal, 0: week(0).filter(r => !(r[0] === "web" && r[1] === "car_lookup")) }), null, D);
  ok(v.state.web === "unknown" && v.state.ga === "unknown" && !v.alarms.length, "Cloudflare unavailable: web unknown, no alarm");
  v = judge(rowsOf({ ...normal, 0: week(0).filter(r => !(r[0] === "android" && r[1] === "car_lookup")) }), 900, D);
  ok(v.state.app === "alarm" && v.alarms.map(a => a.id).join() === "app", "no app car check with new installs: app alarm");
  v = judge(rowsOf({ ...normal, 0: [["android", "first_open", 2], ["web", "car_lookup", 10, "car"]] }), 900, D);
  ok(v.state.app === "ok", "no app car check with 2 installs: below the bar");
  v = judge(rowsOf({ ...normal, 0: [...week(0), ["web", "js_error", 40, "run"]] }), 900, D);
  ok(v.state.errors === "alarm" && v.alarms[0].text.includes("40"), "a jump in code errors: errors alarm");
  v = judge(rowsOf({ ...normal, 0: [...week(0), ["android", "lookup_failed", 9, "js_err"]] }), 900, D);
  ok(v.state.errors === "alarm", "lookup_failed of kind js_err counts as a code error");
  v = judge(rowsOf({ ...normal, 0: [...week(0), ["web", "js_error", 40, "iab"]] }), 900, D);
  ok(v.state.errors === "ok", "errors from an in-app browser's own scripts are not ours");
  v = judge(rowsOf({ ...normal, 0: [...week(0), ["android", "lookup_failed", 90, "net_err"]] }), 900, D);
  ok(v.state.errors === "ok", "network failures are not code errors");
  v = judge(rowsOf({ ...normal, 0: [...week(0), ["web", "js_error", 40, "run"]] }).map(r => (r.ev === "js_error" && r.n === 40 ? { ...r, src: "facebook" } : r)), 900, D);
  ok(v.state.errors === "ok", "errors inside the Facebook app's browser are not counted");
  v = judge(rowsOf({ ...normal, 0: [...week(0), ["web", "js_error", 4, "run"]] }), 900, D);
  ok(v.state.errors === "ok", "4 errors over a median of 1: under ERR_MIN");
  const busy = Object.fromEntries(Object.entries(normal).map(([k, l]) => [k, [...l, ["web", "js_error", 10, "run"]]]));
  v = judge(rowsOf({ ...busy, 0: [...busy[0], ["web", "js_error", 10, "run"]] }), 900, D);
  ok(v.state.errors === "ok", "twice a steady median: no alarm");
  v = judge(rowsOf({ ...normal, 0: [] }), 900, D);
  ok(v.state.ga === "alarm" && v.alarms.map(a => a.id).join() === "ga" && v.state.web === "unknown", "GA4 empty for yesterday with real visits: one ga alarm, the rest unknown");
  v = judge(rowsOf({ ...normal, 0: [] }), 10, D);
  ok(!v.alarms.length, "GA4 empty on a quiet day: no alarm");
  v = judge(null, 900, D);
  ok(!v.alarms.length && Object.values(v.state).every(s => s === "unknown"), "GA4 unavailable: all unknown, no alarm");

  // the whole run with mocked services: prints states only, never a count; the alert carries the counts
  const saved = { ...IO }, printed = [], sent = [];
  const SA = { client_email: "canary@x.iam.gserviceaccount.com", private_key: crypto.generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" }) };
  const gaRows = rows => ({ rows: rows.map(r => ({ dimensionValues: [r.day.replace(/-/g, ""), r.platform === "android" ? "Android" : "web", r.ev, r.kind].map(value => ({ value })), metricValues: [{ value: String(r.n) }] })) });
  const resolved = [];
  const runWith = async (rows, visits, env = {}) => {
    printed.length = 0; sent.length = 0; resolved.length = 0;
    Object.assign(IO, { out: s => printed.push(s), now: () => Date.parse("2026-10-22T07:30:00Z"),
      env: { GA_SERVICE_ACCOUNT_JSON: JSON.stringify(SA), CF_API_TOKEN: "cf", CF_ACCOUNT_ID: "acc", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "c", ...env },
      router: async () => (env.ROUTER ? { resolve: async p => { resolved.push(...p); return 1; } } : null),
      fetch: async (u, o) => {
        const res = (status, body) => ({ ok: status < 300, status, text: async () => typeof body === "string" ? body : JSON.stringify(body), json: async () => body, headers: { get: () => null } });
        if (u.startsWith("https://oauth2")) return res(200, { access_token: "tok" });
        if (u.includes("analyticsdata")) return rows === null ? res(403, { error: {} }) : res(200, gaRows(rows));
        if (u.includes("cloudflare")) return visits === null ? res(500, "") : res(200, { data: { viewer: { accounts: [{ rumPageloadEventsAdaptiveGroups: [{ count: visits, sum: { visits } }] }] } } });
        if (u.includes("telegram")) { sent.push(J(o.body).text); return res(200, { ok: true }); }
        return res(404, "");
      } });
    const code = await main();
    Object.assign(IO, saved);
    return code;
  };
  try {
    let code = await runWith(rowsOf(normal), 917);
    ok(code === 0 && !sent.length && printed.some(l => /web ok, app ok, errors ok, ga ok/.test(l)), "run: a normal day sends nothing " + printed.join(" | "));
    code = await runWith(rowsOf({ ...normal, 0: week(0).filter(r => !(r[0] === "web" && r[1] === "car_lookup")) }), 917);
    ok(code === 0 && sent.length === 1 && sent[0].includes("917") && sent[0].includes("21.10"), "run: the web alarm goes out with the counts");
    ok(!printed.join("\n").includes("917") && !printed.join("\n").includes("500"), "run: no count in the log " + printed.join(" | "));
    code = await runWith(null, 917);
    ok(code === 0 && !sent.length && printed.some(l => /ga4 unavailable/.test(l)), "run: GA4 refused, nothing sent");
    code = await runWith(rowsOf({ ...normal, 0: [] }), 917, { DRY_RUN: "1" });
    ok(code === 0 && !sent.length && printed.some(l => l.includes("dry run") && l.includes("pipe:ga")), "run: dry run sends nothing");
    code = await runWith(rowsOf(normal), 917, { ROUTER: "1" });
    ok(code === 0 && resolved.join() === "pipe:", "run: every check ok closes the open pipe item");
    code = await runWith(null, 917, { ROUTER: "1" });
    ok(code === 0 && !resolved.length, "run: an unknown check closes nothing");
    code = await runWith(rowsOf(normal), 917, { ROUTER: "1", DRY_RUN: "1" });
    ok(code === 0 && !resolved.length, "run: a dry run closes nothing");
  } catch (e) { Object.assign(IO, saved); fails.push("crashed: " + (e?.stack || e)); }
  for (const f of fails) IO.out("FAIL " + f);
  IO.out(fails.length ? `selftest: ${fails.length} failed` : "selftest: all passed");
  return fails.length ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("pipe-canary.mjs")) process.exit(process.argv[2] === "selftest" ? await selftest() : await main());
