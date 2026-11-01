// Sunday anomaly review by Claude (use of the monthly API credit, Dudu "תשחרר את כל ה5" 1.11.2026, API-credits thread). Runs inside the
// weekly report's own job, right after the report is built, on the report's JSON (analytics/out/luchit-weekly-<end>.json). claude-opus-5-5 (adaptive thinking, effort high, since package B)
// reads the week's anomalies and KPIs beside the known non-behaviour shifts (analytics/review-context.md) and says, per anomaly, whether it is
// real, explained by a known shift, or needs a check, and adds any big KPI move the fixed rules did not raise. The measurement thread's Sunday
// task reads the result first and only works what is flagged (or a failure), instead of reading the whole week by hand.
// Safety: a red anomaly the reply leaves out or calls "explained" without a cause still counts as flagged, so the model can never hide one.
// Business numbers stay private: the reply is encrypted with .github/seo-data.pub.pem (out/review.enc.json); the public status.json and the
// log carry only ok / flagged / why (no numbers). With no key, no SDK or an API error the status says why and the Sunday task does the review
// as before (its fallback). This job has read scopes only, so the router call is made by the publish job from status.json.
//   node anomaly-review.mjs <report dir> <out dir>      the review (ANTHROPIC_API_KEY from the step's env only)
//   node anomaly-review.mjs --route <status.json>        the publish job (contents: write): a failed review is ai:anomalies (summary),
//                                                       the key or the credit ai:key (day); a good review closes ai:anomalies and ai:key
//   node anomaly-review.mjs --selftest                  offline: the input, the parse, the red safety rule, the fallbacks, the encryption
import fs from "node:fs";
import crypto from "node:crypto";
import { client, ask, answer } from "./claude.mjs";

// Opus 5.5 with adaptive thinking at effort high (credit package B, Dudu 1.11 21:16 UTC): the one weekly judgement that feeds the CEO file and
// Dudu; about $0.50 a month. Thinking can't be turned off on Opus 5.5 and its default effort is medium, so effort is set here.
export const MODEL = "claude-opus-5-5";
export const PROMPT_V = 2;
const MAX_TOKENS = 16000;
export const EFFORT = "high";
// the parts of the report's analysis the review needs (the long tables of makes, models, tabs and "extra" stay out: cost, and nothing to judge)
const PARTS = ["status", "anomalies", "kpis", "metrics", "dur", "versions", "takeaways"];
const VERDICTS = ["real", "explained", "check"];

export function pickReport(dir) {
  const f = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => /^luchit-weekly-.*\.json$/.test(n)).sort().pop() : null;
  if (!f) return { why: "no report JSON" };
  const j = JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8")), a = j.analysis || {};
  const week = f.replace(/^luchit-weekly-|\.json$/g, "");
  return { week, input: Object.fromEntries(PARTS.filter(k => a[k] !== undefined).map(k => [k, a[k]])) };
}

export function system(context) {
  return [
    "You review the weekly analytics report of a small Israeli car-check app (licence plate lookups, website and Android app).",
    "Fixed rules already raised the anomalies in the input. For EACH anomaly decide:",
    "- \"explained\": a known non-behaviour shift below fully accounts for it (name which in cause);",
    "- \"real\": a real change in behaviour or reliability that its owner thread must handle;",
    "- \"check\": the data cannot tell; say what to check.",
    "Then look at the KPIs for any move of 30% or more week over week, or a value that contradicts another KPI, that no anomaly covers; add each",
    "as an extra item with level \"yellow\" and verdict \"check\" or \"real\". Never invent numbers: quote only numbers present in the input.",
    "Write title, cause and numbers in plain Hebrew, neutral forms. Keep each field short (one sentence).",
    "Answer with JSON only, no prose and no code fence:",
    "{\"items\":[{\"title\":\"...\",\"level\":\"red|yellow|info\",\"verdict\":\"real|explained|check\",\"cause\":\"...\",\"numbers\":\"...\",\"owner\":\"...\",\"extra\":false}],\"summary\":\"one Hebrew sentence\"}",
    "owner: copy the anomaly's own owner; for an extra item, the thread that owns that KPI if clear, else \"מדידה\".",
    "",
    "Known non-behaviour shifts (from the project's threads, kept in analytics/review-context.md):",
    context.trim(),
  ].join("\n");
}

// the reply's JSON, checked; the red safety rule decides "flagged" on top of what the model said
export function judge(text, input) {
  let r;
  try { r = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return { ok: false, why: "reply is not JSON" }; }
  if (!r || !Array.isArray(r.items)) return { ok: false, why: "reply has no items" };
  const items = r.items.filter(x => x && typeof x.title === "string" && VERDICTS.includes(x.verdict)).map(x => ({
    title: x.title.slice(0, 200), level: ["red", "yellow", "info"].includes(x.level) ? x.level : "yellow", verdict: x.verdict,
    cause: String(x.cause || "").slice(0, 400), numbers: String(x.numbers || "").slice(0, 300), owner: String(x.owner || "").slice(0, 60), extra: !!x.extra }));
  const reds = (input.anomalies || []).filter(a => a.level === "red");
  const hidden = reds.filter(a => !items.some(x => x.title === a.title && (x.verdict !== "explained" || x.cause.trim())));
  for (const a of hidden) items.push({ title: a.title, level: "red", verdict: "check", cause: "התשובה לא התייחסה לחריגה האדומה הזו", numbers: "", owner: a.owner || "", extra: false });
  const flagged = items.some(x => x.verdict !== "explained" && x.level !== "info");
  return { ok: true, flagged, items, summary: String(r.summary || "").slice(0, 300), hidden: hidden.length };
}

export function encryptTo(data, file, pem = fs.readFileSync(".github/seo-data.pub.pem", "utf8")) {
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(data), c.final()]);
  const ek = crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  fs.writeFileSync(file, JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: enc.toString("base64") }));
}

export async function run({ dir, out, env = process.env, api, now = new Date(), pem, context, log = console.log } = {}) {
  fs.mkdirSync(out, { recursive: true });
  const status = { generated: now.toISOString(), model: MODEL, v: PROMPT_V, ok: false, flagged: null, key: false, why: "" };
  const done = () => { fs.writeFileSync(`${out}/status.json`, JSON.stringify(status)); log(`anomaly review: ${status.ok ? (status.flagged ? "flagged" : "nothing flagged") : "no review (" + status.why + ")"}`); return status; };
  const rep = pickReport(dir);
  if (!rep.input) { status.why = rep.why; return done(); }
  status.week = rep.week;
  if (api === undefined) { const c = await client(env, { timeout: 600000 }); api = c.api; if (!api) { status.why = c.why; return done(); } }
  const ctx = context ?? fs.readFileSync("analytics/review-context.md", "utf8");
  const r = await ask(api, { model: MODEL, max_tokens: MAX_TOKENS, thinking: { type: "adaptive" }, output_config: { effort: EFFORT }, system: system(ctx),
    messages: [{ role: "user", content: "The week ending " + rep.week + ":\n" + JSON.stringify(rep.input) }] });
  if (r.error) { status.why = r.error.why; status.key = r.error.key; return done(); }
  const a = answer(r.msg);
  if (!a.text) { status.why = a.why; return done(); }
  const j = judge(a.text, rep.input);
  if (!j.ok) { status.why = j.why; return done(); }
  encryptTo(Buffer.from(JSON.stringify({ week: rep.week, generated: status.generated, model: MODEL, v: PROMPT_V, ...j }, null, 1)), `${out}/review.enc.json`, pem);
  Object.assign(status, { ok: true, flagged: j.flagged, why: j.hidden ? "a red anomaly was missing from the reply" : "" });
  return done();
}

export async function route(status, router, env = process.env) {
  if (!router) return "no router";
  try {
    if (status.ok) { await router.resolve(["ai:anomalies"]); await router.resolve(["ai:key"]); return "closed"; }
    if (/ANTHROPIC_API_KEY|no report JSON|no status/.test(status.why || "")) return "skipped";   // switched off on purpose, or the report itself failed (its own alert)
    const key = !!status.key, text = `סקירת החריגות של הדוח השבועי לא רצה (${String(status.why || "").replace(/\d[\d,.\-]{3,}\d/g, "#").slice(0, 120)}). הסקירה של יום ראשון נעשית ידנית כמו קודם.`;
    await router.alert(key ? "day" : "summary", key ? "ai:key" : "ai:anomalies", text, env.RUN_URL || "", { today: key ? "loud" : "silent", legacy: () => false });
    return key ? "ai:key" : "ai:anomalies";
  } catch { return "router failed"; }
}

if (process.argv[1] && process.argv[1].endsWith("anomaly-review.mjs")) {
  if (process.argv.includes("--selftest")) {
    let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
    const tmp = fs.mkdtempSync("/tmp/ar-"), dir = `${tmp}/in`, out = `${tmp}/out`; fs.mkdirSync(dir);
    const anomalies = [{ level: "red", title: "בדיקות איטיות מעל הסף", detail: "x", owner: "מדידה" }, { level: "yellow", title: "ירידה בשיעור השיתוף", detail: "y", owner: "מוצר" }];
    fs.writeFileSync(`${dir}/luchit-weekly-2026-10-31.json`, JSON.stringify({ insights: {}, data: { big: 1 }, analysis: { status: "red", anomalies, kpis: { health: [] }, makes: [1, 2], extra: { a: 1 } } }));
    const p = pickReport(dir);
    ok(p.week === "2026-10-31" && p.input.anomalies.length === 2 && !p.input.makes && !p.input.extra, "the report: its week and only the parts the review needs");
    ok(pickReport(`${tmp}/none`).why === "no report JSON", "no report: says so");
    const both = { items: [{ title: anomalies[0].title, level: "red", verdict: "real", cause: "c", owner: "מדידה" }, { title: anomalies[1].title, level: "yellow", verdict: "explained", cause: "הכפתור עבר לכותרת", owner: "מוצר" }], summary: "s" };
    let j = judge(JSON.stringify(both), p.input);
    ok(j.ok && j.flagged && j.items.length === 2 && j.hidden === 0, "a real red: flagged");
    j = judge("```json\n" + JSON.stringify({ items: [both.items[1]], summary: "" }) + "\n```", p.input);
    ok(j.ok && j.flagged && j.hidden === 1 && j.items.some(x => x.title === anomalies[0].title && x.verdict === "check"), "a red the reply left out is added back as check, and flags");
    j = judge(JSON.stringify({ items: [{ ...both.items[0], verdict: "explained", cause: "" }, both.items[1]] }), p.input);
    ok(j.flagged && j.hidden === 1, "a red called explained with no cause still flags");
    j = judge(JSON.stringify({ items: [{ ...both.items[0], verdict: "explained", cause: "מקור איטי בשתי הפלטפורמות" }, both.items[1]] }), p.input);
    ok(j.ok && !j.flagged && j.hidden === 0, "everything explained with a cause: nothing flagged");
    ok(!judge("not json", p.input).ok && judge("{}", p.input).why === "reply has no items", "a reply that is not the JSON: no review (fallback)");
    ok(/Known non-behaviour shifts/.test(system("- a shift")) && system("- a shift").endsWith("- a shift"), "the stable prompt carries the context file");
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const reply = t => ({ messages: { create: async q => { reply.last = q; return { stop_reason: "end_turn", content: [{ type: "text", text: t }] }; } } });
    const quiet = () => {};
    let s = await run({ dir, out, api: reply(JSON.stringify(both)), pem: publicKey, context: "- ctx", log: quiet });
    const e = JSON.parse(fs.readFileSync(`${out}/review.enc.json`, "utf8"));
    const key = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(e.ek, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64")); d.setAuthTag(Buffer.from(e.tag, "base64"));
    const plain = JSON.parse(Buffer.concat([d.update(Buffer.from(e.data, "base64")), d.final()]).toString());
    ok(s.ok && s.flagged && plain.items.length === 2 && plain.week === "2026-10-31", "a good reply: encrypted review, status ok and flagged");
    ok(reply.last.model === "claude-opus-5-5" && reply.last.thinking.type === "adaptive" && reply.last.output_config.effort === "high" && !JSON.stringify(reply.last.messages).includes("makes"), "the call: the model, and the long tables left out");
    const st = fs.readFileSync(`${out}/status.json`, "utf8");
    ok(!/\d{3,}/.test(st.replace(/"generated":"[^"]*"/, "").replace(/"week":"[^"]*"/, "").replace(/"model":"[^"]*"/, "")), "the public status has no numbers");
    fs.rmSync(`${out}/review.enc.json`);
    s = await run({ dir, out, api: { messages: { create: async () => { const x = new Error("x"); x.status = 401; throw x; } } }, pem: publicKey, context: "", log: quiet });
    ok(!s.ok && s.key && s.why === "401 key" && !fs.existsSync(`${out}/review.enc.json`), "the key refused: no review, the key's problem (ai:key)");
    s = await run({ dir, out, api: { messages: { create: async () => { const x = new Error("x"); x.status = 529; throw x; } } }, pem: publicKey, context: "", log: quiet });
    ok(!s.ok && !s.key && s.why === "529 server", "an API error: no review, the bot's own (ai:anomalies)");
    s = await run({ dir, out, api: reply("sorry"), pem: publicKey, context: "", log: quiet });
    ok(!s.ok && s.why === "reply is not JSON", "a reply that is not JSON: no review");
    s = await run({ dir, out, env: {}, pem: publicKey, context: "", log: quiet });
    ok(!s.ok && s.why === "no ANTHROPIC_API_KEY" && !s.key, "no key: no review, and the Sunday task does it as before");
    const calls = [], router = { alert: async (lv, k) => { calls.push(lv + " " + k); }, resolve: async p => { calls.push("resolve " + p[0]); } };
    ok(await route({ ok: true }, router) === "closed" && calls.join() === "resolve ai:anomalies,resolve ai:key", "a good review closes its key and ai:key");
    calls.length = 0; ok(await route({ ok: false, why: "529 server" }, router) === "ai:anomalies" && calls.join() === "summary ai:anomalies", "a failed review: ai:anomalies, summary");
    calls.length = 0; ok(await route({ ok: false, why: "401 key", key: true }, router) === "ai:key" && calls.join() === "day ai:key", "the key or the credit: ai:key, day");
    calls.length = 0; ok(await route({ ok: false, why: "no ANTHROPIC_API_KEY" }, router) === "skipped" && !calls.length, "no key on purpose: nothing sent");
    fs.rmSync(tmp, { recursive: true });
    console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
  } else if (process.argv[2] === "--route") {
    const st = (() => { try { return JSON.parse(fs.readFileSync(process.argv[3], "utf8")); } catch { return { ok: false, why: "no status (the review step did not run)" }; } })();
    console.log("router: " + await route(st, await import("./alert.mjs").catch(() => null)));
  } else {
    const [dir = "analytics/out", out = "out-review"] = process.argv.slice(2);
    await run({ dir, out });
  }
}
