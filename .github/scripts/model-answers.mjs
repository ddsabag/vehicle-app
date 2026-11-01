// A short summary paragraph for model pages, written by Claude from that page's own facts (Claude API credit, plan of 1.11.2026).
// pages.mjs writes every page's facts (MODEL_FACTS=<file>) and shows a summary only while its hash still matches the page's facts, so a
// figure in it never drifts from the table under it. Every summary passes check() first: each number in it is a number of its facts, no
// causes, forecasts or verdicts, the length of a short paragraph. A page with no summary, or one that failed, simply keeps today's text.
//   node model-answers.mjs <facts.json> <slugs.json|slug,slug> [answers.json]   writes the answers file (default model-answers.json);
//                                                    only slugs whose facts changed are asked again; nothing here logs a token count
//   node model-answers.mjs --selftest                offline
import fs from "node:fs";
import crypto from "node:crypto";
import {client, ask, batch, answer} from "./claude.mjs";

export const MODEL = "claude-sonnet-5-5";
export const EFFORT = "high";   // a paragraph per page, written once and kept until the page's facts change: care over cents
export const factsHash = f => crypto.createHash("sha256").update(JSON.stringify(f)).digest("hex").slice(0, 16);
// causes and forecasts (the facts cannot carry them), and verdicts or advice about a model (a page states figures; the reader judges)
export const FORBIDDEN_WORDS = ["בגלל", "הסיבה", "כתוצאה", "עקב", "צפוי", "צפויה", "תחזית", "נראה כי", "ככל הנראה",
  "אמין", "מומלץ", "כדאי", "בעייתי", "בעיות", "מצוין", "גרוע", "הטוב ביותר", "הכי טוב", "לא מומלץ", "חסכוני"];
const SCHEMA = {type: "object", additionalProperties: false, required: ["text"], properties: {text: {type: "string"}}};
const NUM = /\d[\d,.]*\d|\d/g;
const nums = t => [...String(t).matchAll(NUM)].map(m => m[0].replace(/,/g, "").replace(/\.$/, ""));

export const SYSTEM = `You write a short summary paragraph at the top of a model page on לוחית (luchit.app), an Israeli site that checks cars by licence plate. The page shows, for one car model, figures from the Ministry of Transport's open data: how many cars of it are on the road by model year, how many left the road, typical mileage at the last test, ownership records, recalls, new-car sales and the list price. The facts are in the user message. Readers are people who own, buy or sell this model, and people in the trade (importers, dealers, leasing and fleet companies).

Write one paragraph in Hebrew, 2 to 4 sentences, 250 to 600 characters, that tells a reader what stands out about this model in Israel according to these figures: how common it is and which model years make up most of it, and what the comparisons with cars of the same model years show (off-road rate, mileage, ownership records), and new-car sales when the facts have them. Pick the two or three facts that say the most about this model; do not list everything. The page already shows every figure in a table and a list, so the paragraph is a reader's summary, not a copy of the list.

Rules (an automatic check rejects the paragraph if it breaks the first three):
1. Every number must appear in the facts exactly as written there (with its thousands comma). Do not add, subtract, round or compute new numbers, and write no number that is not in the facts; use words instead of a new figure ("רוב הרכבים", "כמחצית" is not allowed either, as it is a computed claim: describe what the by-year figures show without a new number).
2. No causes, forecasts or verdicts: never explain why a figure is what it is, never say what will happen, and never judge the model or advise the reader (no "אמין", "מומלץ", "כדאי", "חסכוני", "בעיות"). Never use: ${FORBIDDEN_WORDS.join(", ")}, also not inside a longer word (בעקבות, מעקב, צפויים).
3. Start with the model's name exactly as the facts write it in "name".
4. The comparisons are with cars of the same model years. Say that once ("בהשוואה לרכבים מאותם שנתונים"), then give each comparison briefly as "X% יותר מהממוצע", "X% פחות מהממוצע" or "בקירוב כמו הממוצע", without repeating "בשנתונים המקבילים" or "מאותם שנתונים" after every figure. Never double a comparison ("גבוה ב-6% יותר", "נמוכים ב-10% פחות" are wrong; write "6% יותר מהממוצע"). Ownership records include transfers between leasing companies and dealers, so never call them owners (בעלים). Call the annual roadworthiness test "טסט" ("בטסט האחרון"), as the page does.
5. Even-handed, plain news-register Hebrew with neutral forms; call the vehicles רכבים; a model agrees through the word דגם. Importers, dealers and leasing companies are never blamed for anything.
6. No sources, sites, links or mention of לוחית or of the reader checking a car.

Answer with JSON: {"text": "<the paragraph>"}.`;

export function check(facts, text) {
  const t = String(text || "").trim();
  if (t.length < 200 || t.length > 700) return `length ${t.length}`;
  const fw = FORBIDDEN_WORDS.find(w => t.includes(w)); if (fw) return "forbidden wording " + fw;
  if (/בעלים/.test(t)) return "owners";
  const first = String(facts.name).split(" (")[0];
  if (!t.startsWith(first)) return "does not start with the name";
  const allowed = new Set(nums(JSON.stringify(facts)));
  const bad = nums(t).find(n => !allowed.has(n)); if (bad) return "unknown number " + bad;
  if (/https?:|www\.|לוחית/.test(t)) return "a link or the site's name";
  if (/(גבוה|נמוך)\S*\s+(ב-?|של\s+)?\d[\d.,]*%\s+(יותר|פחות)/.test(t)) return "a doubled comparison";
  if ((t.match(/בשנתונים המקבילים|מאותם שנתונים/g) || []).length > 2) return "the same-years phrase repeated";
  return "";
}
const hint = why => /^length /.test(why) ? `the paragraph had ${why.slice(7)} characters; it must have 250 to 600`
  : /^unknown number /.test(why) ? `the number ${why.slice(15)} is not in the facts; use only numbers written in the facts, or words`
  : why === "owners" ? "ownership records are not owners; never write בעלים"
  : why === "a doubled comparison" ? "a comparison was doubled (like גבוה ב-6% יותר); write 6% יותר מהממוצע"
  : why === "the same-years phrase repeated" ? "say once that the comparisons are with cars of the same model years, not after every figure" : why;
export function request(facts, prev = "") {
  return {model: MODEL, max_tokens: 8000, thinking: {type: "adaptive"}, output_config: {effort: EFFORT, format: {type: "json_schema", schema: SCHEMA}},
    system: SYSTEM, messages: [{role: "user", content: `The facts of the page:\n<facts>\n${JSON.stringify(facts, null, 1)}\n</facts>`
      + (prev ? `\n\nYour previous paragraph was discarded by the automatic check: ${hint(prev)}. Write it again and keep every rule.` : "")}]};
}
const read = (facts, msg) => {
  const a = answer(msg); if (!a.text) return {why: a.why};
  let text = ""; try { text = JSON.parse(a.text).text; } catch { return {why: "not JSON"}; }
  const why = check(facts, text); return why ? {why} : {text: text.trim()};
};

// slugs to (re)write: the ones asked for whose facts changed since their summary; returns {answers, wrote, failed, why}
export async function write({facts, slugs, answers = {}, env = process.env, api = null, minutes = 50}) {
  const todo = slugs.filter(s => facts[s] && !(answers[s] && answers[s].h === factsHash(facts[s])));
  const out = {answers: {...answers}, wrote: [], failed: {}, why: ""};
  if (!todo.length) return out;
  if (!api) { const c = await client(env, {timeout: 120000}); if (!c.api) { out.why = c.why; return out; } api = c.api; }
  const b = await batch(api, todo.map(s => ({custom_id: s, params: request(facts[s])})), {minutes, every: 30, cancel: true});
  if (b.error && !b.results) { out.why = b.error.why; out.key = b.error.key; return out; }
  const at = new Date().toISOString().slice(0, 10);
  for (const s of todo) {
    const r = b.results && b.results.get(s);
    let got = r && r.ok ? read(facts[s], r.msg) : {why: r ? r.why : "no result"};
    if (!got.text) {   // one more try, on its own, told what the check found
      const again = await ask(api, request(facts[s], /^(length|forbidden|owners|does not|unknown|a link|not JSON|a doubled|the same-years)/.test(got.why) ? got.why : ""));
      got = again.error ? {why: again.error.why} : read(facts[s], again.msg);
    }
    if (got.text) { out.answers[s] = {text: got.text, h: factsHash(facts[s]), at}; out.wrote.push(s); } else out.failed[s] = got.why;
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("model-answers.mjs") && !process.argv.includes("--selftest")) {
  const [factsFile, list, file = "model-answers.json"] = process.argv.slice(2);
  const facts = JSON.parse(fs.readFileSync(factsFile, "utf8"));
  const slugs = /\.json$/.test(list) ? JSON.parse(fs.readFileSync(list, "utf8")).pilot : list.split(",");
  let answers = {}; try { answers = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const r = await write({facts, slugs, answers, minutes: Number(process.env.MODEL_ANSWERS_MINUTES) || 50});
  if (r.wrote.length) fs.writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(r.answers).sort()), null, 1) + "\n");
  console.log(`model summaries: ${r.wrote.length} written, ${Object.keys(r.failed).length} failed${r.why ? ` (${r.why})` : ""}`);
  for (const [s, w] of Object.entries(r.failed)) console.log(`  ${s}: ${w}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `wrote=${r.wrote.length}\nai=${r.key ? "key" : r.why && !r.wrote.length ? "fail" : "ok"}\n`);
}

if (process.argv.includes("--selftest")) {
  let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  const f = {name: "טויוטה קורולה (COROLLA)", years: "בשנתונים 1997 עד 2026", active: "191,431", off_road: "38,284", off_road_share: "16.7%", peak_year: "2021", peak_year_active: "17,728",
    by_year: [{year: "2021", active: "17,728", off_road: "908", typical_km: "109,812"}], off_road_rate_vs_same_years: "38% פחות מהממוצע בשנתונים המקבילים"};
  const good = "טויוטה קורולה היא מהדגמים הנפוצים בישראל, עם כ-191,431 רכבים פעילים בשנתונים 1997 עד 2026, והשנתון הנפוץ ביותר הוא 2021 עם 17,728 רכבים. שיעור הירידה מהכביש של הדגם הוא 38% פחות מהממוצע בשנתונים המקבילים, ו-38,284 רכבים ממנו ירדו מהכביש, שהם 16.7% מכל מה שנרשם.";
  ok(check(f, good) === "", "a paragraph whose every number is in the facts passes");
  ok(check(f, good.replace("17,728", "17,700")) === "unknown number 17700", "a changed number is caught");
  ok(check(f, good.replace("הוא 38% פחות", "נמוך ב-38% פחות")) === "a doubled comparison", "a doubled comparison is caught");
  ok(check(f, good + " הקילומטראז' 38% פחות מהממוצע של רכבים מאותם שנתונים, והבעלויות 38% פחות מהממוצע בשנתונים המקבילים.") === "the same-years phrase repeated", "the same-years phrase three times is caught");
  ok(check(f, good.replace("38% פחות", "כ-40% פחות")) === "unknown number 40", "a rounded number is caught");
  ok(check(f, good + " הדגם נחשב אמין.").startsWith("forbidden wording אמין"), "a verdict is caught");
  ok(check(f, good.replace("שהם", "בגלל שהם")).startsWith("forbidden wording"), "a cause is caught");
  ok(check(f, good.replace("רכבים פעילים", "רכבים פעילים אצל בעלים")) === "owners", "owners are caught");
  ok(check(f, "הדגם " + good) === "does not start with the name", "it starts with the name");
  ok(check(f, "טויוטה קורולה נפוצה.") === "length 20", "too short is caught");
  ok(factsHash(f) === factsHash(JSON.parse(JSON.stringify(f))) && factsHash(f) !== factsHash({...f, active: "1"}), "the hash follows the facts");
  ok(request(f).model === MODEL && request(f).output_config.effort === EFFORT && request(f).thinking.type === "adaptive" && !("temperature" in request(f)), "the request: model, effort, adaptive thinking, no sampling parameters");
  ok(/38,284/.test(request(f).messages[0].content) && /discarded/.test(request(f, "length 20").messages[0].content), "facts in the user message; a retry says why");
  // the flow through a fake API: one good, one with a wrong number then good on the retry, one that fails twice, one unchanged
  const reply = text => ({stop_reason: "end_turn", content: [{type: "text", text: JSON.stringify({text})}]});
  const facts = {a: f, b: f, c: f, d: f}, asked = [];
  const fake = {messages: {batches: {create: async ({requests}) => { asked.push(...requests.map(r => r.custom_id)); return {id: "msgbatch_1"}; }, retrieve: async id => ({id, processing_status: "ended"}),
      results: async () => (async function* () { yield {custom_id: "a", result: {type: "succeeded", message: reply(good)}}; yield {custom_id: "b", result: {type: "succeeded", message: reply(good.replace("17,728", "17,000"))}}; yield {custom_id: "c", result: {type: "expired"}}; })()},
    create: async p => /discarded.*17000/.test(p.messages[0].content) ? reply(good) : reply("טויוטה קורולה.")}};
  const r = await write({facts, slugs: ["a", "b", "c", "d"], answers: {d: {text: good, h: factsHash(f), at: "2026-11-01"}}, api: fake, minutes: 0});
  ok(asked.join() === "a,b,c", "only slugs whose facts changed are asked (d is kept)");
  ok(r.wrote.join() === "a,b" && r.answers.b.text === good && r.answers.d.text === good, "a good one is kept; a rejected one gets one retry with the reason");
  ok(r.failed.c === "length 14" && !r.answers.c, "one that fails twice is left out: that page keeps today's text");
  { const r2 = await write({facts, slugs: ["a"], env: {}}); ok(r2.why === "no ANTHROPIC_API_KEY" && !r2.wrote.length, "no key: nothing written, the pages keep today's text"); }
  { const r3 = await write({facts, slugs: ["a"], api: {messages: {batches: {create: async () => { const e = new Error("x"); e.status = 401; throw e; }}}}}); ok(r3.key === true && !r3.wrote.length, "a refused key: ai:key, nothing written"); }
  console.log(bad ? `selftest: ${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
}
