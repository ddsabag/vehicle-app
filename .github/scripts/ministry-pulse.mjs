// Ministry pulse (data thread, 7.11.2026; freeze split accepted by Dudu 7.11 15:49 UTC: monitoring that changes nothing users see).
// Every 30 minutes: the three lookups a car check makes first (active register, test history, ownership) for the sample plate, with the
// app's own 15 s limit. Ministry watch looks once a day, so an outage in the afternoon or evening (31.10 18-21 UTC, 1.11 09-15 UTC) was seen
// only the next day, in the analytics. Here two failed rounds 90 s apart open one item through the alert router (key ministry:pulse, level day:
// quiet at night, the morning ring); the first good round closes it ("✅ חזר לתקין"). It never writes status.json or anything the app reads.
// The log prints states and times only. node ministry-pulse.mjs | node ministry-pulse.mjs selftest (offline)
import { SETS, SAMPLE_PLATE } from "./datasets.mjs";
import { msg } from "./tg-text.mjs";
const API = "https://data.gov.il/api/3/action/datastore_search";
export const KEYS = ["active", "tech", "owners"], LIMIT_MS = 15000, SLOW_MS = 5000, GAP_MS = 90000, KEY = "ministry:pulse";
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function lookup(set, get = fetch, now = () => Date.now()) {
  const t0 = now(), q = new URLSearchParams({ resource_id: set.id, limit: "1", filters: JSON.stringify(set.filters || {}) });
  try {
    const r = await get(`${API}?${q}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(LIMIT_MS) });
    const ms = now() - t0;
    if (!r.ok) return { key: set.key, ok: false, ms, why: `HTTP ${r.status}` };
    const j = await r.json();
    const rows = j?.result?.records?.length || 0;
    return rows ? { key: set.key, ok: true, ms } : { key: set.key, ok: false, ms, why: "no row for the sample car" };
  } catch (e) { return { key: set.key, ok: false, ms: now() - t0, why: /abort|timeout/i.test(String(e && (e.name + e.message))) ? "no answer in 15 s" : "network error" }; }
}
export async function round(get, now) { return Promise.all(SETS.filter(s => KEYS.includes(s.key)).map(s => lookup(s, get, now))); }
// a round is bad when the active register fails (the app then shows nothing) or both others fail
export const bad = rs => rs.some(r => r.key === "active" && !r.ok) || rs.filter(r => r.key !== "active" && !r.ok).length >= 2;
export const line = rs => rs.map(r => `${r.key} ${r.ok ? "ok" : "fail"} ${Math.round(r.ms / 100) / 10}s${r.ok ? "" : " (" + r.why + ")"}`).join(", ");

export function text(rs) {
  const title = { active: "רכב פרטי ומסחרי", tech: "היסטוריית טסטים", owners: "היסטוריית בעלויות" };
  const down = rs.filter(r => !r.ok).map(r => title[r.key]).join(", ");
  return msg({ kind: "today", area: "data", title: "משרד התחבורה לא עונה כרגע",
    text: `שני סבבים בהפרש של דקה וחצי נכשלו (${down}). בזמן הזה בדיקות רכב באפליקציה ובאתר נכשלות, ומשתמשים רואים הודעה שהמשרד לא עונה. זו תקלה אצל המשרד, ובדרך כלל היא עוברת לבד.`,
    what: "כלום. כשהמשרד יחזור לענות תגיע הודעה שזה חזר לתקין.", raw: line(rs) });
}

export async function main({ get = fetch, now = () => Date.now(), wait = sleep, router, log = console.log } = {}) {
  router ??= await import("./alert.mjs").catch(() => null);
  let rs = await round(get, now); log("pulse 1: " + line(rs));
  if (bad(rs)) { await wait(GAP_MS); rs = await round(get, now); log("pulse 2: " + line(rs)); }
  const slow = rs.filter(r => r.ok && r.ms > SLOW_MS).length;
  if (!bad(rs)) { if (router) { const n = await router.resolve([KEY]).catch(() => 0); if (n) log("ministry answers again: item closed"); } log(`pulse: ok${slow ? ", slow " + slow : ""}`); return "ok"; }
  if (!router) { log("pulse: down, no router"); return "down"; }
  const res = await router.alert("day", KEY, text(rs), process.env.RUN_URL || "").catch(e => ({ error: String(e) }));
  log("pulse: down, alert " + (res && res.delivered ? "sent" : "kept (" + (res && (res.why || res.error || res.decision) || "router") + ")"));
  return "down";
}

if (process.argv[1] && process.argv[1].endsWith("ministry-pulse.mjs")) {
  if (process.argv[2] === "selftest") {
    let fails = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
    const resp = (rows, status = 200) => async () => ({ ok: status === 200, status, json: async () => ({ result: { records: Array(rows).fill({}) } }) });
    ok((await lookup(SETS[0], resp(1))).ok, "a row = ok");
    ok((await lookup(SETS[0], resp(0))).why === "no row for the sample car", "no row = fail");
    ok((await lookup(SETS[0], resp(0, 503))).why === "HTTP 503", "HTTP error = fail");
    ok((await lookup(SETS[0], async () => { const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; })).why === "no answer in 15 s", "timeout");
    ok(bad([{ key: "active", ok: false }, { key: "tech", ok: true }, { key: "owners", ok: true }]) && !bad([{ key: "active", ok: true }, { key: "tech", ok: false }, { key: "owners", ok: true }]), "bad: the active register, or both others");
    const calls = []; const R = { alert: async (...a) => { calls.push(["alert", ...a]); return { delivered: true }; }, resolve: async k => { calls.push(["resolve", k]); return 1; } };
    let n = 0; const flaky = async u => (n++ < 3 ? resp(0)() : resp(1)());
    ok(await main({ get: flaky, wait: async () => {}, router: R, log: () => {} }) === "ok" && calls[0][0] === "resolve", "one bad round then good: no alert, the item closes");
    calls.length = 0;
    ok(await main({ get: resp(0, 500), wait: async () => {}, router: R, log: () => {} }) === "down" && calls[0][0] === "alert" && calls[0][2] === KEY && calls[0][1] === "day", "two bad rounds: one day item ministry:pulse");
    ok(!/\d{7,8}/.test(text([{ key: "active", ok: false, ms: 15000, why: "x" }])) && !text([{ key: "active", ok: false, ms: 1, why: "x" }]).includes(SAMPLE_PLATE), "the message has no plate");
    console.log(fails ? `${fails} failed` : "selftest ok"); process.exit(fails ? 1 : 0);
  } else await main();
}
