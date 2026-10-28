// The monthly article's prose from Claude (plan of 28.10.2026, use 6 of the monthly API credit, Dudu: "לבצע"), in place of Gemini, which was
// switched off in 09.2026 for a repeated typo and clumsy wording. magazine.mjs hands over its facts, the title and its own check(): Claude
// writes the body only (lead, bodies_p, ytd_p, tldr, faq), the title stays the data template's, and a draft is used only when check() passes
// (every number from the facts, no causal or forecast wording, the lengths). No key, no SDK, MAGAZINE_AI=0, an API error, a refusal or two
// rejected drafts give back no draft, and the fixed template writes the article as before. Through the shared helper (claude.mjs), one call
// at a time; a refusal also ends on the template (the server-side fallback retries only cyber and frontier_llm declines, which an article
// about car deliveries cannot raise). Nothing here prints the key, a draft or a token count: the run log is public.
//   prose({facts, title, check, env, api, keep})  {draft, why, alert, attempts, usage}
//       draft     the fields with the title, or null (the template writes the article)
//       why       a short reason safe in a public log ("401 key", "unknown number 1,234", "refusal general_harms"); "" when the draft passed
//       alert     "key": the key or the credit is the cause (ai:key, Dudu acts); "mag": the API could not be reached (ai:mag, quiet);
//                 "ok": the API answered, so both close; "": no call was made (no key, no SDK, switched off)
//       attempts  [{why}] per call, with the draft itself only when keep is set (the comparison run, which seals its output)
//       usage     {input, output} tokens over the calls, for the sealed comparison only (never log it)
//   node magazine-ai.mjs --selftest   offline, through a fake API
import {client, ask, answer, usage as tokens} from "./claude.mjs";

export const MODEL = "claude-sonnet-5-5";
export const EFFORT = "high";   // one article a month: the care is worth more than the few cents a lower level saves
// the strings magazine.mjs refuses (its FORBIDDEN), also inside longer words; the prompt lists the same ones
export const FORBIDDEN_WORDS = ["בגלל", "הסיבה", "כתוצאה", "עקב", "צפוי", "תחזית", "צפויה", "נראה כי", "ככל הנראה"];
const TRIES = 2;

export const SCHEMA = {
  type: "object", additionalProperties: false, required: ["lead", "bodies_p", "ytd_p", "tldr", "faq"],
  properties: {
    lead: {type: "string"}, bodies_p: {type: "string"}, ytd_p: {type: "string"},
    tldr: {type: "array", items: {type: "string"}},
    faq: {type: "array", items: {type: "object", additionalProperties: false, required: ["q", "a"], properties: {q: {type: "string"}, a: {type: "string"}}}}
  }
};

export const SYSTEM = `You write the text of the monthly market article in the magazine of לוחית (luchit.app), an Israeli site that checks cars by licence plate. The article reports one month of new private-car deliveries in Israel, from the facts in the user message, which come from the Ministry of Transport's open data. Its readers follow the Israeli car market: buyers, owners, and people in the trade (importers, dealers, leasing and fleet companies).

Apart from your text, the page already shows the title, the month's total in large type with the change against the same month last year, ranked lists of the top five models and the top five makers with their delivery counts, and a section on supply swings. So name the leaders, but do not list every model and maker again. You write only these fields:
- lead: the opening paragraph, 2 or 3 sentences: the month's total, the comparison with the same month last year when the facts have one, and the leading maker and model.
- bodies_p: 1 or 2 sentences on the body types in top_body_types and their shares.
- ytd_p: 1 or 2 sentences on the year so far against the same period last year; an empty string when year_to_date_last_year is 0.
- tldr: exactly 3 short sentences, each under 200 characters, that sum up the article for a reader in a hurry.
- faq: 3 or 4 questions a reader would type into a search engine about this month's figures, each naming the month and the year, and each answered in 1 or 2 sentences taken only from the facts. Questions under 150 characters, answers under 350.
The tldr and the answers may repeat facts from the paragraphs; each field has to read well on its own.

An automatic check reads the draft and discards it, without exceptions, when any of these rules is broken:
1. Every number you write in digits must appear in the facts exactly as given. Never add, subtract, divide, round or re-derive anything: no differences between periods, no sums, no shares or ratios the facts do not give, no "כ-24 אלף" for 24162. Write large numbers in full, with a thousands comma (24,162). Write ranks in words (השני, השלישית), never as digits.
2. The percentages in the facts are rounded and have no sign. The direction is in change_direction and ytd_direction: עלייה, ירידה, or שינוי קטן for a change under 2%. Write them like "ירידה של כ-17%" or "עלייה של כ-5%". When a percentage or a last-year figure is null or 0, leave that comparison out.
3. No causes, explanations, forecasts or guesses: say what the numbers show, never why it happened or what will happen next. These strings must not appear anywhere, not even inside a longer word: ${FORBIDDEN_WORDS.join(", ")}. So also no מעקב, בעקבות or עקבי, and no צפויים.

Also:
4. Write every model and maker name exactly as the facts spell it, letter for letter, in the same script and the same capitals: "טסלה MODEL Y", not "Tesla Model Y" or "טסלה מודל Y". The page links these names to the models' own pages. A Hebrew prefix letter goes straight onto a Hebrew word (בטויוטה); before Latin letters or digits it takes a hyphen (ב-MG S9).
5. Be even-handed about every maker, importer and dealer: report their figures without praising or criticising anyone, with measured verbs (נמסרו, עלה, ירד, הוביל), never dramatic ones (זינק, קרס, צנח, שבר שיא).
6. Clear, correct, natural Hebrew in the register of a news report: full sentences, the past tense for the month's figures, and varied sentence openings. No exclamation marks, no emoji, no rhetorical questions, no English words other than the names, and do not address the reader; where people have to be mentioned, use neutral forms such as the plural. Before you answer, check the spelling, the agreement in gender and number, and the punctuation of every sentence.
7. Do not mention sources, websites, the app, or how the text was written.`;

// what the check's reason means, said back to Claude on the second try
const HINT = {
  "bad tldr": "tldr must hold exactly 3 non-empty sentences, each under 200 characters",
  "bad faq": "faq must hold 3 or 4 items, each question under 150 characters and each answer under 350",
  "max_tokens": "the answer was cut off at the length limit", "no text": "the answer held no JSON object", "not JSON": "the answer was not a valid JSON object"
};
const hint = why => HINT[why] || (/^missing /.test(why) ? `the field ${why.slice(8)} was empty` : why);
const userText = (facts, prev) => `The facts for the article about ${facts.month}:\n<facts>\n${JSON.stringify(facts, null, 1)}\n</facts>`
  + (prev ? `\n\nYour previous draft was discarded by the automatic check: ${hint(prev)}. Write all the fields again and keep every rule.` : "");

export function request(facts, prev = "") {
  return {model: MODEL, max_tokens: 16000, thinking: {type: "adaptive"}, output_config: {effort: EFFORT, format: {type: "json_schema", schema: SCHEMA}},
    system: SYSTEM, messages: [{role: "user", content: userText(facts, prev)}]};
}

export async function prose({facts, title, check, env = process.env, api = null, keep = false}) {
  const out = {draft: null, why: "", alert: "", attempts: [], usage: {input: 0, output: 0}};
  if (env.MAGAZINE_AI === "0") { out.why = "off (MAGAZINE_AI=0)"; return out; }
  if (!api) { const c = await client(env); if (!c.api) { out.why = c.why; return out; } api = c.api; }
  // a short request: 2.5 minutes a call and one SDK retry (429, 5xx, network), so even the worst case leaves the job its time for the template
  if (typeof api.withOptions === "function") api = api.withOptions({timeout: 150000, maxRetries: 1});
  let prev = "";
  for (let t = 0; t < TRIES; t++) {
    const r = await ask(api, request(facts, prev));
    if (r.error) { out.why = r.error.why; out.alert = r.error.key ? "key" : "mag"; return out; }
    out.alert = "ok";
    const u = tokens(r.msg); out.usage.input += u.input; out.usage.output += u.output;
    const {text, why} = answer(r.msg);
    let a = null, bad = why;
    if (text) {
      try { a = JSON.parse(text); } catch { a = null; }
      if (!a || typeof a !== "object" || Array.isArray(a)) { a = null; bad = "not JSON"; }
      else try { bad = check({...a, title}) || ""; } catch { bad = "bad draft"; }
    }
    out.attempts.push(keep && a ? {why: bad || "ok", draft: a} : {why: bad || "ok"});
    if (!bad) { out.draft = {...a, title}; return out; }
    prev = bad;
    if (/^refusal/.test(bad)) break;   // asking again would only spend the call: the template writes it
  }
  out.why = prev;
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("magazine-ai.mjs") && process.argv.includes("--selftest")) {
  let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  const facts = {month: "ספטמבר 2026", total: 24162, same_month_last_year: 29206, change_percent_vs_last_year: 17, change_direction: "ירידה",
    top_models: [{model: "טסלה MODEL Y", deliveries: 1097}], top_makers: [{maker: "טויוטה", deliveries: 2687}],
    top_body_types: [{type: "פנאי-שטח", deliveries: 18442, share_percent: 76}], year_to_date: 1, year_to_date_last_year: 0, ytd_change_percent: null, ytd_direction: ""};
  const good = {lead: "נמסרו 24,162 רכבים.", bodies_p: "פנאי-שטח היו 76%.", ytd_p: "", tldr: ["א.", "ב.", "ג."], faq: [{q: "ש?", a: "ת."}, {q: "ש?", a: "ת."}, {q: "ש?", a: "ת."}]};
  // the same rules as magazine.mjs's check(), in small: numbers from a list, and three tldr lines
  const check = a => { if (!Array.isArray(a.tldr) || a.tldr.length !== 3) return "bad tldr"; for (const m of JSON.stringify(a).matchAll(/\d[\d,.]*\d|\d/g)) if (!["24162", "76", "3"].includes(m[0].replace(/,/g, ""))) return "unknown number " + m[0]; return null; };
  const reply = (text, extra = {}) => ({stop_reason: "end_turn", content: [{type: "thinking", thinking: ""}, {type: "text", text}], usage: {input_tokens: 10, output_tokens: 5}, ...extra});
  const fake = replies => { const f = {calls: [], opts: null, messages: {create: async p => { f.calls.push(p); const r = replies[f.calls.length - 1]; if (r instanceof Error) throw r; return r; }}};
    f.withOptions = o => { f.opts = o; return f; }; return f; };
  const apiErr = (status, message = "x") => Object.assign(new Error(message), {status, error: {error: {type: status === 400 ? "invalid_request_error" : "error", message}}});

  { const r = await prose({facts, title: "כותרת", check, env: {MAGAZINE_AI: "0", ANTHROPIC_API_KEY: "k"}, api: fake([])});
    ok(!r.draft && r.alert === "" && /MAGAZINE_AI=0/.test(r.why), "MAGAZINE_AI=0: no call, the template writes it"); }
  { const r = await prose({facts, title: "כותרת", check, env: {}});
    ok(!r.draft && r.alert === "" && r.why === "no ANTHROPIC_API_KEY", "no key: no call, and why says so"); }
  { const f = fake([reply(JSON.stringify(good))]), r = await prose({facts, title: "כותרת", check, env: {}, api: f}), p = f.calls[0];
    ok(r.draft && r.draft.title === "כותרת" && r.draft.lead === good.lead && r.alert === "ok" && r.why === "" && f.calls.length === 1, "a good draft: used, with the data's title");
    ok(p.model === "claude-sonnet-5-5" && p.thinking.type === "adaptive" && p.output_config.effort === EFFORT && p.output_config.format.type === "json_schema"
      && p.output_config.format.schema === SCHEMA && !("temperature" in p) && !("top_p" in p) && p.max_tokens === 16000, "the request: the model, adaptive thinking, effort set, the JSON schema, no sampling parameters");
    ok(p.messages[0].content.includes('"total": 24162') && p.messages[0].content.includes("ספטמבר 2026") && !/discarded/.test(p.messages[0].content), "the facts go in the user message");
    ok(f.opts && f.opts.timeout === 150000 && f.opts.maxRetries === 1, "a short timeout and one SDK retry for this call");
    ok(FORBIDDEN_WORDS.every(w => SYSTEM.includes(w)) && SYSTEM.includes("טסלה MODEL Y"), "the prompt lists every refused string"); }
  { const f = fake([reply(JSON.stringify({...good, lead: "נמסרו 99 רכבים."})), reply(JSON.stringify(good))]), r = await prose({facts, title: "כותרת", check, env: {}, api: f});
    ok(r.draft && f.calls.length === 2 && f.calls[1].messages[0].content.includes("unknown number 99") && r.attempts[0].why === "unknown number 99" && !r.attempts[0].draft,
      "a rejected draft: asked once more with the reason; the draft itself is kept only for the comparison run"); }
  { const f = fake([reply(JSON.stringify({...good, tldr: ["א."]})), reply(JSON.stringify({...good, tldr: ["א."]}))]), r = await prose({facts, title: "כותרת", check, env: {}, api: f, keep: true});
    ok(!r.draft && r.why === "bad tldr" && r.alert === "ok" && f.calls.length === 2 && f.calls[1].messages[0].content.includes("exactly 3 non-empty sentences") && r.attempts.length === 2 && r.attempts[1].draft.tldr.length === 1,
      "two rejected drafts: the template, and the API counts as answered (the alerts close)"); }
  { const f = fake([reply("", {stop_reason: "refusal", stop_details: {category: "general_harms"}, content: []}), reply(JSON.stringify(good))]), r = await prose({facts, title: "כותרת", check, env: {}, api: f});
    ok(!r.draft && r.why === "refusal general_harms" && f.calls.length === 1 && r.alert === "ok", "a refusal: no second call, the template writes it"); }
  { const f = fake([reply("{\"lead\":"), reply(JSON.stringify(good))]), r = await prose({facts, title: "כותרת", check, env: {}, api: f});
    ok(r.draft && f.calls.length === 2 && f.calls[1].messages[0].content.includes("not a valid JSON object"), "broken JSON: asked once more"); }
  { const f = fake([reply("null"), reply("[1]")]), r = await prose({facts, title: "כותרת", check, env: {}, api: f});
    ok(!r.draft && r.why === "not JSON" && f.calls.length === 2, "JSON that is not an object: rejected"); }
  { const f = fake([reply(JSON.stringify(good)), reply(JSON.stringify(good))]), r = await prose({facts, title: "כותרת", check: () => { throw new TypeError("x"); }, env: {}, api: f});
    ok(!r.draft && r.why === "bad draft" && f.calls.length === 2, "a check that throws on an odd draft: rejected, never a crash"); }
  { const f = fake([apiErr(401, "invalid x-api-key")]), r = await prose({facts, title: "כותרת", check, env: {}, api: f});
    ok(!r.draft && r.alert === "key" && /^401 key/.test(r.why) && f.calls.length === 1, "401: ai:key, the template writes it"); }
  { const f = fake([apiErr(400, "Your credit balance is too low to access the Anthropic API.")]), r = await prose({facts, title: "כותרת", check, env: {}, api: f});
    ok(!r.draft && r.alert === "key", "the credit ran out: ai:key"); }
  { const f = fake([apiErr(529, "Overloaded")]), r = await prose({facts, title: "כותרת", check, env: {}, api: f});
    ok(!r.draft && r.alert === "mag" && r.why === "529 server" && f.calls.length === 1, "an overloaded API: ai:mag (quiet), the template writes it"); }
  { const f = fake([reply(JSON.stringify(good))]), r = await prose({facts, title: "כותרת", check, env: {}, api: f});
    ok(r.usage.input === 10 && r.usage.output === 5 && !JSON.stringify(r.attempts).includes("10"), "token counts stay in usage, out of the attempts"); }
  console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
}
