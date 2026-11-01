// Decision brief (strategy thread; Dudu approved 1.11.2026 21:16 UTC, package A4 of the monthly API credit). probe-perf branch only.
// A probe that pulls numbers for a heavy decision task (8.11 gate re-base, 21.11 saver talk, 6.12 Q2 fallback, 31.3 gate) also writes its raw
// JSON to the runner's temp folder (never a branch, never the log). This script hands Opus 5.5 that raw JSON and the task's questions and
// gets back a short brief whose numbers the MODEL NEVER WRITES: each line is text with {placeholders}, and each placeholder names where its
// value comes from in the raw JSON (a path, or a sum over a GA4 table's rows) or how it is computed from other placeholders (ratio, pct,
// diff, sum). This code fills every value from the raw data. A line whose text holds a digit of its own, or whose value cannot be found or
// computed, is dropped and listed, so the thread reads the raw for it. So every number in the brief matches a raw field by construction.
// The brief is encrypted with .github/seo-data.pub.pem (out/brief.enc.json) like every probe output. Fallback: no key, no SDK, an API error
// or nothing valid = brief.ok false and why; the thread works from the raw as before. The log says only ok/failed and line counts.
//   node decision-brief.mjs <raw.json> <questions.md> <out.enc.json>   env ANTHROPIC_API_KEY; BRIEF_PLAIN=<file> (local test only: clear text)
//   node decision-brief.mjs --selftest                                 offline, through a fake API
import crypto from "node:crypto";
import fs from "node:fs";
import { client, ask, answer } from "./claude.mjs";

export const MODEL = "claude-opus-5-5";
const OPS = ["ratio", "pct", "diff", "sum"];

// ---- reading the raw JSON ----
export function at(obj, path) {   // parts["ga.life"].rows[3][2]  or  a.b.c  (a leading "$." or "DATA." is ignored; ['x'] works too)
  path = String(path).trim().replace(/^\$\.?|^DATA\.?/i, "");
  const toks = []; const re = /\["([^"]+)"\]|\['([^']+)'\]|\[(\d+)\]|\.?([A-Za-z_$][\w$-]*)/gy; let m, i = 0;
  re.lastIndex = 0;
  while (i < path.length) { re.lastIndex = i; m = re.exec(path); if (!m || m.index !== i) return undefined; toks.push(m[1] ?? m[2] ?? (m[3] !== undefined ? +m[3] : m[4])); i = re.lastIndex; }
  return toks.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
// a GA4 table in the probes' flat form {dims, mets, rows}: the sum of one metric over the rows whose dimensions equal `where`
export function select(raw, s) {
  const t = at(raw, s.table); if (!t || !Array.isArray(t.rows) || !Array.isArray(t.dims) || !Array.isArray(t.mets)) return undefined;
  const mi = t.mets.indexOf(s.metric); if (mi < 0) return undefined;
  const conds = Object.entries(s.where || {}).map(([d, v]) => [t.dims.indexOf(d), Array.isArray(v) ? v.map(String) : [String(v)]]);
  if (conds.some(([di]) => di < 0)) return undefined;
  let n = 0, hit = 0;
  for (const r of t.rows) if (conds.every(([di, vs]) => vs.includes(String(r[di])))) { n += Number(r[t.dims.length + mi]) || 0; hit++; }
  return hit ? n : (s.zeroOk ? 0 : undefined);
}
const num = v => typeof v === "number" && Number.isFinite(v);
function value(raw, spec, vals, depth = 0) {
  if (!spec || typeof spec !== "object" || depth > 6) return undefined;
  if (typeof spec.path === "string") { const v = at(raw, spec.path); return num(v) || (typeof v === "string" && v.length <= 40) ? v : undefined; }
  if (typeof spec.table === "string") return select(raw, spec);
  const op = OPS.find(o => Array.isArray(spec[o])); if (!op) return undefined;
  const xs = spec[op].map(k => (typeof k === "string" ? vals[k] : value(raw, k, vals, depth + 1)));
  if (!xs.length || !xs.every(num)) return undefined;
  if (op === "sum") return xs.reduce((a, b) => a + b, 0);
  if (op === "diff") return xs.length === 2 ? xs[0] - xs[1] : undefined;
  if (xs.length !== 2 || xs[1] === 0) return undefined;
  return op === "ratio" ? xs[0] / xs[1] : (100 * xs[0]) / xs[1];
}
const fmt = (v, kind) => (typeof v === "string" ? v : kind === "pct" ? (Math.round(v * 10) / 10).toLocaleString("en-US") + "%" : kind === "ratio" ? (Math.round(v * 100) / 100).toLocaleString("en-US")
  : (Math.round(v * 10) / 10).toLocaleString("en-US"));
// one line: every placeholder filled from the raw data, no digit of the model's own (Q1 to Q3, the questions' names, are allowed)
export function fill(raw, line) {
  if (!line || typeof line.text !== "string" || !line.text.trim()) return { why: "no text" };
  const text = line.text.slice(0, 400), specs = line.vals && typeof line.vals === "object" ? line.vals : {};
  if (/\d/.test(text.replace(/\{[A-Za-z_]\w*\}/g, "").replace(/\bQ[1-3]\b/g, ""))) return { why: "a number of the model's own" };
  const vals = {}, kinds = {};
  for (const [k, s] of Object.entries(specs)) { vals[k] = value(raw, s, vals); kinds[k] = OPS.find(o => s && Array.isArray(s[o])) || "value"; }   // in order: a computed value may use earlier ones
  const names = [...text.matchAll(/\{([A-Za-z_]\w*)\}/g)].map(m => m[1]);
  const bad = names.filter(n => vals[n] === undefined);
  if (bad.length) return { why: "no value for " + bad.join(", ") };
  return { text: text.replace(/\{([A-Za-z_]\w*)\}/g, (_, n) => fmt(vals[n], kinds[n])), section: String(line.section || "").slice(0, 60),
    sources: Object.fromEntries(names.map(n => [n, specs[n]])) };
}

// ---- what the model sees: each table's shape, its dimension values and a sample of rows (the sums run over every row here, in code) ----
export function digest(raw, maxRows = 60) {
  const walk = (o, depth) => {
    if (o && typeof o === "object" && Array.isArray(o.rows) && Array.isArray(o.dims)) {
      const values = Object.fromEntries(o.dims.map((d, i) => [d, [...new Set(o.rows.map(r => String(r[i])))].slice(0, 40)]));
      return { dims: o.dims, mets: o.mets, rowCount: o.rows.length, dimValues: values, sampleRows: o.rows.slice(0, maxRows) };
    }
    if (Array.isArray(o)) return o.length > maxRows ? [...o.slice(0, maxRows), `... ${o.length - maxRows} more`] : o.map(x => walk(x, depth + 1));
    if (o && typeof o === "object" && depth < 8) return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v, depth + 1)]));
    return o;
  };
  return walk(raw, 0);
}
export function prompt(questions, raw) {
  return [
    "You prepare a short decision brief from analytics data for the strategy thread of the לוחית app (Israeli car-check app). The data is below as JSON: each GA4 table shows its dimensions (dims), metrics (mets), row count, the values each dimension takes, and only a SAMPLE of its rows; sums over a table are computed by code over ALL its rows.",
    "Answer the questions with lines of plain English text. YOU MUST NOT WRITE ANY DIGIT in the text. Every number goes in a {placeholder} whose value you define in \"vals\", from one of:",
    '- {"path": "a.b.c"} or {"path": "parts[\\"ga.life\\"].x[0]"}: one number or short string in the JSON (a date, a version). Paths start at the top level of DATA: if DATA is {"kpi":{"week":...}}, the path is "kpi.week", never "DATA.kpi.week" or "$.kpi.week"',
    '- {"table": "parts[\\"ga.life\\"]", "metric": "eventCount", "where": {"eventName": "first_open", "date": ["20261101","20261102"]}, "zeroOk": false}: the sum of that metric over every row whose dimensions equal the given values (a list = any of them; zeroOk true only when no matching row truly means zero)',
    '- {"ratio": ["a","b"]}, {"pct": ["a","b"]} (100*a/b), {"diff": ["a","b"]}, {"sum": ["a","b","c"]}: computed from placeholders defined EARLIER in the same line',
    "Q1, Q2 and Q3 may appear as names. Say plainly when the data cannot answer something (put it in \"missing\"), give the sample size next to every rate, and never invent a field. Each line must stand on its own.",
    'Answer with JSON only: {"lines":[{"section":"short heading","text":"Savers returned within seven days: {r} of {s} ({p})","vals":{"r":{...},"s":{...},"p":{"pct":["r","s"]}}}],"missing":["what the data lacks"]}',
    "", "QUESTIONS:", String(questions).slice(0, 8000), "", "DATA:", JSON.stringify(digest(raw)).slice(0, 400000),
  ].join("\n");
}

export function encrypt(data, file, pub = ".github/seo-data.pub.pem") {
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(data), c.final()]);
  const ek = crypto.publicEncrypt({ key: fs.readFileSync(pub, "utf8"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  fs.mkdirSync(file.replace(/[^/]*$/, "") || ".", { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
}

export async function brief({ raw, questions, api, env = process.env, now = new Date() }) {
  const b = { v: 1, generated: now.toISOString(), model: MODEL, ok: false, why: "", lines: [], dropped: [], missing: [] };
  if (api === undefined) { const c = await client(env, { timeout: 9 * 60000 }); api = c.api; if (!api) { b.why = c.why; return b; } }
  const r = await ask(api, { model: MODEL, max_tokens: 16000, thinking: { type: "adaptive" }, messages: [{ role: "user", content: prompt(questions, raw) }] });
  if (r.error) { b.why = r.error.why; return b; }
  const a = answer(r.msg); if (!a.text) { b.why = a.why; return b; }
  let o; try { const t = a.text, i = t.indexOf("{"), j = t.lastIndexOf("}"); o = JSON.parse(t.slice(i, j + 1)); } catch { b.why = "no valid JSON"; return b; }
  if (!o || !Array.isArray(o.lines)) { b.why = "no lines"; return b; }
  for (const l of o.lines.slice(0, 80)) { const f = fill(raw, l); if (f.text) b.lines.push(f); else b.dropped.push({ section: String((l && l.section) || "").slice(0, 60), text: String((l && l.text) || "").slice(0, 200), why: f.why, vals: JSON.stringify((l && l.vals) || {}).slice(0, 600) }); }
  b.missing = (Array.isArray(o.missing) ? o.missing : []).map(x => String(x).replace(/\d/g, "#").slice(0, 200)).slice(0, 20);   // a model's number can hide here too
  b.ok = b.lines.length > 0 && b.dropped.length <= b.lines.length;   // more dropped than kept: read the raw
  if (!b.ok) b.why = b.lines.length ? "more lines dropped than kept" : "no line passed";
  return b;
}

if (process.argv[1] && process.argv[1].endsWith("decision-brief.mjs") && !process.argv.includes("--selftest")) {
  const [rawF, qF, outF] = process.argv.slice(2);
  let raw = null, b;
  try { raw = JSON.parse(fs.readFileSync(rawF, "utf8")); } catch {}
  if (!raw) b = { v: 1, ok: false, why: "no raw data" };
  else if (!fs.existsSync(qF || "")) b = { v: 1, ok: false, why: "no questions file" };
  else b = await brief({ raw, questions: fs.readFileSync(qF, "utf8") });
  if (process.env.BRIEF_PLAIN) fs.writeFileSync(process.env.BRIEF_PLAIN, JSON.stringify(b, null, 1));
  encrypt(Buffer.from(JSON.stringify(b, null, 1)), outF || "out/brief.enc.json");
  console.log(b.ok ? `brief ok: ${b.lines.length} line(s), ${b.dropped.length} dropped` : `brief skipped: ${String(b.why).replace(/\d{3,}/g, "#")}`);
}

if (process.argv.includes("--selftest")) {
  let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  const raw = { generated: "2026-11-21", parts: {
    "ga.coh": { dims: ["eventName", "kind"], mets: ["eventCount"], rows: [["first_save", "saver", 30], ["first_save", "saver", 12], ["app_return", "saver", 9], ["app_return", "non", 20], ["first_open", "(not set)", 400]] },
    "meta": { version: "1.38.3", n: [5, 7] } } };
  ok(at(raw, 'parts["meta"].n[1]') === 7 && at(raw, "parts.meta.version") === "1.38.3" && at(raw, "parts.x.y") === undefined && at(raw, "parts[") === undefined, "paths");
  ok(select(raw, { table: 'parts["ga.coh"]', metric: "eventCount", where: { eventName: "first_save" } }) === 42, "a sum over every matching row");
  ok(select(raw, { table: 'parts["ga.coh"]', metric: "eventCount", where: { eventName: ["app_return"], kind: "saver" } }) === 9, "two conditions, a list");
  ok(select(raw, { table: 'parts["ga.coh"]', metric: "eventCount", where: { eventName: "nope" } }) === undefined && select(raw, { table: 'parts["ga.coh"]', metric: "eventCount", where: { eventName: "nope" }, zeroOk: true }) === 0, "no row: no value, unless zero is a real answer");
  ok(select(raw, { table: 'parts["ga.coh"]', metric: "users", where: {} }) === undefined && select(raw, { table: 'parts["ga.coh"]', metric: "eventCount", where: { device: "x" } }) === undefined, "an unknown metric or dimension: no value");
  const good = { section: "Q2", text: "Savers who returned: {r} of {s} ({p}), on {v}", vals: { r: { table: 'parts["ga.coh"]', metric: "eventCount", where: { eventName: "app_return", kind: "saver" } }, s: { table: 'parts["ga.coh"]', metric: "eventCount", where: { eventName: "first_save" } }, p: { pct: ["r", "s"] }, v: { path: "parts.meta.version" } } };
  const f = fill(raw, good);
  ok(f.text === "Savers who returned: 9 of 42 (21.4%), on 1.38.3" && f.section === "Q2", "every value filled by code: " + f.text);
  ok(fill(raw, { text: "Savers returned: 9 of {s}", vals: { s: good.vals.s } }).why === "a number of the model's own", "a digit written by the model drops the line");
  ok(/no value for p/.test(fill(raw, { text: "Rate {p}", vals: { p: { pct: ["r", "s"] } } }).why), "a computed value from undefined parts: dropped");
  ok(fill(raw, { text: "Ratio {x}", vals: { a: { path: "parts.meta.n[0]" }, b: { path: "parts.meta.n[1]" }, x: { ratio: ["a", "b"] } } }).text === "Ratio 0.71", "ratio");
  ok(fill(raw, { text: "{d}", vals: { a: { path: "parts.meta.n[0]" }, z: { path: "parts.nothing" }, d: { pct: ["a", "z"] } } }).why === "no value for d", "a division by a missing value: dropped");
  ok(/Q2/.test(fill(raw, { text: "Q2 sample: {s}", vals: { s: good.vals.s } }).text), "Q1 to Q3 may be named");
  const big = { parts: { t: { dims: ["d"], mets: ["m"], rows: Array.from({ length: 500 }, (_, i) => ["v" + (i % 3), i]) } } };
  const d = digest(big); ok(d.parts.t.rowCount === 500 && d.parts.t.sampleRows.length === 60 && d.parts.t.dimValues.d.length === 3, "the model sees a sample; the code sums all rows");
  ok(select(big, { table: "parts.t", metric: "m", where: { d: "v0" } }) === Array.from({ length: 500 }, (_, i) => i).filter(i => i % 3 === 0).reduce((a, b) => a + b, 0), "the sum covers rows the model never saw");
  const fake = text => ({ messages: { create: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text }] }) } });
  let b = await brief({ raw, questions: "Q2?", api: fake(JSON.stringify({ lines: [good, { section: "x", text: "Made up 77", vals: {} }], missing: ["installs by OS, 12 rows"] })) });
  ok(b.ok && b.lines.length === 1 && b.dropped.length === 1 && b.dropped[0].why === "a number of the model's own" && b.missing[0] === "installs by OS, ## rows", "a brief: good lines kept, the rest dropped and listed, no digit in missing");
  b = await brief({ raw, questions: "Q2?", api: fake(JSON.stringify({ lines: [{ text: "a 1" }, { text: "b 2" }, good] })) });
  ok(!b.ok && b.why === "more lines dropped than kept", "more dropped than kept: read the raw");
  b = await brief({ raw, questions: "Q2?", api: fake("sorry") }); ok(!b.ok && b.why === "no valid JSON", "no JSON: fallback");
  b = await brief({ raw, questions: "Q2?", api: { messages: { create: async () => { const e = new Error("x"); e.status = 529; throw e; } } } }); ok(!b.ok && b.why === "529 server", "an API error: fallback");
  b = await brief({ raw, questions: "Q2?", env: {} }); ok(!b.ok && /ANTHROPIC_API_KEY/.test(b.why), "no key: fallback");
  { const sent = []; await brief({ raw, questions: "Q2?", api: { messages: { create: async p => { sent.push(p); return { stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] }; } } } });
    ok(sent[0].model === MODEL && /MUST NOT WRITE ANY DIGIT/.test(sent[0].messages[0].content) && sent[0].thinking.type === "adaptive", "Opus 5.5, adaptive thinking, the no-digit rule in the prompt"); }
  { const os = await import("node:os"), path = await import("node:path"), dir = fs.mkdtempSync(path.join(os.tmpdir(), "brief-"));
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    fs.writeFileSync(path.join(dir, "pub.pem"), publicKey.export({ type: "spki", format: "pem" }));
    encrypt(Buffer.from('{"ok":true}'), path.join(dir, "b.enc.json"), path.join(dir, "pub.pem"));
    const e = JSON.parse(fs.readFileSync(path.join(dir, "b.enc.json"), "utf8"));
    const key = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(e.ek, "base64"));
    const dc = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64")); dc.setAuthTag(Buffer.from(e.tag, "base64"));
    ok(Buffer.concat([dc.update(Buffer.from(e.data, "base64")), dc.final()]).toString() === '{"ok":true}', "encrypted the probes' way (decrypt.mjs reads it)"); }
  console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
}
