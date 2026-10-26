// Live watch: is the /live dashboard answering? live-watch.yml runs it every 30 minutes. It reads Cloudflare's own record of the luchit-live
// Worker's requests over the last 35 minutes (GraphQL workersInvocationsAdaptive, 5-minute steps). Since live-28 the Worker answers /live/data
// within 25 s, with the last good data when a source is late, so a step whose requests mostly took 20 s or more means the screen was being
// served late; and a step where the page gave up on requests that had waited 20 s or more means it was not served at all (on 20.10 one hung
// call kept every load on "loading" for two hours). Two such steps, or 3 requests that ended in a Worker error: one Telegram (alert router,
// live:stuck or live:error, at most once in 6 hours) and a redeploy of the Worker from main (Workers deploy, mode on, workers live: fresh
// isolates; at most once in 6 hours, so a redeploy that did not help is said, not repeated).
// Quiet when all is well, and when nobody opened the screen (no requests, nothing to judge). A clean window (requests, no slow step, no
// error) closes an open live: alert in the router, which tells its end once, quietly ("חזר לתקין"); an empty window proves nothing, so the
// close waits for one with requests.
// Reads Cloudflare with CF_API_TOKEN (analytics); writes only the dispatch and the router's state. Prints the Worker's request counts and
// times, never a number from the dashboard. Never fails the run on a read problem (one notice line, green), so it cannot page every 30 minutes.
//   node live-watch.mjs            the watch (DRY=1: print what it would do, send and dispatch nothing; LIVE_WATCH=dry: the same)
//   node live-watch.mjs selftest   offline checks of the judgement, on the requests Cloudflare recorded on 20.10
import { msg } from "./tg-text.mjs";
const E = process.env, say = (...a) => console.log(...a);
const WINDOW_MIN = 35, SLOW_MS = 20000, SLOW_STEPS = 2, ERR_N = 3, GAP_MS = 6 * 36e5;
const SCRIPT = "luchit-live", DEPLOY = "workers-deploy.yml";
const OK_STATUS = ["success", "clientDisconnected"];

// rows: [{ dimensions: { datetimeFiveMinutes, status }, sum: { requests }, quantiles: { wallTimeP50, wallTimeP99 } }]. Cloudflare gives wall
// time in MICROseconds (the schema: "Wall time 50th percentile - microseconds"), ms from here on. A 5-minute step is slow when
//  - the rows whose median request took SLOW_MS or more hold at least half of its requests (since live-28: answers at the 25 s deadline), or
//  - at least 2 requests were cut off by the client, no fewer than those answered, and the longest of them had waited SLOW_MS or more
//    (before live-28: the page gave up on a hung call; at 14:50 on 20.10, 6 cut requests, median 9 s, the longest 219 s).
// One tab closed while its data loads is one cut request in a step: not slow.
const us = v => (Number(v) || 0) / 1000;
export function judge(rows) {
  const steps = new Map(), errBy = {};
  let errors = 0;
  for (const r of rows || []) {
    const t = r.dimensions.datetimeFiveMinutes, st = r.dimensions.status, n = Number(r.sum?.requests) || 0;
    const p50 = us(r.quantiles?.wallTimeP50), p99 = us(r.quantiles?.wallTimeP99);
    const o = steps.get(t) || { n: 0, slow: 0, ok: 0, cut: 0, cutMax: 0 };
    o.n += n; if (p50 >= SLOW_MS) o.slow += n;
    if (st === "success") o.ok += n;
    if (st === "clientDisconnected") { o.cut += n; o.cutMax = Math.max(o.cutMax, p99); }
    steps.set(t, o);
    if (!OK_STATUS.includes(st)) { errors += n; errBy[st] = (errBy[st] || 0) + n; }
  }
  const all = [...steps.values()];
  const slowSteps = all.filter(o => o.n && (o.slow * 2 >= o.n || (o.cut >= 2 && o.cut >= o.ok && o.cutMax >= SLOW_MS))).length;
  return { requests: all.reduce((a, o) => a + o.n, 0), steps: all.length, slowSteps, errors, errBy, stuck: slowSteps >= SLOW_STEPS, failing: errors >= ERR_N };
}
// the window shows /live answering: someone opened it, no step was slow and no request ended in a Worker error
export const healthy = v => v.requests > 0 && !v.slowSteps && !v.errors;

const clean = raw => { raw = String(raw || ""); const m = raw.match(/Bearer\s+([A-Za-z0-9_\-]{20,})/i); return (m ? m[1] : raw).trim().replace(/^["']|["']$/g, "").replace(/[^\x21-\x7e]/g, ""); };
const hhmm = t => new Date(t).toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
async function gh(method, path, body) {
  const r = await fetch(`https://api.github.com/repos/${E.GITHUB_REPOSITORY}${path}`, { method, signal: AbortSignal.timeout(20000),
    headers: { authorization: "Bearer " + E.GITHUB_TOKEN, accept: "application/vnd.github+json", "user-agent": "luchit-live-watch", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { ok: r.ok, status: r.status, json: r.status === 204 ? null : await r.json().catch(() => null) };
}
async function telegram(text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${E.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ chat_id: E.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true, parse_mode: "HTML" }) });
    say("telegram", r.status); return r.ok;
  } catch (e) { say("telegram failed:", String(e.message || e).slice(0, 80)); return false; }
}

async function watch() {
  const dry = E.DRY === "1" || E.LIVE_WATCH === "dry", tok = clean(E.CF_API_TOKEN), acc = String(E.CF_ACCOUNT_ID || "").trim();
  if (!tok || !acc) { say("notice: CF_API_TOKEN or CF_ACCOUNT_ID is not set, nothing to read"); return 0; }
  const until = new Date(), since = new Date(until - WINDOW_MIN * 6e4);
  const query = `query($acc: string!, $since: Time!, $until: Time!) { viewer { accounts(filter: {accountTag: $acc}) { workersInvocationsAdaptive(limit: 500, filter: {scriptName: "${SCRIPT}", datetime_geq: $since, datetime_leq: $until}, orderBy: [datetimeFiveMinutes_ASC]) { dimensions { datetimeFiveMinutes status } sum { requests } quantiles { wallTimeP50 wallTimeP99 } } } } }`;
  let rows;
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", signal: AbortSignal.timeout(30000),
      headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify({ query, variables: { acc, since: since.toISOString(), until: until.toISOString() } }) });
    const j = await r.json();
    if (j.errors && j.errors.length) { say("notice: Cloudflare analytics answered with an error:", j.errors.map(e => e.message).join(" | ").slice(0, 200)); return 0; }
    rows = j.data.viewer.accounts[0]?.workersInvocationsAdaptive || [];
  } catch (e) { say("notice: Cloudflare analytics not read:", String(e.message || e).slice(0, 120)); return 0; }
  for (const x of rows) say(` ${x.dimensions.datetimeFiveMinutes} ${x.dimensions.status} requests ${x.sum.requests} wall p50/p99 ms ${Math.round(us(x.quantiles.wallTimeP50))}/${Math.round(us(x.quantiles.wallTimeP99))}`);
  const v = judge(rows);
  say(`last ${WINDOW_MIN} min: ${v.requests} requests in ${v.steps} steps, slow steps ${v.slowSteps}, errors ${v.errors}`, v.errors ? JSON.stringify(v.errBy) : "");
  let router = null;
  try { router = await import("./alert.mjs"); } catch { /* the direct send below */ }
  if (!v.stuck && !v.failing) {
    say("ok");
    if (healthy(v) && !dry && router?.resolve && await router.resolve(["live:"])) say("the open /live alert is closed");
    return 0;
  }

  // at most one redeploy and one message in 6 hours
  const key = v.stuck ? "live:stuck" : "live:error", state = router && E.GITHUB_TOKEN ? await router.readState() : null;
  const told = state?.items?.[key]?.last ? Date.parse(state.items[key].last) : 0;
  let redeployedAt = null;
  if (E.GITHUB_TOKEN) {
    const runs = await gh("GET", `/actions/workflows/${DEPLOY}/runs?event=workflow_dispatch&per_page=20`);
    const mine = (runs.json?.workflow_runs || []).find(x => x.triggering_actor?.login === "github-actions[bot]" && until - Date.parse(x.created_at) < GAP_MS);
    if (mine) redeployedAt = mine.created_at;
  }
  let action;
  if (redeployedAt) action = `a redeploy already ran at ${redeployedAt}`;
  else if (dry || !E.GITHUB_TOKEN) action = "would redeploy (dry run or no token)";
  else {
    const d = await gh("POST", `/actions/workflows/${DEPLOY}/dispatches`, { ref: "main", inputs: { mode: "on", workers: "live" } });
    action = d.ok ? "redeploy dispatched" : `redeploy dispatch refused (${d.status})`;
  }
  say(action);
  // the Telegram standard (24.10): tag line, a short Hebrew title, why it matters, what to do; Cloudflare's own status keys go folded
  const ST_HE = { exceededResources: "חרג ממגבלת המשאבים", scriptThrewException: "זרק שגיאה", exceededCpu: "חרג מזמן המעבד", internalError: "תקלה פנימית ב-Cloudflare" };
  const errs = Object.keys(v.errBy).map(k => ST_HE[k] || "שגיאה אחרת").filter((x, i, a) => a.indexOf(x) === i).join(", ");
  const text = msg({ kind: "today", area: "measure", title: v.stuck ? "הדשבורד /live לא ענה בזמן" : "הדשבורד /live החזיר שגיאות",
    text: (v.stuck ? `ב-${WINDOW_MIN} הדקות האחרונות רוב הבקשות לנתונים לקחו 20 שניות ויותר. המסך מציג בינתיים את הנתונים האחרונים שנשמרו, עם השעה שלהם.`
      : `${v.errors} בקשות ב-${WINDOW_MIN} הדקות האחרונות נכשלו בשרת של הדשבורד (${errs}).`)
      + (redeployedAt ? ` פריסה מחדש כבר רצה ב-${hhmm(redeployedAt)} ולא עזרה, ולכן לא הופעלה שוב.`
        : /dispatched|would/.test(action) ? " הפעלתי פריסה מחדש של הדשבורד, וזה בדרך כלל פותר את זה." : " ניסיתי להפעיל פריסה מחדש של הדשבורד, והיא לא הופעלה."),
    what: redeployedAt ? "לכתוב לי בשרשור \"דשבורד LIVE\", צריך לבדוק את הקוד שלו."
      : /dispatched|would/.test(action) ? "" : "להריץ את פריסת ה-Workers של הדשבורד (בפעולות של GitHub), או לכתוב לי בשרשור \"דשבורד LIVE\".",
    raw: [`slow steps ${v.slowSteps}, errors ${v.errors}`, Object.keys(v.errBy).length ? JSON.stringify(v.errBy) : "", action, "manual: Workers deploy, mode on, workers live"].filter(Boolean).join(" | ") });
  if (until - told < GAP_MS) { say(`already told at ${new Date(told).toISOString()}, no message`); return 0; }
  if (dry) { say("would send:\n" + text); return 0; }
  if (!E.TELEGRAM_BOT_TOKEN || !E.TELEGRAM_CHAT_ID) { say("notice: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are not set: no message"); return 0; }
  const link = E.RUN_URL || "";
  if (v.stuck) await (router ? router.alert("day", "live:stuck", text, link, { today: "loud", legacy: () => telegram(text) }) : telegram(text));
  else await (router ? router.alert("day", "live:error", text, link, { today: "loud", legacy: () => telegram(text) }) : telegram(text));
  return 0;
}

function selftest() {
  let bad = 0, n = 0;
  const ok = (c, m) => { n++; if (!c) { bad++; console.log("FAIL", m); } };
  const row = (t, status, requests, p50, p99 = p50) => ({ dimensions: { datetimeFiveMinutes: t, status }, sum: { requests }, quantiles: { wallTimeP50: p50, wallTimeP99: p99 } });
  // luchit-live on 20.10 as Cloudflare recorded it (UTC; requests, wall time p50 and p99 in microseconds): a hung call kept every load on
  // "loading" from about 14:00 until live-27 was deployed at 16:16; the fast answers in the same steps are the page itself. Replayed over
  // 19.10 03:10 to 20.10 17:35, this judgement alerts at the 14:12 to 16:12 runs and nowhere else (3 runs saw one slow step and stayed quiet).
  const D20 = [
    ["13:30", "success", 4, 221001, 5147461], ["13:35", "success", 2, 925, 1522],
    ["14:05", "success", 2, 1039, 3955], ["14:05", "clientDisconnected", 3, 1384077, 59137364],
    ["14:10", "clientDisconnected", 1, 301042300, 301042300], ["14:10", "success", 1, 1105, 1105],
    ["14:15", "clientDisconnected", 3, 59390404, 72102344], ["14:15", "success", 3, 990, 1048],
    ["14:30", "clientDisconnected", 1, 5071966, 5071966],
    ["14:50", "success", 5, 958, 222446], ["14:50", "clientDisconnected", 6, 9387297, 218792910],
    ["14:55", "clientDisconnected", 3, 98781256, 158789150], ["14:55", "success", 1, 803, 803],
    ["15:25", "clientDisconnected", 4, 1229158, 40259668], ["15:25", "success", 3, 1208, 1516],
    ["15:35", "success", 4, 899, 1173], ["15:35", "clientDisconnected", 5, 1162646, 13576876],
    ["15:40", "clientDisconnected", 2, 92481900, 92552790],
    ["15:45", "success", 1, 1151, 1151], ["15:45", "clientDisconnected", 2, 4763050, 18209364],
    ["15:50", "clientDisconnected", 2, 1765294, 69336750], ["15:50", "success", 1, 982, 982],
    ["15:55", "success", 2, 1183, 1638], ["15:55", "clientDisconnected", 4, 511798, 18621524],
    ["16:00", "success", 4, 1133, 1661], ["16:00", "clientDisconnected", 7, 682329, 21168916],
    ["16:15", "success", 8, 1331, 5735743], ["16:15", "clientDisconnected", 6, 829110, 45185576],
    ["16:20", "success", 3, 1460, 1160779], ["16:35", "success", 1, 5322261, 5322261],
    ["17:05", "success", 4, 1487, 3478138], ["17:10", "success", 4, 1579, 2105447], ["17:15", "success", 1, 3631493, 3631493],
  ].map(([t, st, q, p50, p99]) => row(`2026-10-20T${t}:00Z`, st, q, p50, p99));
  const at = hhmm => { const end = Date.parse(`2026-10-20T${hhmm}:00Z`); return judge(D20.filter(r => { const t = Date.parse(r.dimensions.datetimeFiveMinutes); return t > end - (WINDOW_MIN + 5) * 6e4 && t <= end; })); };
  ok(!at("13:42").stuck && !at("13:42").failing, "20.10, the 13:42 run, before the hang: quiet " + JSON.stringify(at("13:42")));
  ok(at("14:12").stuck, "20.10, the 14:12 run: 14:05 given up after 59 s, 14:10 after 301 s, stuck " + JSON.stringify(at("14:12")));
  ok(at("14:42").stuck, "20.10, the 14:42 run: stuck " + JSON.stringify(at("14:42")));
  ok(at("15:12").stuck, "20.10, the 15:12 run: 14:50 and 14:55 given up after 219 s and 159 s, stuck " + JSON.stringify(at("15:12")));
  ok(at("15:42").stuck, "20.10, the 15:42 run: stuck " + JSON.stringify(at("15:42")));
  ok(at("16:12").stuck && at("16:12").slowSteps === 3, "20.10, the 16:12 run: 15:40, 15:50 and 16:00 slow, 15:45 and 15:55 not (18 s) " + JSON.stringify(at("16:12")));
  ok(!at("16:42").stuck && !at("16:42").failing, "20.10, the 16:42 run, after live-27: quiet " + JSON.stringify(at("16:42")));
  ok(!at("17:42").stuck && !at("17:42").failing, "20.10, the 17:42 run, answers within 3.6 s: quiet " + JSON.stringify(at("17:42")));
  const T = i => `2026-10-21T09:${String(5 * i).padStart(2, "0")}:00Z`;
  ok(!judge([]).stuck && !judge([]).failing && judge([]).requests === 0, "no requests: nothing to judge");
  ok(!judge([0, 1, 2, 3, 4, 5].map(i => row(T(i), "success", 5, 1500, 3.5e6))).stuck, "a screen open for 30 minutes, answers in 3.5 s: ok");
  ok(!judge([row(T(0), "success", 5, 25000), row(T(1), "success", 5, 25000)]).stuck, "answers in 25 ms are fast (wall time is in microseconds)");
  // after live-28 a hang is answered at the 25 s deadline with the last good data: status success, about 25 s
  ok(judge([row(T(0), "success", 5, 25.1e6), row(T(1), "success", 5, 25.08e6)]).stuck, "answers at the deadline in two steps: stuck");
  ok(!judge([row(T(0), "success", 5, 25.1e6), row(T(1), "success", 5, 1500)]).stuck, "one late step: not yet");
  ok(!judge([row(T(0), "success", 9, 1500), row(T(0), "clientDisconnected", 1, 40e6), row(T(1), "success", 9, 1500), row(T(1), "clientDisconnected", 1, 50e6)]).stuck,
    "a tab closed mid-load in two steps, the rest on time: not stuck");
  ok(judge([row(T(0), "scriptThrewException", 2, 50e3), row(T(1), "exceededResources", 1, 50e3)]).failing, "3 Worker errors: failing");
  ok(!judge([row(T(0), "scriptThrewException", 2, 50e3)]).failing, "2 Worker errors: not yet");
  // what closes an open live: alert: a window with requests, none slow, no error (the quiet runs above with one slow step or one error do not)
  ok(!healthy(at("14:12")) && !healthy(at("16:12")), "20.10, 14:12 to 16:12: stuck, nothing closes");
  ok(healthy(at("16:42")), "20.10, the 16:42 run, the first after live-27 was deployed at 16:16: the alert from 14:12 closes " + JSON.stringify(at("16:42")));
  ok(!healthy(judge([])), "no requests: nothing proves /live answers, nothing closes");
  ok(!healthy(judge([row(T(0), "success", 5, 1500), row(T(1), "scriptThrewException", 1, 50e3)])), "one Worker error: not yet clean");
  ok(!healthy(judge([row(T(0), "success", 5, 25.1e6), row(T(1), "success", 5, 1500)])), "one late step: not yet clean");
  console.log(bad ? `selftest: ${bad} of ${n} checks FAILED` : `selftest ok (${n} checks)`);
  return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("live-watch.mjs")) process.exit(process.argv[2] === "selftest" ? selftest() : await watch());
