// The CEO thread's second reader of the weekly KPI file (measurement thread; Dudu approved 1.11.2026 21:16 UTC, API credit package A7).
// probe-perf branch only. Right after kpi-probe.mjs builds the week's KPI JSON (the runner's temp folder, never a branch or the log), Opus 5.5
// at effort medium reads it beside the known non-behaviour shifts (analytics/review-context.md on main) and returns at most five blind
// spots or numbers that do not add up. It never writes a number itself: like the decision brief (decision-brief.mjs, whose fill() this
// reuses), every value is a {placeholder} filled by code from a path in the KPI JSON, so each number in the read matches the file by
// construction; a line with a number of the model's own, or a value that cannot be found, is dropped and listed. The read is encrypted
// with .github/seo-data.pub.pem (out/ceo-read.enc.json, next to kpi.enc.json); out/ceo-read.status.json holds no number (ok, why, counts)
// and the publish job hands it to the router: ai:ceo-read (summary) when the read fails, ai:key (day) when the key or the credit is the cause,
// both closed when it answers; nothing when there is no key. The log says only ok/failed and counts.
//   node ceo-read.mjs <raw.json> <context.md> <out-dir>   env ANTHROPIC_API_KEY; CEO_PLAIN=<file> (local test only: clear text)
//   node ceo-read.mjs --route <status.json>               the router call (publish job)
//   node ceo-read.mjs --selftest                          offline, through a fake API
import fs from "node:fs";
import { client, ask, answer } from "./claude.mjs";
// decision-brief.mjs runs its own selftest whenever "--selftest" is on the command line, so it is loaded with that flag hidden
const argv = process.argv; process.argv = argv.filter(a => a !== "--selftest");
const { fill, encrypt } = await import("./decision-brief.mjs");
process.argv = argv;

export const MODEL = "claude-opus-5-5";
export const EFFORT = "medium";
export const MAX_ITEMS = 5;
const mask = s => String(s || "").replace(/\d[\d,.\-]*/g, "#").slice(0, 160);

export function prompt(kpi, context) {
  return [
    "You are the second reader of the weekly KPI file of the לוחית app (an Israeli car-check app: a website and an Android app). The CEO thread reads this file every Sunday to judge the week against its plan. Your job is to catch what that reader could miss: at most five items, each either a BLIND SPOT (something the numbers cannot show, or a status that looks fine only because a field is missing, estimated or measured on too small a sample) or a pair of NUMBERS THAT DO NOT ADD UP (parts that do not sum to the whole, a rate that does not match its counts, a status that contradicts its own target, two sources that tell different stories, a week compared with a week of a different kind).",
    "Skip what the known shifts below already explain. Skip routine week-over-week movement. Fewer items are better than weak ones; an empty list is a good answer when nothing is wrong.",
    "Write plain English. YOU MUST NOT WRITE ANY DIGIT and never spell a number in words (no \"twice\", \"half\", \"percent\", \"seven\" except in \"seven-day\"). Every number goes in a {placeholder} defined in \"vals\" as one of:",
    '- {"path": "kpis.installs.week"}: one number or short string in the KPI JSON, the path starting at its top level (never "$." or "DATA.")',
    '- {"ratio": ["a","b"]}, {"pct": ["a","b"]} (100*a/b, prints its % sign), {"diff": ["a","b"]}, {"sum": ["a","b","c"]}: computed from placeholders defined EARLIER in the same item',
    'Answer with JSON only: {"items":[{"kind":"blind_spot|mismatch","title":"a few words, no number","text":"one or two sentences: what, where in the file, why it matters, what to check","vals":{...}}]}',
    "", "KNOWN SHIFTS (not behaviour):", String(context || "").slice(0, 6000), "", "KPI JSON:", JSON.stringify(kpi).slice(0, 200000),
  ].join("\n");
}

// a field of the file named in the text (return_7d, organic_q1) is not a number of the model's own: it goes through fill() as a value of its own
const FIELD = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, NAMES = "__field_names";
let names = [];
function fields(it) {
  const vals = { ...((it && it.vals && typeof it.vals === "object") ? it.vals : {}) };
  const text = String((it && it.text) || "").replace(FIELD, f => { if (!/\d/.test(f)) return f; names.push(f); const k = "zzfield" + (names.length - 1); vals[k] = { path: `${NAMES}[${names.length - 1}]` }; return `{${k}}`; });
  return { text, vals };
}

export async function read({ kpi, context, api, env = process.env, now = new Date() }) {
  const r0 = { v: 1, generated: now.toISOString(), model: MODEL, effort: EFFORT, ok: false, why: "", key: false, items: [], dropped: [] };
  if (!kpi || typeof kpi !== "object" || kpi.error) { r0.why = "no KPI data"; return r0; }
  if (api === undefined) { const c = await client(env, { timeout: 9 * 60000 }); api = c.api; if (!api) { r0.why = c.why; return r0; } }
  const r = await ask(api, { model: MODEL, max_tokens: 16000, thinking: { type: "adaptive" }, output_config: { effort: EFFORT }, messages: [{ role: "user", content: prompt(kpi, context) }] });
  if (r.error) { r0.why = r.error.why; r0.key = !!r.error.key; return r0; }
  const a = answer(r.msg); if (!a.text) { r0.why = a.why; return r0; }
  let o; try { const t = a.text, i = t.indexOf("{"), j = t.lastIndexOf("}"); o = JSON.parse(t.slice(i, j + 1)); } catch { r0.why = "no valid JSON"; return r0; }
  if (!o || !Array.isArray(o.items)) { r0.why = "no items"; return r0; }
  names = [];
  for (const it of o.items.slice(0, 12)) {
    const kind = it && it.kind === "mismatch" ? "mismatch" : "blind_spot", title = String((it && it.title) || "").slice(0, 80);
    const f = /\d/.test(title.replace(FIELD, "")) ? { why: "a number of the model's own" } : fill({ ...kpi, [NAMES]: names }, fields(it));
    if (f.text && r0.items.length < MAX_ITEMS) r0.items.push({ kind, title, text: f.text, sources: f.sources });
    else if (!f.text) r0.dropped.push({ kind, title: title.replace(/\d/g, "#"), text: String((it && it.text) || "").slice(0, 300), why: f.why, vals: JSON.stringify((it && it.vals) || {}).slice(0, 600) });
  }
  r0.ok = r0.dropped.length <= r0.items.length;   // more dropped than kept: the CEO thread reads the file on its own, as before
  if (!r0.ok) r0.why = "more items dropped than kept";
  return r0;
}

export const status = r => ({ v: 1, ok: !!r.ok, why: mask(r.why), key: !!r.key, items: r.items ? r.items.length : 0, dropped: r.dropped ? r.dropped.length : 0 });

export async function route(st, router, env = process.env) {
  if (!router) return "no router";
  try {
    if (st.ok) { await router.resolve(["ai:ceo-read"]); await router.resolve(["ai:key"]); return "closed"; }
    if (/ANTHROPIC_API_KEY|no KPI data/.test(st.why || "")) return "skipped";   // switched off on purpose, or the KPI file itself failed
    const key = !!st.key, text = `הקריאה השנייה של קובץ המדדים השבועי לא רצה (${mask(st.why).slice(0, 120)}). שרשור המנכ"ל קורא את הקובץ לבד, כמו קודם.`;
    await router.alert(key ? "day" : "summary", key ? "ai:key" : "ai:ceo-read", text, env.RUN_URL || "", { today: key ? "loud" : "silent", legacy: () => false });
    return key ? "ai:key" : "ai:ceo-read";
  } catch { return "router failed"; }
}

const main = process.argv[1] && process.argv[1].endsWith("ceo-read.mjs");
if (main && process.argv[2] === "--route") {
  let st = null; try { st = JSON.parse(fs.readFileSync(process.argv[3], "utf8")); } catch {}
  console.log("router: " + (st ? await route(st, await import("./alert.mjs").catch(() => null)) : "no status"));
} else if (main && !process.argv.includes("--selftest")) {
  const [rawF, ctxF, outDir = "out"] = process.argv.slice(2);
  let raw = null; try { raw = JSON.parse(fs.readFileSync(rawF, "utf8")); } catch {}
  const context = ctxF && fs.existsSync(ctxF) ? fs.readFileSync(ctxF, "utf8") : "";
  const r = await read({ kpi: raw && raw.kpi, context });
  if (process.env.CEO_PLAIN) fs.writeFileSync(process.env.CEO_PLAIN, JSON.stringify(r, null, 1));
  encrypt(Buffer.from(JSON.stringify(r, null, 1)), outDir + "/ceo-read.enc.json");
  fs.writeFileSync(outDir + "/ceo-read.status.json", JSON.stringify(status(r)));
  console.log(r.ok ? `ceo read ok: ${r.items.length} item(s), ${r.dropped.length} dropped` : `ceo read failed: ${mask(r.why)}`);
}

if (process.argv.includes("--selftest")) {
  let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  const kpi = { week: { from: "2026-10-25", to: "2026-10-31" }, kpis: { weekly_checks: { week: 900, app: 500, web: 300, status: "on track" }, installs: { week: 40, play: { users: 55 } } } };
  const fake = text => ({ messages: { create: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text }] }) } });
  const good = { kind: "mismatch", title: "App and web miss checks", text: "App {a} and web {w} add up to {s}, not the {t} total.", vals: { a: { path: "kpis.weekly_checks.app" }, w: { path: "kpis.weekly_checks.web" }, s: { sum: ["a", "w"] }, t: { path: "kpis.weekly_checks.week" } } };
  let r = await read({ kpi, context: "", api: fake(JSON.stringify({ items: [good, { kind: "blind_spot", title: "Made up", text: "Installs were 77", vals: {} }] })) });
  ok(r.ok && r.items.length === 1 && r.items[0].text === "App 500 and web 300 add up to 800, not the 900 total." && r.dropped.length === 1 && r.dropped[0].why === "a number of the model's own", "numbers filled by code; a number of the model's own drops the item: " + (r.items[0] || {}).text);
  r = await read({ kpi, context: "", api: fake(JSON.stringify({ items: [{ kind: "blind_spot", title: "return_7d is thin", text: "return_7d and organic_q1 rest on {i} installs.", vals: { i: { path: "kpis.installs.week" } } }] })) });
  ok(r.ok && r.items[0].text === "return_7d and organic_q1 rest on 40 installs." && !r.items[0].sources.zzfield0 === false, "a field name with a digit is not a number of the model's own: " + (r.items[0] || {}).text);
  r = await read({ kpi, context: "", api: fake(JSON.stringify({ items: [{ ...good, title: "Week 44 gap" }] })) }); ok(!r.ok && r.dropped.length === 1, "a digit in the title drops it too");
  r = await read({ kpi, context: "", api: fake(JSON.stringify({ items: Array.from({ length: 8 }, () => good) })) }); ok(r.ok && r.items.length === MAX_ITEMS, "at most five items");
  r = await read({ kpi, context: "", api: fake('{"items":[]}') }); ok(r.ok && !r.items.length, "nothing wrong is a good answer");
  r = await read({ kpi, context: "", api: fake("sorry") }); ok(!r.ok && r.why === "no valid JSON", "no JSON: fallback");
  r = await read({ kpi, context: "", api: { messages: { create: async () => { const e = new Error("x"); e.status = 401; throw e; } } } }); ok(!r.ok && r.key && r.why === "401 key", "a refused key: key=true");
  r = await read({ kpi, context: "", env: {} }); ok(!r.ok && /ANTHROPIC_API_KEY/.test(r.why), "no key: fallback");
  r = await read({ kpi: { error: "x" }, context: "", api: fake("{}") }); ok(!r.ok && r.why === "no KPI data", "the KPI file failed: nothing asked");
  { const sent = []; await read({ kpi, context: "launch wave 18.10", api: { messages: { create: async p => { sent.push(p); return { stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] }; } } } });
    ok(sent[0].model === "claude-opus-5-5" && sent[0].thinking.type === "adaptive" && sent[0].output_config.effort === "medium" && /MUST NOT WRITE ANY DIGIT/.test(sent[0].messages[0].content) && /launch wave/.test(sent[0].messages[0].content), "Opus 5.5, adaptive thinking, effort medium, the no-digit rule and the known shifts in the prompt"); }
  const s = status({ ok: false, why: "400 max_tokens 16000 too large", key: false, items: [], dropped: [] }); ok(!/\d{2}/.test(JSON.stringify({ ...s, v: 0, items: 0, dropped: 0 })), "the status file holds no number: " + s.why);
  const calls = [], router = { alert: async (lv, k) => { calls.push(lv + " " + k); }, resolve: async p => { calls.push("resolve " + p[0]); } };
  ok(await route({ ok: true }, router) === "closed" && calls.join() === "resolve ai:ceo-read,resolve ai:key", "a good read closes ai:ceo-read and ai:key");
  calls.length = 0; ok(await route({ ok: false, why: "529 server" }, router) === "ai:ceo-read" && calls.join() === "summary ai:ceo-read", "a failed read: ai:ceo-read, summary");
  calls.length = 0; ok(await route({ ok: false, why: "401 key", key: true }, router) === "ai:key" && calls.join() === "day ai:key", "the key or the credit: ai:key, day");
  calls.length = 0; ok(await route({ ok: false, why: "no ANTHROPIC_API_KEY" }, router) === "skipped" && !calls.length, "no key on purpose: nothing sent");
  console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
}
