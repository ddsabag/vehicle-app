// Release watch (release-watch.yml): for 72 hours after a new build shows up on a Google Play track (Alpha after "שחרר", Production after the
// owner's promotion), looks at Android vitals for crash and ANR issues of that versionCode, and sends one Telegram per issue that is NEW in
// it (no report from an older version in the last 30 days). Quiet otherwise: issues that older versions already had are left to the daily
// crash/ANR rate check in Reviews monitor. Only reads: the tracks inside a throwaway edit (never committed) and the Reporting API.
// Crashlytics has no public API for its issues, so this reads Play's own vitals (users who share usage data with Google).
// State (watch.json, kept in the Actions cache like Reviews monitor's): when each track:versionCode was first seen, when each new issue was
// first found, which were told, and up to when Play's data was read for each versionCode. A staged rollout on Production is watched for as long as it runs (play-production.mjs reads the same file).
// Node 20, node: builtins only. Commands:
//   node release-watch.mjs gate      SHIP_TAIL, EVENT, REF, INPUT_MODE -> output mode (on|dry|off)
//   node release-watch.mjs           SHIP_SA_JSON, MODE (on|dry), STATE (path, default watch.json) -> Telegram (alert.mjs) for new issues or a broken check
//   node release-watch.mjs selftest  offline (mocked fetch, virtual clock)
import fs from "node:fs";
import crypto from "node:crypto";
import { jwt, Fail, gate, PKG, SECRET, escH, whyHe } from "./play-alpha.mjs";
import { msg } from "./tg-text.mjs";

export const WATCH_H = 72, HISTORY_D = 30, MAX_TELLS = 3;
export const LIVE = ["completed", "inProgress"];   // a draft or halted release reaches no one
const PLAY = "https://androidpublisher.googleapis.com", REP = "https://playdeveloperreporting.googleapis.com", TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher https://www.googleapis.com/auth/playdeveloperreporting";
const HOUR = 36e5, DAY = 24 * HOUR;
const TRACK_HE = { alpha: "מסלול הבדיקה Alpha", production: "Production", beta: "מסלול Beta", internal: "הבדיקה הפנימית" };
const TYPE_HE = { CRASH: "קריסה", ANR: "האפליקציה לא הגיבה (ANR)" };

const IO = {
  env: process.env, fetch: (u, o) => fetch(u, o), now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)), router: null,
  out: s => process.stdout.write(s + "\n"),
  output: (k, v) => { if (IO.env.GITHUB_OUTPUT) fs.appendFileSync(IO.env.GITHUB_OUTPUT, `${k}=${v}\n`); },
  summary: md => { if (IO.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(IO.env.GITHUB_STEP_SUMMARY, md + "\n"); },
  read: p => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } }, write: (p, s) => fs.writeFileSync(p, s),
};
const J = s => { try { return JSON.parse(s); } catch { return null; } };
const note = s => IO.out("::notice::" + s);
// a key segment from a name: 12 hex characters that start with a letter (alert.mjs refuses a long run of digits in a key)
export const tag = s => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 12).replace(/^\d/, "a");

// ---- gate: the SHIP_TAIL switch, as in Ship tail; the schedule acts, a manual run is dry unless mode=on, another branch is dry ----
export function watchGate(env) {
  const g = gate({ ...env, REF: "refs/heads/main", EVENT: env.EVENT === "schedule" ? "push" : env.EVENT, INPUT_STEP: "play" }), notes = [...g.notes];
  if (g.mode === "off") return { mode: "off", notes };
  if (env.EVENT !== "schedule" && env.EVENT !== "workflow_dispatch") return { mode: "off", notes: [...notes, `event ${String(env.EVENT || "?").slice(0, 20)}: nothing runs`] };
  if (env.REF !== "refs/heads/main") return env.EVENT === "workflow_dispatch" ? { mode: "dry", notes: [...notes, "not main: dry only"] } : { mode: "off", notes };
  return { mode: g.mode, notes };
}

// ---- HTTP (Google's retry rule: 5xx, 429 and network errors up to 4 times, 2/4/8 s apart) ----
async function call(method, url, { headers = {}, body, timeout = 60000, once = false } = {}) {
  for (let i = 0; ; i++) {
    let res;
    const c = new AbortController(), t = setTimeout(() => c.abort(), timeout);
    try {
      const r = await IO.fetch(url, { method, headers, body, signal: c.signal });
      res = { status: r.status, ok: r.ok, text: await r.text() };
    } catch (e) {
      const aborted = e?.name === "AbortError";
      res = { status: 0, ok: false, aborted, text: "network: " + (aborted ? "timeout" : String(e?.message || e).slice(0, 80)) };
    } finally { clearTimeout(t); }
    if ((res.status && res.status < 500 && res.status !== 429) || i === 3 || (once && res.aborted)) return res;
    await IO.sleep(2000 * 2 ** i);
  }
}
async function accessToken(sa) {
  let assertion;
  try { assertion = jwt(sa, SCOPE, IO.now()); } catch { throw new Fail(`המפתח בסוד ${SECRET} לא תקין`, `ליצור מפתח JSON חדש לחשבון השירות ולהדביק אותו בסוד ${SECRET}`); }
  const r = await call("POST", TOKEN_URL, { headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString() });
  const t = r.ok && J(r.text)?.access_token;
  if (t) return t;
  throw new Fail(r.status === 400 || r.status === 401 ? "Google לא קיבל את מפתח חשבון השירות" : `ההתחברות ל-Google לא הצליחה (${r.status || "אין חיבור"})`,
    r.status === 400 || r.status === 401 ? `ליצור מפתח JSON חדש לחשבון השירות ולהדביק אותו בסוד ${SECRET}` : "שום דבר, הבדיקה הבאה תנסה שוב", r.status);
}
function googleFail(r, what) {
  const msg = String(J(r.text)?.error?.message || r.text || "").replace(/\s+/g, " ").slice(0, 160);
  if (/has not been used in project|SERVICE_DISABLED|API .*is disabled/i.test(msg))
    return new Fail(`ה-API של ${what} כבוי בפרויקט של חשבון השירות`, `להפעיל את ${what === "Play vitals" ? "Google Play Developer Reporting API" : "Google Play Android Developer API"} ב-Google Cloud Console, בפרויקט luchit`, r.status);
  if (r.status === 401 || r.status === 403)
    return new Fail(`לחשבון השירות אין הרשאה לקרוא את ${what}`, 'Play Console ← Users and permissions ← ship-tail ← App permissions ← לוחית: לסמן "View app information and download bulk reports (read-only)"', r.status);
  if (!r.status || r.status >= 500 || r.status === 429) return new Fail(`${what} לא ענה (${r.status || "אין חיבור"})`, "שום דבר, הבדיקה הבאה תנסה שוב", r.status);
  return new Fail(`${what} החזיר ${r.status}: ${msg || "בלי פירוט"}`, "", r.status);
}
// reads only: an edit to list the tracks (deleted right after, never committed) and the Reporting API's GETs
async function get(ctx, url, what) {
  const r = await call("GET", url, { headers: { authorization: "Bearer " + ctx.token } });
  if (!r.ok) throw googleFail(r, what);
  return J(r.text) || {};
}
async function tracksNow(ctx) {
  const E = `${PLAY}/androidpublisher/v3/applications/${ctx.pkg}/edits`, H = { authorization: "Bearer " + ctx.token };
  const r = await call("POST", E, { headers: { ...H, "content-type": "application/json" }, body: "{}" });
  const id = r.ok && J(r.text)?.id;
  if (!id) throw googleFail(r, "Google Play");
  try { return (await get(ctx, `${E}/${id}/tracks`, "Google Play")).tracks || []; }
  finally { await call("DELETE", `${E}/${id}`, { headers: H }).catch(() => null); }
}
// the newest live build per track: { "alpha:110": { track, vc, vn } }
export function liveBuilds(tracks) {
  const out = {};
  for (const t of Array.isArray(tracks) ? tracks : []) {
    const rel = (t?.releases || []).filter(r => LIVE.includes(r.status)).map(r => ({ vn: String(r.name || "").slice(0, 30), staged: r.status === "inProgress", codes: (r.versionCodes || []).map(Number).filter(Number.isFinite) }));
    const best = rel.flatMap(r => r.codes.map(vc => ({ vc, vn: r.vn, staged: r.staged }))).sort((a, b) => b.vc - a.vc)[0];
    if (best) out[`${t.track}:${best.vc}`] = { track: t.track, ...best };
  }
  return out;
}

// ---- Reporting API ----
const hourOf = ms => Math.floor(ms / HOUR) * HOUR;
const dt = (p, ms) => { const d = new Date(ms); return { [`${p}.year`]: d.getUTCFullYear(), [`${p}.month`]: d.getUTCMonth() + 1, [`${p}.day`]: d.getUTCDate(), [`${p}.hours`]: d.getUTCHours() }; };
// the newest hour Play has error data for (hourly, UTC); an answer without it means the last full hour
// how far Play's hourly data reaches; real = Play said so (else a guess of an hour ago, which never counts as data read)
async function dataEnd(ctx) {
  const f = await get(ctx, `${REP}/v1beta1/apps/${ctx.pkg}/errorCountMetricSet`, "Play vitals");
  const h = (f.freshnessInfo?.freshnesses || []).find(x => x.aggregationPeriod === "HOURLY")?.latestEndTime;
  return h?.year ? { end: Date.UTC(h.year, h.month - 1, h.day, h.hours || 0), real: true } : { end: hourOf(IO.now()) - HOUR, real: false };
}
export const FILTER = vc => `${vc ? `versionCode = ${vc} AND ` : ""}errorIssueType = CRASH OR errorIssueType = ANR`;
export async function issues(ctx, from, to, vc) {
  const all = [];
  let page = "";
  for (let n = 0; n < 5; n++) {
    const q = new URLSearchParams({ ...dt("interval.startTime", from), ...dt("interval.endTime", to), filter: FILTER(vc), pageSize: "200", orderBy: "distinctUsers desc", ...(page ? { pageToken: page } : {}) });
    const r = await get(ctx, `${REP}/v1beta1/apps/${ctx.pkg}/errorIssues:search?${q}`, "Play vitals");
    all.push(...(r.errorIssues || []));
    if (!(page = r.nextPageToken)) break;
  }
  return all;
}

// ---- the watch ----
export async function watch() {
  const env = IO.env, mode = env.MODE === "on" ? "on" : "dry", file = env.STATE || "watch.json", now = IO.now();
  const R = { code: "", mode, watched: [], found: [], tells: [], why: "", next: "" };
  const raw = String(env[SECRET] || "").trim();
  if (!raw) { note(`${SECRET} is not set: nothing is watched`); return { ...R, code: "nosecret" }; }
  const st = J(IO.read(file)) || {}, S = { ...st, seen: st.seen || {}, told: st.told || {}, issues: st.issues || {}, checked: st.checked || {} };
  // no state restored (the first run, or the cache lost it): everything this run finds looks first-found now, so play-production.mjs halts on
  // none of it (it was found by the watch before, or never told: the Telegram still goes out)
  if (!Object.keys(st).length) S.reset = now;
  try {
    const sa = J(raw);
    if (!sa?.client_email || !sa?.private_key) throw new Fail(`הסוד ${SECRET} אינו מפתח JSON של חשבון שירות`, `להדביק בסוד ${SECRET} את כל קובץ ה-JSON של המפתח`);
    const ctx = { pkg: env.PLAY_PACKAGE || PKG, token: await accessToken(sa) };
    const builds = liveBuilds(await tracksNow(ctx));
    for (const k of Object.keys(builds)) S.seen[k] ??= now;
    // a staged rollout is watched for as long as it runs (Google's review can take longer than the window; play-production.mjs acts on it)
    const due = Object.entries(builds).filter(([k, b]) => b.staged || now - S.seen[k] < WATCH_H * HOUR).map(([k, b]) => ({ key: k, ...b, since: S.seen[k] }));
    R.watched = due.map(b => `${b.track} ${b.vn || "?"} (${b.vc}), ${Math.floor((now - b.since) / HOUR)} h`);
    if (due.length) {
      const { end, real } = await dataEnd(ctx);
      let history = null;
      for (const b of [...new Map(due.map(b => [b.vc, b])).values()]) {
        const from = hourOf(b.since - DAY);   // the first look can come hours after the upload (no run at night)
        if (end <= from) { IO.out(`vitals ${b.vc}: no hourly data after ${new Date(from).toISOString().slice(0, 13)}h yet`); continue; }
        const mine = await issues(ctx, from, end, b.vc);
        IO.out(`vitals ${b.vc}: ${mine.length} crash/ANR issues, ${new Date(from).toISOString().slice(0, 13)}h to ${new Date(end).toISOString().slice(0, 13)}h UTC`);
        if (!mine.length) { if (real) S.checked[b.vc] = end; continue; }
        // new = no report from an older version in the last 30 days (the earliest version Play saw for the issue is this one or newer)
        history ??= new Map((await issues(ctx, end - HISTORY_D * DAY, end, 0)).map(i => [i.name, i]));
        for (const i of mine) {
          const first = +(history.get(i.name)?.firstAppVersion?.versionCode || i.firstAppVersion?.versionCode || 0);
          const isNew = !first || first >= b.vc;
          R.found.push({ vc: b.vc, issue: tag(i.name), type: i.type, reports: +i.errorReportCount || 0, users: +i.distinctUsers || 0, isNew });
          const told = `${b.vc}:${i.name}`;
          if (isNew) S.issues[told] ??= S.told[told] ?? now;   // when the watch first found it (play-production.mjs halts a rollout on one found after it began)
          if (isNew && !S.told[told]) R.tells.push({ b, i, told });
        }
        if (real) S.checked[b.vc] = end;   // how far Play's data was read for this build (play-production.mjs completes a rollout only past its 48 h)
      }
    }
    R.code = R.tells.length ? "new" : "quiet";
  } catch (e) {
    const f = e instanceof Fail ? e : new Fail("תקלה בסקריפט: " + String(e?.message || e).slice(0, 120), "לבדוק את הלוג של Release watch");
    Object.assign(R, { code: "error", why: f.why, next: f.next, status: f.status });
  }
  // prune: builds and issues older than the history window
  for (const o of [S.seen, S.told, S.issues, S.checked]) for (const k of Object.keys(o)) if (now - o[k] > HISTORY_D * DAY) delete o[k];
  R.state = S;
  return R;
}
// one new issue -> one 🟠 message: how many people, crash or freeze, and what to do by track; the code details fold away
export function compose(t, env = {}) {
  const { b, i } = t, n = +i.errorReportCount || 0, u = +i.distinctUsers || 0;
  const where = String(i.location || "").slice(0, 120), cause = String(i.cause || "").slice(0, 160);
  const link = /^https:\/\/play\.google\.com\//.test(i.issueUri || "") ? i.issueUri : "";
  const what = i.type === "ANR" ? "האפליקציה נתקעה ולא הגיבה" : "האפליקציה קרסה", who = u ? (u === 1 ? "משתמש אחד" : `${u} משתמשים`) : "משתמשים";
  const prod = b.track === "production", tr = TRACK_HE[b.track] || b.track;
  const todo = (prod ? "אם זו הפצה הדרגתית, היא נעצרת לבד ותגיע הודעה נפרדת. " : 'עדיף לא לכתוב "פרסם" לגרסה הזו לפני שבודקים. ')
    + 'לכתוב בשרשור "מוצר ושחרורים" כדי לבדוק ולתקן.' + (link ? ` <a href="${escH(link)}">הדיווח ב-Play Console</a>` : "");
  const text = msg({ kind: "today", area: "app", title: `בעיה חדשה בגרסה ${escH(b.vn || "")}: ${what}`,
    text: `זה קרה ל-${who} (${n} ${n === 1 ? "דיווח" : "דיווחים"}) מאז שהגרסה עלתה ${/^[A-Za-z]/.test(tr) ? "ל-" : "ל"}${escH(tr)}. ` +
      `בגרסאות הקודמות זה לא הופיע ב-30 הימים האחרונים.${!prod ? " בשלב הזה רק הבודקים מקבלים את הגרסה." : ""}`,
    what: todo, raw: [`versionCode ${b.vc}`, `${i.type || "?"}: ${cause}`, where ? `איפה: ${where}` : "", i.issueUri || ""].filter(Boolean).join(" · ") });
  return { key: `watch:new:${b.vc}:${tag(i.name)}`, text, link };
}
// the check itself broke: once a day at most (alert.mjs dedupe on the fixed key)
export function composeError(R, env = {}) {
  const w = whyHe(R.why), run = env.RUN_URL || "";
  return msg({ kind: "today", area: "app", title: "המעקב אחרי הגרסה החדשה לא הצליח לקרוא מ-Google Play",
    text: `${w.he}. עד שזה מתוקן, קריסות חדשות בגרסה לא יגיעו כהודעה.`,
    what: `${R.next ? escH(R.next) + "." : 'לכתוב בשרשור "מוצר ושחרורים".'}${run ? ` <a href="${escH(run)}">הלוג</a>` : ""}`, raw: w.raw });
}
async function telegram(text) {
  const r = await call("POST", `https://api.telegram.org/bot${IO.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: IO.env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }), timeout: 20000, once: true });
  IO.out(`telegram ${r.status || "no answer"}`);
  return r.ok;
}
async function send(key, text, link) {
  if (!IO.env.TELEGRAM_BOT_TOKEN || !IO.env.TELEGRAM_CHAT_ID) { note("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are not set: no message"); return false; }
  let router = IO.router;
  if (!router) try { router = await import("./alert.mjs"); } catch { /* legacy below */ }
  const r = router ? await router.alert("day", key, text, link, { today: "loud", legacy: () => telegram(text) }) : { delivered: await telegram(text) };
  return !!r.delivered;
}
// a run that read Play again ends the open "could not read" alert: the router tells it "חזר לתקין" once
async function settle() {
  let router = IO.router;
  if (!router) try { router = await import("./alert.mjs"); } catch { return; }
  if (router?.resolve) try { await router.resolve(["watch:error"]); } catch { /* the morning ledger still shows it */ }
}

// ---- CLI ----
export async function cli(argv) {
  const cmd = argv[0] || "";
  if (cmd === "gate") {
    const g = watchGate(IO.env);
    for (const n of g.notes) note(n);
    IO.output("mode", g.mode);
    IO.out(`gate: mode=${g.mode}`);
    return 0;
  }
  if (cmd === "selftest") return selftest();
  if (cmd) { IO.out("usage: release-watch.mjs [gate|selftest]"); return 2; }
  const R = await watch(), dry = R.mode !== "on";
  IO.out(`watched: ${R.watched.join("; ") || "nothing new on Play in the last " + WATCH_H + " h"}`);
  for (const f of R.found) IO.out(`issue ${f.issue} in ${f.vc}: ${f.type}, ${f.reports} reports, ${f.users} users, ${f.isNew ? "new in this version" : "older versions too"}`);
  let failed = false;
  if (R.code === "error") {
    IO.out(`::warning::Release watch could not read Play: ${R.why}`);
    // a broken check is told once a day at most (alert.mjs dedupe on the fixed key)
    if (!dry && !(await send("watch:error", composeError(R, IO.env), IO.env.RUN_URL || ""))) failed = true;
  }
  if (!dry && (R.code === "new" || R.code === "quiet")) await settle();
  for (const t of R.tells.slice(0, MAX_TELLS)) {
    const m = compose(t, IO.env);
    if (dry) { IO.out(`dry run: would send ${m.key}`); continue; }
    if (await send(m.key, m.text, m.link)) R.state.told[t.told] = IO.now(); else failed = true;
  }
  if (R.tells.length > MAX_TELLS) IO.out(`${R.tells.length - MAX_TELLS} more new issues wait for the next run`);
  if (!dry && R.code !== "nosecret") IO.write(IO.env.STATE || "watch.json", JSON.stringify(R.state));
  IO.summary([`### Release watch (${R.mode})`, "", `- result: **${R.code}**${R.why ? `: ${R.why}` : ""}`, `- watched: ${R.watched.join("; ") || "-"}`,
    ...R.found.map(f => `- issue ${f.issue} (${f.vc}, ${f.type}): ${f.reports} reports, ${f.users} users, ${f.isNew ? "**new**" : "older too"}`)].join("\n"));
  IO.output("code", R.code);
  return failed ? 1 : 0;
}

// ---- selftest (offline) ----
async function selftest() {
  const fails = [], ok = (c, m) => { if (!c) fails.push(m); };
  const group = async (name, fn) => { try { await fn(); } catch (e) { fails.push(`${name} crashed: ${String(e?.stack || e).split("\n").slice(0, 3).join(" | ")}`); } };
  const saved = { ...IO }, realFetch = globalThis.fetch;
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const SA = { type: "service_account", client_email: "ship@luchit-test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) };
  const TOKEN = "ya29.SECRET-ACCESS-TOKEN-w1", TG = "777:SECRET-BOT-TOKEN-w2", T0 = Date.UTC(2026, 9, 20, 9, 40);
  const ALPHA_110 = [{ track: "production", releases: [{ name: "1.32", versionCodes: ["108"], status: "completed" }] }, { track: "alpha", releases: [{ name: "1.33", versionCodes: ["110"], status: "completed" }, { name: "x", versionCodes: ["111"], status: "draft" }] }];
  const ISSUE = (name, type, vcFirst, n = 3, u = 2) => ({ name: `apps/${PKG}/${name}`, type, cause: "java.lang.IllegalStateException", location: "com.ddsabag.pratirechev.MainActivity.onCreate",
    errorReportCount: String(n), distinctUsers: String(u), issueUri: `https://play.google.com/console/developers/1/app/2/vitals/crashes/${name}`, firstAppVersion: { versionCode: String(vcFirst) } });
  function world(o = {}) {
    const W = { calls: [], printed: [], outputs: {}, sums: [], tg: [], files: { "watch.json": o.state ? JSON.stringify(o.state) : null }, clock: o.now ?? T0, edits: 0, open: new Set() };
    const res = (s, b) => new Response(s === 204 ? null : JSON.stringify(b ?? {}), { status: s });
    W.fetch = async (url, opt = {}) => {
      const method = opt.method || "GET", u = new URL(url), p = u.pathname;
      W.calls.push({ method, url, body: opt.body });
      if (url === TOKEN_URL) return res(200, { access_token: TOKEN });
      if (u.host === "api.telegram.org") { W.tg.push(J(opt.body)); return res(200, { ok: true }); }
      if (opt.headers?.authorization !== "Bearer " + TOKEN) return res(401, {});
      if (u.origin === PLAY) {
        if (method === "POST" && p.endsWith("/edits")) { W.edits++; W.open.add("e" + W.edits); return o.playFail ? res(o.playFail, { error: { message: "denied" } }) : res(200, { id: "e" + W.edits }); }
        if (method === "GET" && p.endsWith("/tracks")) return res(200, { tracks: o.tracks ?? ALPHA_110 });
        if (method === "DELETE") { W.open.delete(p.split("/").pop()); return res(204); }
        return res(400, { error: { message: "unexpected " + method + " " + p } });
      }
      if (u.origin === REP) {
        if (o.repFail) return res(o.repFail.status, { error: { message: o.repFail.msg || "x" } });
        if (p.endsWith("/errorCountMetricSet")) return res(200, o.noFresh ? { freshnessInfo: { freshnesses: [] } } : { freshnessInfo: { freshnesses: [{ aggregationPeriod: "HOURLY", latestEndTime: { year: 2026, month: 10, day: 20, hours: 8 } }] } });
        if (p.endsWith("/errorIssues:search")) {
          const f = u.searchParams.get("filter"), vc = /versionCode = (\d+)/.exec(f)?.[1];
          return res(200, { errorIssues: vc ? (o.mine?.[vc] || []) : (o.history || []) });
        }
      }
      return res(404, {});
    };
    return W;
  }
  const ENV = { [SECRET]: JSON.stringify(SA), MODE: "on", TELEGRAM_BOT_TOKEN: TG, TELEGRAM_CHAT_ID: "42", RUN_URL: "https://github.com/ddsabag/vehicle-app/actions/runs/9" };
  const run = async (o = {}, env = {}, argv = []) => {
    const W = world(o);
    globalThis.fetch = W.fetch;
    Object.assign(IO, { env: { ...ENV, ...env }, fetch: W.fetch, now: () => W.clock, sleep: async ms => { W.clock += ms; }, router: o.router || null,
      out: s => W.printed.push(s), output: (k, v) => { W.outputs[k] = v; }, summary: s => W.sums.push(s), read: p => W.files[p] ?? null, write: (p, s) => { W.files[p] = s; } });
    W.code = await cli(argv);
    W.state = J(W.files["watch.json"] || "null");
    W.reads = W.calls.filter(c => !c.url.startsWith(TOKEN_URL) && !c.url.includes("api.telegram.org"));
    return W;
  };
  let W;

  await group("gate", async () => {
    const g = (v, e) => watchGate({ SHIP_TAIL: v, REF: "refs/heads/main", ...e }).mode;
    ok(g("", { EVENT: "schedule" }) === "on" && g("dry", { EVENT: "schedule" }) === "dry" && g("off", { EVENT: "schedule" }) === "off", "gate: schedule follows SHIP_TAIL");
    ok(g("", { EVENT: "workflow_dispatch" }) === "dry" && g("", { EVENT: "workflow_dispatch", INPUT_MODE: "on" }) === "on" && g("", { EVENT: "workflow_dispatch", INPUT_MODE: "on", REF: "refs/heads/x" }) === "dry", "gate: manual dry by default, branch dry");
    ok(g("", { EVENT: "push" }) === "off", "gate: other events off");
  });

  await group("first look", async () => {
    // no state yet: the live builds are recorded now (the draft is not live) and watched; nothing found = quiet, no Telegram
    W = await run();
    ok(W.code === 0 && W.outputs.code === "quiet" && W.tg.length === 0 && W.state.reset === T0, "first look: quiet, the reset marked " + W.printed.join(" | "));
    ok(Object.keys(W.state.seen).sort().join() === "alpha:110,production:108" && W.state.seen["alpha:110"] === T0, "first look: live builds recorded " + JSON.stringify(W.state));
    ok(W.open.size === 0 && W.reads.every(c => c.method === "GET" || /\/edits$/.test(new URL(c.url).pathname) || c.method === "DELETE"), "only reads: the edit is deleted, nothing committed");
    ok(!W.calls.some(c => /:commit|:validate|\/tracks\/|PUT|PATCH/.test(c.method + c.url)), "never commits or writes a track");
  });

  await group("new issue", async () => {
    // a crash that only 110 has: one Telegram with what and where, the issue remembered; the next run does not repeat it
    const crash = ISSUE("i1", "CRASH", 110, 5, 3);
    W = await run({ state: { seen: { "alpha:110": T0 - 20 * HOUR, "production:108": T0 - 5 * DAY } }, mine: { 110: [crash] }, history: [crash] });
    ok(W.outputs.code === "new" && W.tg.length === 1 && W.tg[0].text.includes("1.33") && W.tg[0].text.includes("Alpha") && W.tg[0].text.includes("3 משתמשים (5 דיווחים)") && W.tg[0].text.includes("🟠") && /<blockquote expandable>[^]*MainActivity/.test(W.tg[0].text) && W.tg[0].parse_mode === "HTML", "new: told " + W.tg.map(x => x.text));
    ok(Object.keys(W.state.told).length === 1 && W.state.issues[`110:apps/${PKG}/i1`] === T0 && W.state.checked["110"] === Date.UTC(2026, 9, 20, 8), "new: remembered, with when it was found and how far the data was read " + JSON.stringify(W.state));
    const searches = W.calls.filter(c => c.url.includes("errorIssues:search")).map(c => new URL(c.url).searchParams);
    ok(searches[0].get("filter") === "versionCode = 110 AND errorIssueType = CRASH OR errorIssueType = ANR" && searches[0].get("interval.startTime.hours") === String(new Date(T0 - 44 * HOUR).getUTCHours()) && searches[0].get("interval.endTime.hours") === "8", "new: filter and hour-aligned interval");
    ok(!W.calls.some(c => c.url.includes("versionCode = 108") || c.url.includes("versionCode+%3D+108")), "new: production 108 is past its 72 h");
    const W3 = await run({ state: { seen: { "alpha:110": T0 - 20 * HOUR } }, mine: { 110: [] }, noFresh: true });
    ok(!W3.state.checked["110"] && !("reset" in W3.state), "new: no freshness from Play = nothing counts as read; a restored state has no reset " + JSON.stringify(W3.state));
    const W2 = await run({ state: W.state, mine: { 110: [crash] }, history: [crash] });
    ok(W2.tg.length === 0 && W2.outputs.code === "quiet", "new: not told twice");
  });

  await group("older issue", async () => {
    // the same crash also in 108: quiet (the daily rate check covers it)
    const old = ISSUE("i2", "ANR", 108);
    W = await run({ state: { seen: { "alpha:110": T0 - 2 * HOUR } }, mine: { 110: [old] }, history: [old] });
    ok(W.outputs.code === "quiet" && W.tg.length === 0 && W.printed.some(l => l.includes("older versions too")), "older: quiet");
  });

  await group("windows", async () => {
    W = await run({ state: { seen: { "alpha:110": T0 - 80 * HOUR, "production:108": T0 - 9 * DAY } }, mine: { 110: [ISSUE("i3", "CRASH", 110)] } });
    ok(W.outputs.code === "quiet" && !W.calls.some(c => c.url.includes("errorIssues")), "windows: after 72 h nothing is asked");
    // the owner promotes 110 to production: a new 72 h for production
    W = await run({ state: { seen: { "alpha:110": T0 - 80 * HOUR } }, tracks: [{ track: "production", releases: [{ name: "1.33", versionCodes: ["110"], status: "inProgress", userFraction: 0.2 }] }, ALPHA_110[1]], mine: { 110: [ISSUE("i4", "CRASH", 110)] }, history: [] });
    ok(W.outputs.code === "new" && W.tg.length === 1 && W.tg[0].text.includes("Production") && W.state.seen["production:110"] === T0, "windows: promotion starts a production watch");
    // a staged rollout still running after 72 h (a long review) is still watched; an issue told on Alpha keeps that time (found before the rollout)
    W = await run({ state: { seen: { "alpha:110": T0 - 9 * DAY, "production:110": T0 - 100 * HOUR }, told: { [`110:apps/${PKG}/i6`]: T0 - 8 * DAY }, live: { "production:110": T0 - HOUR } },
      tracks: [{ track: "production", releases: [{ name: "1.33", versionCodes: ["110"], status: "inProgress", userFraction: 0.2 }, { name: "1.32", versionCodes: ["108"], status: "completed" }] }, ALPHA_110[1]], mine: { 110: [ISSUE("i6", "CRASH", 110)] }, history: [] });
    ok(W.calls.some(c => c.url.includes("errorIssues")) && W.tg.length === 0 && W.state.issues[`110:apps/${PKG}/i6`] === T0 - 8 * DAY && W.state.live["production:110"] === T0 - HOUR, "windows: a staged rollout is watched past 72 h, other state kept " + JSON.stringify(W.state));
    W = await run({ state: { seen: { "alpha:110": T0 - 10 * DAY, "x:1": T0 - 40 * DAY }, told: { "100:a": T0 - 31 * DAY }, issues: { "100:a": T0 - 31 * DAY, "110:b": T0 - DAY } } });
    ok(!("x:1" in W.state.seen) && !("100:a" in W.state.told) && Object.keys(W.state.issues).join() === "110:b", "windows: old state pruned");
  });

  await group("errors and modes", async () => {
    W = await run({ repFail: { status: 403, msg: "The caller does not have permission" } });
    ok(W.outputs.code === "error" && W.tg.length === 1 && W.tg[0].text.includes("View app information") && W.code === 0, "403: told once with the fix " + W.tg.map(x => x.text));
    W = await run({ repFail: { status: 403, msg: "Google Play Developer Reporting API has not been used in project 1 before or it is disabled" } });
    ok(W.tg[0]?.text.includes("Google Play Developer Reporting API"), "API off: told which API");
    W = await run({ playFail: 403 });
    ok(W.outputs.code === "error" && W.tg.length === 1, "Play 403: told");
    W = await run({ state: { seen: { "alpha:110": T0 - HOUR } }, mine: { 110: [ISSUE("i5", "CRASH", 110)] } }, { MODE: "dry" });
    ok(W.outputs.code === "new" && W.tg.length === 0 && W.files["watch.json"] === JSON.stringify({ seen: { "alpha:110": T0 - HOUR } }) && W.printed.some(l => l.startsWith("dry run: would send watch:new:110:")), "dry: nothing sent, state untouched");
    W = await run({}, { [SECRET]: "" });
    ok(W.outputs.code === "nosecret" && W.calls.length === 0 && W.tg.length === 0, "no secret: nothing");
    const many = Array.from({ length: 5 }, (_, k) => ISSUE("m" + k, "CRASH", 110));
    W = await run({ state: { seen: { "alpha:110": T0 - HOUR } }, mine: { 110: many }, history: many });
    ok(W.tg.length === MAX_TELLS && Object.keys(W.state.told).length === MAX_TELLS, "at most 3 per run, the rest next run");
  });

  await group("router and secrets", async () => {
    const seen = [], router = { alert: async (lv, key, text, link, o) => { seen.push({ lv, key, link, o }); return { delivered: true }; } };
    const { validKey } = await import("./alert.mjs");
    W = await run({ router, state: { seen: { "alpha:110": T0 - HOUR } }, mine: { 110: [ISSUE("r1", "CRASH", 110)] } });
    W = await run({ router, repFail: { status: 500 } });
    ok(seen.length === 2 && seen.every(s => s.lv === "day" && validKey(s.key) && !s.o.plain) && seen[0].key.startsWith("watch:new:110:") && seen[1].key === "watch:error" && seen[0].link.startsWith("https://play.google.com/"), "router: day, valid keys " + seen.map(s => s.key));
    // Play read again (quiet or a new issue) closes watch:error; a failed read or a dry run leaves it open
    const settled = [], r2 = { alert: async () => ({ delivered: true }), resolve: async p => { settled.push(p.join("|")); return 1; } };
    W = await run({ router: r2 });
    W = await run({ router: r2, state: { seen: { "alpha:110": T0 - HOUR } }, mine: { 110: [ISSUE("r2", "CRASH", 110)] } });
    W = await run({ router: r2, repFail: { status: 500 } });
    W = await run({ router: r2 }, { MODE: "dry" });
    ok(settled.join() === "watch:error,watch:error", "router: a run that read Play closes watch:error " + settled);
    W = await run({ state: { seen: { "alpha:110": T0 - HOUR } }, mine: { 110: [ISSUE("s1", "CRASH", 110)] } });
    const all = [...W.printed, ...W.sums, ...Object.values(W.outputs), ...W.tg.map(x => x.text)].join("\n");
    ok(![TOKEN, TG, "PRIVATE KEY", SA.client_email].some(x => all.includes(x)), "secrets stay out of the output");
    ok(!W.sums.join("\n").includes("play.google.com/console") && !W.printed.join("\n").includes("MainActivity"), "the public log has no console links or code locations");
  });

  Object.assign(IO, saved); globalThis.fetch = realFetch;
  for (const f of fails) IO.out("FAIL " + f);
  IO.out(fails.length ? `selftest: ${fails.length} failed` : "selftest: all passed");
  return fails.length ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("release-watch.mjs")) process.exit(await cli(process.argv.slice(2)));
