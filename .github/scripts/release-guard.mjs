// Release guard (release-guard.yml), zone A of the autopilot rules (strategy/autopilot-rules.md, Dudu 25.10 21:28): on day 1, 3 and 7 after an
// app version reaches people, compares it per 100 car checks with the version before it and tells the product thread through the alert router.
//   D0        the first Israel day the newest appVersion had at least MIN_USERS Android users (a tester alone never starts it)
//   base      the version most users had in the 14 days before D0, over those 14 days
//   checks    car_lookup of that version, D0 to yesterday; under MIN_CHECKS (either side) nothing is judged ("אין מספיק נתונים")
//   guardrails (rules file, "Day 1 / 3 / 7 after each app release"):
//     compare   compare_open from the card or the menu under 3 per 100 checks
//     save      car_save per 100 checks down more than 30% against the base
//     unsave    car_unsave over car_save above 45% (from 20 saves)
//     silent    an event the base sent at a rate that predicts at least 5 now, at 0 in the new version (update_*: the newest version has
//               nothing to update to, so those stop by design)
// Crashes stay with Release watch. Only reads GA4; findings go to the router (level day, a silent message, the morning triage routes them
// to product), a clean day is logged silently. The repo is public: the log prints states and counts of findings only, never a number.
// Node 20, node: builtins only. Commands:
//   node release-guard.mjs            GA_SERVICE_ACCOUNT_JSON, RUN_URL, MODE (on|dry), DAY (optional: judge as if today were this Israel date)
//   node release-guard.mjs selftest   offline
import crypto from "node:crypto";
import fs from "node:fs";
import { msg } from "./tg-text.mjs";

export const MIN_USERS = 10, MIN_CHECKS = 100, DAYS = [1, 3, 7], BASE_DAYS = 14;
export const T = { compare: 3, saveDrop: 0.30, unsave: 0.45, unsaveMin: 20, silentMin: 5 };
const J = s => { try { return JSON.parse(s); } catch { return null; } };
const PROPERTY = (() => { try { return String(J(fs.readFileSync(new URL("../../analytics/ga4-admin.json", import.meta.url), "utf8")).property || ""); } catch { return ""; } })();
const IO = { env: process.env, fetch: (u, o) => fetch(u, o), now: () => Date.now(), out: s => process.stdout.write(s + "\n"), router: null };
const ilDay = t => new Date(t).toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
const addDays = (s, n) => new Date(Date.parse(s + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);
const gaDate = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;   // GA4's 20261025 -> 2026-10-25
export const newer = (a, b) => { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0; } return false; };
const real = v => v && v !== "(not set)" && /^\d+(\.\d+)*$/.test(v);
const r1 = x => Math.round(x * 10) / 10;

// the Hebrew names of events, from the dashboard's own list (worker/live/worker.js, const N), so a message never shows a bare event name
export function names(src) {
  const m = /\bconst N=(\{[^\n]*?\});/.exec(src || "");
  return (m && J(m[1].replace(/([{,])([a-z_0-9]+):"/g, '$1"$2":"'))) || {};
}

const android = { filter: { fieldName: "platform", stringFilter: { value: "Android" } } };
export function queries(start, end) {
  const dateRanges = [{ startDate: start, endDate: end }];
  return {
    users: { dateRanges, dimensions: [{ name: "date" }, { name: "appVersion" }], metrics: [{ name: "activeUsers" }], dimensionFilter: android, limit: 10000 },
    events: { dateRanges, dimensions: [{ name: "date" }, { name: "appVersion" }, { name: "eventName" }], metrics: [{ name: "eventCount" }], dimensionFilter: android, limit: 50000 },
    compare: { dateRanges, dimensions: [{ name: "date" }, { name: "appVersion" }, { name: "customEvent:from" }], metrics: [{ name: "eventCount" }],
      dimensionFilter: { andGroup: { expressions: [android, { filter: { fieldName: "eventName", stringFilter: { value: "compare_open" } } }] } }, limit: 10000 },
  };
}
const rowsOf = j => (j?.rows || []).map(r => [...r.dimensionValues.map(x => x.value), ...r.metricValues.map(x => Number(x.value) || 0)]);

// S = { users: [[date, ver, n]], events: [[date, ver, name, n]], compare: [[date, ver, from, n]] } (GA4 dates), today = Israel date of the run
export function judge(S, today) {
  const y = addDays(today, -1), users = S.users.filter(r => real(r[1])).map(r => [gaDate(r[0]), r[1], r[2]]);
  const vers = [...new Set(users.map(r => r[1]))].sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0));
  const vn = vers.find(v => users.some(r => r[1] === v && r[2] >= MIN_USERS));
  if (!vn) return { state: "none" };
  const d0 = users.filter(r => r[1] === vn && r[2] >= MIN_USERS).map(r => r[0]).sort()[0], day = daysBetween(d0, y);
  const b0 = addDays(d0, -BASE_DAYS), b1 = addDays(d0, -1), byVer = {};
  for (const [d, v, n] of users) if (v !== vn && d >= b0 && d <= b1) byVer[v] = (byVer[v] || 0) + n;
  const prev = Object.keys(byVer).sort((a, b) => byVer[b] - byVer[a] || (newer(a, b) ? -1 : 1))[0] || null;
  const R = { vn, d0, day, prev, findings: [] };
  if (!DAYS.includes(day)) return { ...R, state: "wait" };
  if (!prev) return { ...R, state: "thin" };
  const cnt = (v, a, b) => { const o = {}; for (const [d, ver, e, n] of S.events) { const dd = gaDate(d); if (ver === v && dd >= a && dd <= b) o[e] = (o[e] || 0) + n; } return o; };
  const N = cnt(vn, d0, y), B = cnt(prev, b0, b1), nc = N.car_lookup || 0, bc = B.car_lookup || 0;
  const cmp = S.compare.filter(r => r[1] === vn && gaDate(r[0]) >= d0 && gaDate(r[0]) <= y && (r[2] === "card" || r[2] === "menu")).reduce((s, r) => s + r[3], 0);
  R.stats = { checks: nc, baseChecks: bc, compare: nc ? r1(cmp / nc * 100) : 0, save: nc ? r1((N.car_save || 0) / nc * 100) : 0, baseSave: bc ? r1((B.car_save || 0) / bc * 100) : 0,
    unsave: N.car_save ? Math.round((N.car_unsave || 0) / N.car_save * 100) : 0 };
  if (nc < MIN_CHECKS || bc < MIN_CHECKS) return { ...R, state: "thin" };
  const st = R.stats;
  if (cmp / nc * 100 < T.compare) R.findings.push({ id: "compare", he: `השוואת רכבים מהכרטיס ומהתפריט: ${st.compare} לכל 100 בדיקות (הסף: 3)` });
  const sN = (N.car_save || 0) / nc, sB = (B.car_save || 0) / bc;
  if (sB > 0 && sN < sB * (1 - T.saveDrop)) R.findings.push({ id: "save", he: `שמירת רכב: ${st.save} לכל 100 בדיקות, לעומת ${st.baseSave} בגרסה ${prev} (ירידה של ${Math.round((1 - sN / sB) * 100)}%, הסף: 30%)` });
  if ((N.car_save || 0) >= T.unsaveMin && (N.car_unsave || 0) / N.car_save > T.unsave) R.findings.push({ id: "unsave", he: `הסרות רכב מול שמירות: ${st.unsave}% (הסף: 45%)` });
  const gone = Object.keys(B).filter(e => e !== "car_lookup" && !/^update_/.test(e) && !N[e] && B[e] / bc * nc >= T.silentMin).sort();
  if (gone.length) R.findings.push({ id: "silent", events: gone, he: `אירועים שהגרסה הקודמת שלחה ועכשיו לא הגיעו בכלל: ${gone.length}` });
  return { ...R, state: R.findings.length ? "find" : "ok" };
}

export function text(R, N = {}) {
  const dayHe = R.day === 1 ? "יום אחרי" : `${R.day} ימים אחרי`;
  if (R.state === "find") return msg({ kind: "today", area: "measure", title: `גרסה ${R.vn}, ${dayHe} שהגיעה למשתמשים: ${R.findings.length === 1 ? "מדד אחד" : R.findings.length + " מדדים"} מחוץ לסף`,
    text: R.findings.map(f => "• " + f.he + (f.events ? "\n  " + f.events.map(e => N[e] || e).join(", ") : "")).join("\n")
      + `\nלפי ${R.stats.checks} בדיקות רכב בגרסה החדשה, מול ${R.stats.baseChecks} בגרסה ${R.prev} בשבועיים שלפניה.`,
    what: "שרשור «מוצר ושחרורים» בודק את זה. אצלך לא צריך לעשות כלום.", raw: `release guard ${R.vn} d${R.day} vs ${R.prev}: ${R.findings.map(f => f.id).join(", ")}` });
  if (R.state === "ok") return msg({ kind: "done", area: "measure", title: `גרסה ${R.vn}, ${dayHe} שהגיעה למשתמשים: הכול בטווח`,
    text: `השוואה, שמירה, הסרות ואירועים בטווח, לפי ${R.stats.checks} בדיקות רכב.` });
  return msg({ kind: "info", area: "measure", title: `גרסה ${R.vn}, ${dayHe} שהגיעה למשתמשים: אין מספיק נתונים`,
    text: `צריך לפחות ${MIN_CHECKS} בדיקות רכב בכל גרסה כדי להשוות. הבדיקה תחזור ביום ${DAYS.find(d => d > R.day) || "הבא"}.` });
}

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

async function main() {
  const E = IO.env, dry = E.MODE === "dry", sa = J(E.GA_SERVICE_ACCOUNT_JSON || "");
  if (!sa?.client_email || !sa?.private_key || !PROPERTY) { IO.out("release guard: no service account or property"); return 1; }
  const tok = await gaToken(sa);
  if (!tok) { IO.out("release guard: GA4 sign-in failed"); return 1; }
  const today = /^\d{4}-\d\d-\d\d$/.test(E.DAY || "") ? E.DAY : ilDay(IO.now()), Q = queries(addDays(today, -45), addDays(today, -1)), S = {};
  for (const [k, body] of Object.entries(Q)) {
    const r = await IO.fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:runReport`, { method: "POST",
      headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const j = J(await r.text());
    if (!r.ok || !j) { IO.out(`release guard: GA4 ${k} ${r.status}`); return 1; }
    S[k] = rowsOf(j);
  }
  const R = judge(S, today);
  IO.out(`release guard ${today}: ${R.state}${R.vn ? ` ${R.vn} from ${R.d0}, day ${R.day} vs ${R.prev || "-"}` : ""}${R.findings?.length ? `, findings: ${R.findings.map(f => f.id).join(", ")}` : ""}`);
  if (!["find", "ok", "thin"].includes(R.state)) return 0;
  let N = {};
  try { N = names(fs.readFileSync(new URL("../../worker/live/worker.js", import.meta.url), "utf8")); } catch {}
  const t = text(R, N), id = `${R.vn}-d${R.day}`, key = R.state === "find" ? "relguard:" + id : `relguard:${R.state}:${id}`;
  if (dry) { IO.out("dry, would send " + key + ":\n" + t.replace(/\d/g, "#")); return 0; }   // the log is public: digits masked
  const router = IO.router || await import("./alert.mjs");
  await router.alert(R.state === "find" ? "day" : "silent", key, t, E.RUN_URL || "", { today: R.state === "find" ? "silent" : "none" });
  return 0;
}

function selftest() {
  const fails = [], ok = (c, m) => { if (!c) fails.push(m); };
  const g = s => s.replace(/-/g, ""), days = (a, n) => Array.from({ length: n }, (_, i) => addDays(a, i));
  // 1.37 for weeks, 1.38 from 2026-10-28 (a tester on 10-24 with 1 user does not start it)
  const mk = ({ save38 = 10, unsave38 = 2, cmp38 = 5, drop = [] } = {}) => {
    const users = [], events = [], compare = [];
    for (const d of days("2026-10-01", 40)) {
      if (d < "2026-11-06") users.push([g(d), "1.37", 60]), events.push([g(d), "1.37", "car_lookup", 100], [g(d), "1.37", "car_save", 10], [g(d), "1.37", "car_unsave", 2], [g(d), "1.37", "svc_add", 3], [g(d), "1.37", "update_prompt", 9]);
      if (d === "2026-10-24") users.push([g(d), "1.38", 1]), events.push([g(d), "1.38", "car_lookup", 40]);
      if (d >= "2026-10-28") {
        users.push([g(d), "1.38", 30]); events.push([g(d), "1.38", "car_lookup", 60], [g(d), "1.38", "car_save", save38 * 0.6], [g(d), "1.38", "car_unsave", unsave38 * 0.6]);
        if (!drop.includes("svc_add")) events.push([g(d), "1.38", "svc_add", 2]);
        compare.push([g(d), "1.38", "card", cmp38 * 0.6 * 0.5], [g(d), "1.38", "menu", cmp38 * 0.6 * 0.5], [g(d), "1.38", "cars", 50]);
      }
      users.push([g(d), "(not set)", 99]);
    }
    return { users, events, compare };
  };
  let R = judge(mk(), "2026-10-30");
  ok(R.state === "ok" && R.vn === "1.38" && R.d0 === "2026-10-28" && R.day === 1 && R.prev === "1.37" && R.stats.checks === 120, "day 1 clean " + JSON.stringify(R));
  ok(judge(mk(), "2026-10-31").state === "wait" && judge(mk(), "2026-11-01").state === "ok" && judge(mk(), "2026-11-05").state === "ok", "only days 1, 3, 7");
  R = judge(mk({ save38: 6, unsave38: 4, cmp38: 2, drop: ["svc_add"] }), "2026-11-05");
  ok(R.state === "find" && R.findings.map(f => f.id).join() === "compare,save,unsave,silent" && R.findings[3].events.join() === "svc_add", "all four guardrails " + JSON.stringify(R.findings));
  ok(judge(mk({ save38: 8 }), "2026-11-05").state === "ok", "a 20% drop in saves is inside the 30%");
  ok(judge(mk({ unsave38: 5 }), "2026-10-30").state === "ok", "unsave under 20 saves is not judged");
  const thin = mk(); thin.events = thin.events.filter(r => !(r[1] === "1.38" && r[2] === "car_lookup")).concat([[g("2026-10-28"), "1.38", "car_lookup", 50]]);
  ok(judge(thin, "2026-10-30").state === "thin", "under 100 checks: not judged");
  ok(judge({ users: [], events: [], compare: [] }, "2026-10-30").state === "none", "no data");
  ok(newer("1.38", "1.37") && newer("1.40", "1.38") && newer("1.4", "1.38") === false && !newer("1.38", "1.38"), "version order");
  const N = names('x\nconst N={car_lookup:"בדיקת רכב",svc_add:"רישום טיפול או קילומטראז\' לרכב"};\ny');
  ok(N.svc_add && N.car_lookup === "בדיקת רכב", "event names from the dashboard " + JSON.stringify(N));
  let real = {}; try { real = names(fs.readFileSync(new URL("../../worker/live/worker.js", import.meta.url), "utf8")); } catch {}
  ok(real.car_save && real.compare_open, "the dashboard's list parses");
  R = judge(mk({ save38: 6, drop: ["svc_add"] }), "2026-11-05");
  const t = text(R, N);
  ok(t.startsWith("<b>🟠 לטיפול היום · מדידה</b>") && t.includes("רישום טיפול") && t.includes("1.37") && !t.includes("svc_add\n") && t.includes("מוצר ושחרורים"), "message " + t);
  ok(text(judge(mk(), "2026-10-30")).startsWith("<b>✅ בוצע · מדידה</b>"), "clean message");
  ok(text(judge(thin, "2026-10-30")).includes("אין מספיק נתונים"), "thin message");
  const Q = queries("2026-09-15", "2026-10-29");
  ok(Q.events.dimensions.length === 3 && Q.compare.dimensionFilter.andGroup.expressions.length === 2, "queries");
  ok(/^\d+$/.test(PROPERTY), "property from analytics/ga4-admin.json");
  IO.out(fails.length ? fails.map(f => "FAIL " + f).join("\n") + `\nselftest: ${fails.length} failed` : "selftest: all passed");
  return fails.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = process.argv[2] === "selftest" ? selftest() : await main();
