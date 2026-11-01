// A second look by Claude at what the release guard raises (credit package A6, Dudu 1.11.2026 21:16 UTC, API-credits thread). Labels only:
// it adds one line to the guard's own router message and never opens, closes or changes a finding or a zone A item.
//   zoneACause(api, rows, yd)   a zone A breach (slow or failed checks yesterday): the hours by platform and version say whether the data source
//                               slowed everyone at the same hours ("source") or one app version is behind it ("version"); Sonnet 5.5 decides,
//                               the line is built here from its enum answer, so no number reaches the message
//   findingsLook(api, R, ctx)   a day 1/3/7 finding: the version's release notes and app commits since the base say whether the drop is by
//                               design (like exp_expose on 1.38.3, gone with the share button) or real; Sonnet 5.5, a short Hebrew reason
//   tell(router, res)           ai:guard (summary) when a look failed, ai:key (day) for the key or the credit; a good look closes both
// No key, no SDK or an API error: no line, the guard's message goes out exactly as before.
//   node guard-explain.mjs --selftest
import { client, ask, answer } from "./claude.mjs";

export const MODEL = "claude-sonnet-5-5";
const REAL = { orGroup: { expressions: [{ filter: { fieldName: "platform", stringFilter: { value: "web" } } }, { filter: { fieldName: "countryId", stringFilter: { value: "IL" } } }] } };
const only = name => ({ andGroup: { expressions: [{ filter: { fieldName: "eventName", stringFilter: { value: name } } }, REAL] } });
// the extra GA4 reads for a breach day: car checks by hour, platform, version and duration bucket; failures by hour, platform, version and kind
export function causeQueries(day) {
  const dateRanges = [{ startDate: day, endDate: day }], dims = (...n) => n.map(name => ({ name }));
  return {
    hourDur: { dateRanges, dimensions: dims("hour", "platform", "appVersion", "customEvent:dur"), metrics: [{ name: "eventCount" }], dimensionFilter: only("car_lookup"), limit: 5000 },
    hourFail: { dateRanges, dimensions: dims("hour", "platform", "appVersion", "customEvent:kind"), metrics: [{ name: "eventCount" }], dimensionFilter: only("lookup_failed"), limit: 5000 },
  };
}
const SLOW = new Set(["5to10", "gt10"]), TECH = new Set(["source_down", "offline", "net_err", "js_err"]);
// rows -> compact tables: per hour x platform and per platform x version, {n, slow} and {fail}
export function causeTables(Q) {
  const hp = {}, pv = {}, add = (m, k, f, v) => { (m[k] ||= { n: 0, slow: 0, fail: 0 })[f] += v; };
  for (const [h, p, v, d, n] of Q.hourDur || []) { const c = +n || 0; add(hp, `${h} ${p}`, "n", c); add(pv, `${p} ${v}`, "n", c); if (SLOW.has(d)) { add(hp, `${h} ${p}`, "slow", c); add(pv, `${p} ${v}`, "slow", c); } }
  for (const [h, p, v, k, n] of Q.hourFail || []) if (TECH.has(k)) { const c = +n || 0; add(hp, `${h} ${p}`, "fail", c); add(pv, `${p} ${v}`, "fail", c); }
  return { byHourPlatform: hp, byPlatformVersion: pv };
}
const CAUSE_SYS = [
  "You read one day of car-check timings of an Israeli licence-plate app (website = platform web, app = Android/iOS by appVersion).",
  "The day breached a threshold: too many checks over 5 seconds (slow) and/or failed for a technical reason (fail).",
  "Tables: byHourPlatform \"<hour> <platform>\" and byPlatformVersion \"<platform> <version>\", each {n checks, slow, fail}.",
  "Decide the most likely cause:",
  "- \"source\": the government data source - several platforms (or every version) degrade together in the same hours;",
  "- \"version\": one app version (or one platform alone, with the others normal in the same hours) carries the excess;",
  "- \"unclear\": too few checks or no pattern.",
  "Answer with JSON only: {\"verdict\":\"source|version|unclear\",\"platforms\":[...],\"versions\":[...],\"from\":H,\"to\":H}",
  "platforms/versions: the ones that carry the excess (as written in the tables); from/to: the hour span of the excess (0-23), or null.",
].join("\n");
const HE_P = { web: "האתר", Android: "אנדרואיד", iOS: "אייפון" };
export function causeLine(text, tables) {
  let r; try { r = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return { why: "reply is not JSON" }; }
  if (!r || !["source", "version", "unclear"].includes(r.verdict)) return { why: "no verdict" };
  const known = Object.keys(tables.byPlatformVersion), plats = new Set(known.map(k => k.split(" ")[0])), vers = new Set(known.map(k => k.split(" ").slice(1).join(" ")));
  const P = (r.platforms || []).filter(p => plats.has(p)), V = (r.versions || []).filter(v => vers.has(v) && /^\d+(\.\d+){0,3}$/.test(v));
  const h = x => Number.isInteger(x) && x >= 0 && x <= 23 ? String(x).padStart(2, "0") : null, span = h(r.from) && h(r.to) ? ` (בשעות ${h(r.from)}–${h(r.to)})` : "";
  const line = r.verdict === "source" ? `סיבה משוערת (Claude): מקור הנתונים, כי ${P.length > 1 ? P.map(p => HE_P[p] || p).join(" ו") : "כל הפלטפורמות"} הואטו יחד${span}.`
    : r.verdict === "version" && (V.length || P.length) ? `סיבה משוערת (Claude): ${V.length ? "הגרסה " + V.join(", ") : ""}${V.length && P.length ? " ב" : ""}${P.map(p => HE_P[p] || p).join(" וב")}, כי העודף מרוכז שם${span}.`
    : "סיבה משוערת (Claude): לא ברור מהנתונים, צריך בדיקה.";
  return { line, verdict: r.verdict };
}
export async function zoneACause(api, Q) {
  const t = causeTables(Q);
  if (!Object.keys(t.byPlatformVersion).length) return { why: "no rows" };
  const r = await ask(api, { model: MODEL, max_tokens: 4000, system: CAUSE_SYS, messages: [{ role: "user", content: JSON.stringify(t) }] });
  if (r.error) return { why: r.error.why, key: r.error.key };
  const a = answer(r.msg); if (!a.text) return { why: a.why };
  return causeLine(a.text, t);
}

const LOOK_SYS = [
  "You give a second look to a release guard of an Israeli car-check app. It compared a new app version with the one before it, per 100 car",
  "checks, and raised findings (an event that went silent, compare or saves that dropped). For each finding decide from the release notes, the",
  "app's commit subjects since the base version and the known shifts whether the change is:",
  "- \"by_design\": the new version removed or moved what sends the event, so the drop is expected;",
  "- \"real\": users do less of it, and the product thread should look;",
  "- \"unclear\": the material doesn't say.",
  "Answer with JSON only: {\"items\":[{\"id\":\"<finding id>\",\"label\":\"by_design|real|unclear\",\"reason\":\"one short Hebrew sentence, neutral forms\"}]}",
  "Name the change behind a by_design label (e.g. the button that was removed). No numbers except version numbers.",
].join("\n");
const HE_L = { by_design: "נראה מכוון", real: "נראה אמיתי", unclear: "לא ברור" };
export function lookLines(text, R) {
  let r; try { r = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return { why: "reply is not JSON" }; }
  if (!r || !Array.isArray(r.items)) return { why: "no items" };
  const ids = new Set((R.findings || []).map(f => f.id)), lines = [];
  for (const x of r.items) if (x && ids.has(x.id) && HE_L[x.label]) lines.push({ id: x.id, label: x.label, text: `עין שנייה (Claude) על "${x.id}": ${HE_L[x.label]}${x.reason ? ". " + String(x.reason).replace(/\d{3,}/g, "#").replace(/\s+/g, " ").slice(0, 160) : ""}` });
  return lines.length ? { lines } : { why: "no known finding in the reply" };
}
// ctx: { notes: [{version, text}], commits: [subject], context: review-context.md, names: {event: Hebrew name} }
export async function findingsLook(api, R, ctx) {
  const input = { version: R.vn, base: R.prev, day: R.day, findings: (R.findings || []).map(f => ({ id: f.id, events: f.events, text: f.he })),
    releaseNotes: ctx.notes || [], commitSubjects: (ctx.commits || []).slice(0, 150), eventNames: ctx.names || {} };
  const r = await ask(api, { model: MODEL, max_tokens: 4000, system: LOOK_SYS + "\n\nKnown shifts:\n" + String(ctx.context || "").trim(), messages: [{ role: "user", content: JSON.stringify(input) }] });
  if (r.error) return { why: r.error.why, key: r.error.key };
  const a = answer(r.msg); if (!a.text) return { why: a.why };
  return lookLines(a.text, R);
}

// release notes and app commits since the base version, from the checkout's history (fetch-depth 0); empty when git is not there
export async function history(base, vn, run) {
  const out = { notes: [], commits: [] };
  try {
    const log = (await run("git", ["log", "--format=%H %as", "--", "android/release-notes.txt"])).trim().split("\n").filter(Boolean);
    const seen = new Set(); let since = null;
    for (const l of log) {
      const [h, d] = l.split(" "), txt = await run("git", ["show", `${h}:android/release-notes.txt`]), v = (txt.match(/^# (\d+(?:\.\d+){1,3})/) || [])[1];
      if (!v || seen.has(v)) continue; seen.add(v);
      if (v === base) { since = d; break; }
      if (!vn || cmpV(v, vn) <= 0) out.notes.push({ version: v, text: txt.split("\n").filter(x => !x.startsWith("#")).join("\n").trim() });
    }
    if (since) out.commits = (await run("git", ["log", `--since=${since}`, "--format=%s", "--", "index.html", "sw.js", "android"])).trim().split("\n").filter(Boolean);
  } catch { /* no history: the look reads the finding and the known shifts only */ }
  return out;
}
const cmpV = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 4; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };

export async function getClient(env = process.env) { return (await client(env, { timeout: 180000 })).api; }

export async function tell(router, res, env = process.env) {
  if (!router || !res) return "none";
  try {
    if (!res.why) { await router.resolve(["ai:guard"]); await router.resolve(["ai:key"]); return "closed"; }
    if (/ANTHROPIC_API_KEY|SDK is not installed|no rows/.test(res.why)) return "skipped";
    const key = !!res.key, t = `העין השנייה של Claude על שומר הגרסאות לא רצה (${String(res.why).replace(/\d[\d,.\-]{3,}\d/g, "#").slice(0, 120)}). ההודעה של השומר יצאה בלעדיה.`;
    await router.alert(key ? "day" : "summary", key ? "ai:key" : "ai:guard", t, env.RUN_URL || "", { today: key ? "loud" : "silent", legacy: () => false });
    return key ? "ai:key" : "ai:guard";
  } catch { return "router failed"; }
}

if (process.argv[1] && process.argv[1].endsWith("guard-explain.mjs") && process.argv.includes("--selftest")) {
  let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  const Q = { hourDur: [["09", "web", "(not set)", "gt10", "5"], ["09", "web", "(not set)", "lt2", "5"], ["09", "Android", "1.38.3", "5to10", "6"], ["09", "Android", "1.38.3", "2to5", "2"], ["14", "Android", "1.38.3", "lt2", "10"]],
    hourFail: [["09", "Android", "1.38.3", "offline", "2"], ["09", "Android", "1.38.3", "not_found", "9"]] };
  const t = causeTables(Q);
  ok(t.byHourPlatform["09 web"].slow === 5 && t.byHourPlatform["09 Android"].n === 8 && t.byHourPlatform["09 Android"].fail === 2 && t.byPlatformVersion["Android 1.38.3"].n === 18, "tables: slow and technical failures by hour and version (typos are not failures)");
  ok(causeQueries("2026-10-31").hourDur.dateRanges[0].startDate === "2026-10-31" && causeQueries("2026-10-31").hourFail.dimensionFilter.andGroup.expressions.length === 2, "the two GA4 reads");
  let c = causeLine('{"verdict":"source","platforms":["web","Android"],"versions":[],"from":9,"to":11}', t);
  ok(c.line === "סיבה משוערת (Claude): מקור הנתונים, כי האתר ואנדרואיד הואטו יחד (בשעות 09–11).", "source: the line from the enum answer " + c.line);
  c = causeLine('{"verdict":"version","platforms":["Android"],"versions":["1.38.3","9.9"],"from":null,"to":null}', t);
  ok(c.line === "סיבה משוערת (Claude): הגרסה 1.38.3 באנדרואיד, כי העודף מרוכז שם.", "version: only versions in the data " + c.line);
  ok(causeLine('{"verdict":"version","platforms":["x"],"versions":["7"]}', t).line.includes("לא ברור") && causeLine("nope", t).why === "reply is not JSON", "nothing known: unclear; no JSON: no line");
  const R = { vn: "1.38.3", prev: "1.37", day: 3, findings: [{ id: "silent", events: ["exp_expose"], he: "x" }] };
  let L = lookLines('{"items":[{"id":"silent","label":"by_design","reason":"כפתור השיתוף הוסר ב-1.38, 12345 פעמים"},{"id":"nope","label":"real"}]}', R);
  ok(L.lines.length === 1 && L.lines[0].text === 'עין שנייה (Claude) על "silent": נראה מכוון. כפתור השיתוף הוסר ב-1.38, # פעמים', "a finding's label, unknown ids dropped, long numbers masked " + L.lines[0].text);
  ok(lookLines('{"items":[]}', R).why && lookLines("x", R).why === "reply is not JSON", "no usable label: no line");
  const reply = t => ({ messages: { create: async q => { reply.last = q; return { stop_reason: "end_turn", content: [{ type: "text", text: t }] }; } } });
  c = await zoneACause(reply('{"verdict":"source","platforms":["web","Android"],"from":9,"to":9}'), Q);
  ok(c.verdict === "source" && reply.last.model === MODEL && !/"hour"/.test(reply.last.messages[0].content) && /byHourPlatform/.test(reply.last.messages[0].content), "zone A: one call with the tables");
  ok((await zoneACause(reply("{}"), {})).why === "no rows", "no rows: no call");
  L = await findingsLook(reply('{"items":[{"id":"silent","label":"by_design","reason":"r"}]}'), R, { notes: [{ version: "1.38", text: "• שיתוף בכותרת" }], commits: ["a"], context: "- ctx", names: {} });
  ok(L.lines && /Known shifts:\n- ctx/.test(reply.last.system) && JSON.parse(reply.last.messages[0].content).releaseNotes.length === 1, "findings: notes, commits and shifts go in");
  const boom = st => ({ messages: { create: async () => { const e = new Error("x"); e.status = st; throw e; } } });
  c = await zoneACause(boom(401), Q); ok(c.why === "401 key" && c.key, "the key refused: no line, ai:key");
  const notes = { "a": "# 1.38.3\n• x", "b": "# 1.38.2\n• y", "c": "# 1.38.2\n• y0", "d": "# 1.37\n• z", "e": "# 1.36\n• w" };
  const run = async (cmd, args) => args[0] === "log" && args.includes("android/release-notes.txt") ? "a 2026-10-27\nb 2026-10-26\nc 2026-10-25\nd 2026-10-20\ne 2026-10-10\n"
    : args[0] === "show" ? notes[args[1].split(":")[0]] : args[0] === "log" ? (args[1] === "--since=2026-10-20" ? "s1\ns2\n" : "") : "";
  const H = await history("1.37", "1.38.3", run);
  ok(H.notes.map(n => n.version).join() === "1.38.3,1.38.2" && H.notes[1].text === "• y" && H.commits.join() === "s1,s2", "history: notes of the versions after the base, commits since it");
  ok((await history("1.37", "1.38.3", async () => { throw new Error("no git"); })).notes.length === 0, "no git: empty history, no throw");
  const calls = [], router = { alert: async (lv, k) => { calls.push(lv + " " + k); }, resolve: async p => { calls.push("resolve " + p[0]); } };
  ok(await tell(router, { line: "x" }) === "closed" && calls.join() === "resolve ai:guard,resolve ai:key", "a good look closes ai:guard and ai:key");
  calls.length = 0; ok(await tell(router, { why: "529 server" }) === "ai:guard" && calls.join() === "summary ai:guard", "a failed look: ai:guard, summary");
  calls.length = 0; ok(await tell(router, { why: "401 key", key: true }) === "ai:key" && await tell(router, { why: "no ANTHROPIC_API_KEY" }) === "skipped" && calls.join() === "day ai:key", "the key: ai:key; no key on purpose: nothing");
  console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
}
