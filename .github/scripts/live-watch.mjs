// Live watch: is the /live dashboard answering? live-watch.yml runs it every 30 minutes. It reads Cloudflare's own record of the luchit-live
// Worker's requests over the last 35 minutes (GraphQL workersInvocationsAdaptive, 5-minute steps). Since live-28 the Worker answers /live/data
// within 25 s, with the last good data when a source is late, so a step whose requests mostly took 20 s or more means the screen was being
// served late; and a step where the page gave up on requests that had waited 20 s or more means it was not served at all (on 20.10 one hung
// call kept every load on "loading" for two hours). Two such steps, or 3 requests that ended in a Worker error: one Telegram (alert router,
// live:stuck or live:error, at most once in 6 hours) and a redeploy of the Worker from main (Workers deploy, mode on, workers live: fresh
// isolates; at most once in 6 hours, so a redeploy that did not help is said, not repeated).
// Quiet when all is well, and when nobody opened the screen (no requests, nothing to judge).
// Reads Cloudflare with CF_API_TOKEN (analytics); writes only the dispatch and the router's state. Prints the Worker's request counts and
// times, never a number from the dashboard. Never fails the run on a read problem (one notice line, green), so it cannot page every 30 minutes.
//   node live-watch.mjs            the watch (DRY=1: print what it would do, send and dispatch nothing; LIVE_WATCH=dry: the same)
//   node live-watch.mjs selftest   offline checks of the judgement, on the requests Cloudflare recorded on 20.10
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
      body: JSON.stringify({ chat_id: E.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }) });
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
  if (!v.stuck && !v.failing) { say("ok"); return 0; }

  // at most one redeploy and one message in 6 hours
  let router = null;
  try { router = await import("./alert.mjs"); } catch { /* the direct send below */ }
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
  const what = v.stuck ? `ב-${WINDOW_MIN} הדקות האחרונות רוב הבקשות לנתונים לקחו 20 שניות ויותר (${v.slowSteps} פרקי זמן של 5 דקות). המסך מציג בינתיים את הנתונים האחרונים שנשמרו, עם השעה שלהם.`
    : `${v.errors} בקשות ב-${WINDOW_MIN} הדקות האחרונות הסתיימו בשגיאה של ה-Worker (${Object.keys(v.errBy).join(", ")}).`;
  const next = redeployedAt ? `פריסה מחדש כבר רצה ב-${hhmm(redeployedAt)} ולא עזרה, ולכן לא הופעלה שוב. צריך לבדוק את הקוד של ה-Worker.`
    : /dispatched|would/.test(action) ? "הפעלתי פריסה מחדש של ה-Worker מ-main, וזה בדרך כלל פותר תקיעה. אם זה חוזר, צריך לבדוק את הקוד שלו."
    : "ניסיתי להפעיל פריסה מחדש של ה-Worker והיא לא הופעלה. אפשר להפעיל אותה ידנית: Workers deploy, mode on, workers live.";
  const text = `⚠️ לוחית: ${v.stuck ? "הדשבורד /live לא ענה בזמן" : "הדשבורד /live החזיר שגיאות"}\n\n${what}\n${next}`;
  if (until - told < GAP_MS) { say(`already told at ${new Date(told).toISOString()}, no message`); return 0; }
  if (dry) { say("would send:\n" + text); return 0; }
  if (!E.TELEGRAM_BOT_TOKEN || !E.TELEGRAM_CHAT_ID) { say("notice: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are not set: no message"); return 0; }
  const link = E.RUN_URL || "";
  if (v.stuck) await (router ? router.alert("day", "live:stuck", text, link, { today: "loud", plain: true, legacy: () => telegram(text) }) : telegram(text));
  else await (router ? router.alert("day", "live:error", text, link, { today: "loud", plain: true, legacy: () => telegram(text) }) : telegram(text));
  return 0;
}

function selftest() {
  let bad = 0, n = 0;
  const ok = (c, m) => { n++; if (!c) { bad++; console.log("FAIL", m); } };
  const row = (t, status, requests, p50) => ({ dimensions: { datetimeFiveMinutes: t, status }, sum: { requests }, quantiles: { wallTimeP50: p50, wallTimeP99: p50 } });
  const T = i => `2026-10-20T14:${String(5 * i).padStart(2, "0")}:00Z`;
  ok(!judge([]).stuck && !judge([]).failing && judge([]).requests === 0, "no requests: nothing to judge");
  ok(!judge([0, 1, 2, 3, 4, 5].map(i => row(T(i), "success", 5, 1800))).stuck, "a screen open for 30 minutes, answers in 2 s: ok");
  // 20.10 14:00-14:15 as Cloudflare recorded it (clientDisconnected, the page gave up at 45 s, one at 301 s)
  const hung = [row(T(0), "clientDisconnected", 17, 46607), row(T(1), "clientDisconnected", 3, 1384), row(T(2), "clientDisconnected", 1, 301042), row(T(3), "clientDisconnected", 3, 59390)];
  ok(judge(hung).stuck && judge(hung).slowSteps === 3, "the 20.10 hang is stuck " + JSON.stringify(judge(hung)));
  // after live-28 a hang is answered at the 25 s deadline with the last good data: status success, about 25 s
  ok(judge([row(T(0), "success", 5, 25100), row(T(1), "success", 5, 25080)]).stuck, "answers at the deadline in two steps: stuck");
  ok(!judge([row(T(0), "success", 5, 25100), row(T(1), "success", 5, 1500)]).stuck, "one late step: not yet");
  ok(!judge([row(T(0), "success", 9, 1500), row(T(0), "clientDisconnected", 1, 40000), row(T(1), "success", 9, 1500), row(T(1), "clientDisconnected", 1, 50000)]).stuck,
    "a tab closed mid-load in two steps, the rest on time: not stuck");
  ok(judge([row(T(0), "scriptThrewException", 2, 50), row(T(1), "exceededResources", 1, 50)]).failing, "3 Worker errors: failing");
  ok(!judge([row(T(0), "scriptThrewException", 2, 50)]).failing, "2 Worker errors: not yet");
  console.log(bad ? `selftest: ${bad} of ${n} checks FAILED` : `selftest ok (${n} checks)`);
  return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("live-watch.mjs")) process.exit(process.argv[2] === "selftest" ? selftest() : await watch());
