// The monthly article's prose from Claude (plan of 28.10.2026, use 6 of the monthly API credit, Dudu: "לבצע"), in place of Gemini, which was
// switched off in 09.2026 for a repeated typo and clumsy wording. magazine.mjs hands over its facts, the title and its own check(): Claude
// writes the body only (lead, bodies_p, ytd_p, tldr, faq), the title stays the data template's, and a draft is used only when check() passes
// (every number from the facts and next to its own name, no causal or forecast wording, the lengths). A draft that passes gets one copy-edit
// call for the Hebrew alone (the trial of 28.10 had a few slips: a missing preposition, "נמכר ביותר", "אחריה בא טויוטה"); the edit is kept
// only when its numbers, names and item counts are the draft's and it passes check() again, otherwise the checked draft goes as it is.
// No key, no SDK, MAGAZINE_AI=0, an API error, a refusal or two rejected drafts give back no draft, and the fixed template writes the article
// as before. Through the shared helper (claude.mjs), one call at a time; a refusal also ends on the template (the server-side fallback
// retries only cyber and frontier_llm declines, which an article about car deliveries cannot raise). Nothing here prints the key, a draft
// or a token count: the run log is public.
//   prose({facts, title, check, env, api, keep})  {draft, why, alert, attempts, usage}
//       draft     the fields with the title, or null (the template writes the article)
//       why       a short reason safe in a public log ("401 key", "unknown number 1,234", "refusal general_harms"); "" when the draft passed
//       alert     "key": the key or the credit is the cause (ai:key, Dudu acts); "mag": the API could not be reached (ai:mag, quiet);
//                 "ok": the API answered, so both close; "": no call was made (no key, no SDK, switched off)
//       attempts  [{why}] per call ("ok", a rejection, "edit ok" or "edit: <why>"), with the draft itself only when keep is set (the
//                 comparison run, which seals its output)
//       usage     {input, output} tokens over the calls, for the sealed comparison only (never log it)
//   misplaced(facts, text)   "<count> next to <name>" when a delivery count stands by another entry's name (check() runs it per field)
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

// Hebrew usage on the site, given to the writer and to the copy editor (the trial drafts of 28.10 slipped on exactly these)
const HEBREW = `Hebrew usage on this site:
- Call the vehicles רכבים throughout (רכבים פרטיים חדשים, 970 רכבי יונדאי KONA HYBRID), as the rest of the site does, not כלי רכב or מכוניות.
- A maker is feminine, as a company: טויוטה הובילה, ואחריה צ'רי, ואחריה באה טויוטה; in a question, איזו יצרנית.
- A model agrees most simply through the word דגם: הדגם JAECOO 5 HEV הוביל, or JAECOO 5 HEV היה הדגם הנמסר ביותר; never a bare "נמכר ביותר".
- A body type is named as רכבי פנאי-שטח, רכבי הצ'בק, רכבי סדאן (or במרכב פנאי-שטח); never "מרכב פנאי-שטח נמסרו", and never ההצ'בק.
- A runner-up follows directly: ואחריו MG S9 עם 971 מסירות, not "אחריו נמצא".`;

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
4. Every delivery count stands right by its own name: after it in the same clause ("טויוטה הובילה עם 2,687 מסירות"; "אחריה צ'רי עם 2,065 ו-JAECOO עם 2,011"), or just before it with a word like רכבי between ("970 רכבי יונדאי KONA HYBRID").

Also:
5. Write every model and maker name exactly as the facts spell it, letter for letter, in the same script and the same capitals: "טסלה MODEL Y", not "Tesla Model Y" or "טסלה מודל Y". The page links these names to the models' own pages. A Hebrew prefix letter goes straight onto a Hebrew word (בטויוטה); before Latin letters or digits it takes a hyphen (ב-MG S9).
6. Be even-handed about every maker, importer and dealer: report their figures without praising or criticising anyone, with measured verbs (נמסרו, עלה, ירד, הוביל), never dramatic ones (זינק, קרס, צנח, שבר שיא).
7. Clear, correct, natural Hebrew in the register of a news report: full sentences, the past tense for the month's figures, and varied sentence openings. No exclamation marks, no emoji, no rhetorical questions, no English words other than the names, and do not address the reader; where people have to be mentioned, use neutral forms such as the plural. Before you answer, check the spelling, the agreement in gender and number, and the punctuation of every sentence.
8. Do not mention sources, websites, the app, or how the text was written.

${HEBREW}`;

export const EDIT_SYSTEM = `You are the Hebrew copy editor of the magazine of לוחית (luchit.app), an Israeli site that checks cars by licence plate. You get the facts and a draft of the text of the monthly article on new private-car deliveries in Israel, already checked against those facts. Edit the language only, as a careful editor of a Hebrew news site would: grammar, agreement in gender and number, prepositions, word order, clumsy or unidiomatic phrasing, punctuation and spelling. Read every sentence as a native reader would and fix whatever makes that reader stumble; leave a sentence exactly as it is when it is already correct and natural.

Change nothing else:
- Keep every number exactly as written, in the same field, right by the same name.
- Keep every model, maker and body-type name letter for letter, in the same script and the same capitals.
- Keep every fact and the meaning of every sentence: add no information, no sentence and no question, and remove none.
- Keep the same fields, exactly 3 tldr sentences, and the same number of faq items.
- Keep the draft's restraint: no causes, explanations or forecasts, and none of these strings, even inside a longer word: ${FORBIDDEN_WORDS.join(", ")}; no dramatic verbs, no exclamation marks, no emoji, no English words other than the names, no addressing the reader, and no sources or websites.
Answer with all the fields, edited, as JSON.

${HEBREW}`;

export function editRequest(facts, draft) {
  const {lead, bodies_p, ytd_p, tldr, faq} = draft;
  return {model: MODEL, max_tokens: 16000, thinking: {type: "adaptive"}, output_config: {effort: EFFORT, format: {type: "json_schema", schema: SCHEMA}},
    system: EDIT_SYSTEM, messages: [{role: "user", content: `The facts the draft was written from:\n<facts>\n${JSON.stringify(facts, null, 1)}\n</facts>\n\nThe draft to edit:\n<draft>\n${JSON.stringify({lead, bodies_p, ytd_p, tldr, faq}, null, 1)}\n</draft>`}]};
}

// the names of the facts (models, makers, body types) where they stand in a text, as whole words: up to two Hebrew prefix letters and a
// hyphen may come before a name (וטויוטה, ו-JAECOO, ההצ'בק), no letter or digit after it, and the longest name wins (JAECOO 5 HEV over JAECOO)
const entries = facts => [...facts.top_models.map(m => [m.model, m.deliveries]), ...facts.top_makers.map(m => [m.maker, m.deliveries]), ...facts.top_body_types.map(b => [b.type, b.deliveries])];
function names(facts, text) {
  let occ = [];
  for (const [n] of entries(facts)) for (let i = text.indexOf(n); i >= 0; i = text.indexOf(n, i + 1))
    if (/(^|[^\p{L}\p{N}])[ובכלמשה]{0,2}-?$/u.test(text.slice(0, i)) && !/^[\p{L}\p{N}]/u.test(text.slice(i + n.length))) occ.push({s: i, e: i + n.length, n});
  return occ.filter(o => !occ.some(p => p !== o && p.s <= o.s && p.e >= o.e && p.e - p.s > o.e - o.s));
}
const NUM = /\d[\d,.]*\d|\d/g;
// a delivery count belongs to the name before it in its clause, or to the name right after it when only a unit word stands between
// ("970 רכבי יונדאי KONA HYBRID", "22,373 רכבים מסוג פנאי-שטח"; never across a ו, which starts the next pair: "2,065 מסירות וטויוטה");
// a count with no name in its clause, or one two entries share, passes
const UNIT = /^(?:רכבי|רכבים|כלי רכב|מכוניות|מסירות)(?:\s+(?:מסוג|של|מדגם|מתוצרת))?\s*ה?$/;
export function misplaced(facts, text) {
  const owners = new Map(); for (const [n, v] of entries(facts)) owners.set(v, [...(owners.get(v) || []), n]);
  for (const clause of String(text).split(/[.;:?!](?=\s|$)|,\s+|\n/)) {
    const occ = names(facts, clause);
    for (const m of clause.matchAll(NUM)) {
      const ns = m.index, ne = ns + m[0].length, v = +m[0].replace(/,/g, "");
      if (!owners.has(v) || occ.some(o => o.s <= ns && o.e >= ne)) continue;   // not a delivery count, or a digit inside a name (RAV 4)
      const before = occ.filter(o => o.e <= ns).sort((a, b) => b.e - a.e)[0], after = occ.filter(o => o.s >= ne).sort((a, b) => a.s - b.s)[0];
      const near = after && UNIT.test(clause.slice(ne, after.s).trim()) ? after : before;
      if (near && !owners.get(v).includes(near.n)) return `${m[0]} next to ${near.n}`;
    }
  }
  return null;
}
// an edit keeps the draft's facts: the same item counts, and in every field the same numbers and the same names
const parts = a => [a.lead, a.bodies_p, a.ytd_p, ...a.tldr, ...a.faq.flatMap(x => [x.q, x.a])];
function sameFacts(facts, a, b) {
  if (!Array.isArray(b.tldr) || !Array.isArray(b.faq) || b.tldr.length !== a.tldr.length || b.faq.length !== a.faq.length || b.faq.some(x => !x)) return "the items changed";
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < pa.length; i++) {
    const nums = t => [...String(t ?? "").matchAll(NUM)].map(m => m[0].replace(/,/g, "")).sort().join(" ");
    const ns = t => [...new Set(names(facts, String(t ?? "")).map(o => o.n))].sort().join("|");
    if (nums(pa[i]) !== nums(pb[i])) return "a number changed";
    if (ns(pa[i]) !== ns(pb[i])) return "a name changed";
  }
  return "";
}

// what the check's reason means, said back to Claude on the second try
const HINT = {
  "bad tldr": "tldr must hold exactly 3 non-empty sentences, each under 200 characters",
  "bad faq": "faq must hold 3 or 4 items, each question under 150 characters and each answer under 350",
  "max_tokens": "the answer was cut off at the length limit", "no text": "the answer held no JSON object", "not JSON": "the answer was not a valid JSON object"
};
const hint = why => HINT[why] || (/^missing /.test(why) ? `the field ${why.slice(8)} was empty`
  : /^count /.test(why) ? `the delivery count ${why.slice(6).replace(" next to ", " stands by ")}, which is not the name it belongs to in the facts` : why);
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
  // the copy-edit call: kept only when it changed the language alone and still passes check(); any failure leaves the checked draft
  const edit = async () => {
    const r = await ask(api, editRequest(facts, out.draft));
    let why = "", b = null;
    if (r.error) why = r.error.why;
    else {
      const u = tokens(r.msg); out.usage.input += u.input; out.usage.output += u.output;
      const ans = answer(r.msg); why = ans.why;
      if (ans.text) {
        try { b = JSON.parse(ans.text); } catch { b = null; }
        if (!b || typeof b !== "object" || Array.isArray(b)) { b = null; why = "not JSON"; }
        else try { why = sameFacts(facts, out.draft, b) || check({...b, title}) || ""; } catch { why = "bad draft"; }
      }
    }
    out.attempts.push({why: why ? "edit: " + why : "edit ok", ...(keep && b ? {draft: b} : {})});
    if (!why) out.draft = {...b, title};
  };
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
    if (!bad) { out.draft = {...a, title}; await edit(); return out; }
    prev = bad;
    if (/^refusal/.test(bad)) break;   // asking again would only spend the call: the template writes it
  }
  out.why = prev;
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("magazine-ai.mjs") && process.argv.includes("--selftest")) {
  let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  const facts = {month: "ספטמבר 2026", total: 24162, same_month_last_year: 29206, change_percent_vs_last_year: 17, change_direction: "ירידה",
    top_models: [{model: "טסלה MODEL Y", deliveries: 1097}, {model: "MG S9", deliveries: 971}, {model: "JAECOO 5 HEV", deliveries: 879}, {model: "טויוטה RAV 4", deliveries: 776}],
    top_makers: [{maker: "טויוטה", deliveries: 2687}, {maker: "צ'רי", deliveries: 2065}, {maker: "JAECOO", deliveries: 2011}, {maker: "קיה", deliveries: 1500}],
    top_body_types: [{type: "פנאי-שטח", deliveries: 18442, share_percent: 76}, {type: "הצ'בק", deliveries: 2765, share_percent: 11}, {type: "סדאן", deliveries: 1610, share_percent: 7}],
    year_to_date: 1, year_to_date_last_year: 0, ytd_change_percent: null, ytd_direction: ""};
  const good = {lead: "נמסרו 24,162 רכבים, וטויוטה הובילה עם 2,687.", bodies_p: "רכבי פנאי-שטח היו 76% מהמסירות.", ytd_p: "", tldr: ["א.", "ב.", "ג."], faq: [{q: "ש?", a: "ת."}, {q: "ש?", a: "ת."}, {q: "ש?", a: "ת."}]};
  const edited = {...good, lead: "בספטמבר נמסרו 24,162 רכבים, וטויוטה הובילה עם 2,687 מסירות."};
  // the same kind of rules as magazine.mjs's check(), in small: numbers from a list, three tldr lines, and each count by its name
  const check = a => { if (!Array.isArray(a.tldr) || a.tldr.length !== 3) return "bad tldr";
    for (const m of JSON.stringify(a).matchAll(/\d[\d,.]*\d|\d/g)) if (!["24162", "2687", "76", "3"].includes(m[0].replace(/,/g, ""))) return "unknown number " + m[0];
    const w = misplaced(facts, a.lead); return w ? "count " + w : null; };
  const reply = (text, extra = {}) => ({stop_reason: "end_turn", content: [{type: "thinking", thinking: ""}, {type: "text", text}], usage: {input_tokens: 10, output_tokens: 5}, ...extra});
  const fake = replies => { const f = {calls: [], opts: null, messages: {create: async p => { f.calls.push(p); const r = replies[f.calls.length - 1]; if (r instanceof Error) throw r; return r; }}};
    f.withOptions = o => { f.opts = o; return f; }; return f; };
  const apiErr = (status, message = "x") => Object.assign(new Error(message), {status, error: {error: {type: status === 400 ? "invalid_request_error" : "error", message}}});
  const run = (replies, more = {}) => { const f = fake(replies); return prose({facts, title: "כותרת", check, env: {}, api: f, ...more}).then(r => [r, f]); };

  { const r = await prose({facts, title: "כותרת", check, env: {MAGAZINE_AI: "0", ANTHROPIC_API_KEY: "k"}, api: fake([])});
    ok(!r.draft && r.alert === "" && /MAGAZINE_AI=0/.test(r.why), "MAGAZINE_AI=0: no call, the template writes it"); }
  { const r = await prose({facts, title: "כותרת", check, env: {}});
    ok(!r.draft && r.alert === "" && r.why === "no ANTHROPIC_API_KEY", "no key: no call, and why says so"); }
  { const [r, f] = await run([reply(JSON.stringify(good)), reply(JSON.stringify(edited))]), p = f.calls[0], e = f.calls[1];
    ok(r.draft && r.draft.title === "כותרת" && r.draft.lead === edited.lead && r.alert === "ok" && r.why === "" && f.calls.length === 2 && r.attempts.map(x => x.why).join(",") === "ok,edit ok",
      "a good draft, then the copy edit: the edited text is used, with the data's title");
    ok(p.model === "claude-sonnet-5-5" && p.thinking.type === "adaptive" && p.output_config.effort === EFFORT && p.output_config.format.type === "json_schema"
      && p.output_config.format.schema === SCHEMA && !("temperature" in p) && !("top_p" in p) && p.max_tokens === 16000, "the request: the model, adaptive thinking, effort set, the JSON schema, no sampling parameters");
    ok(p.messages[0].content.includes('"total": 24162') && p.messages[0].content.includes("ספטמבר 2026") && !/discarded/.test(p.messages[0].content), "the facts go in the user message");
    ok(e.system === EDIT_SYSTEM && e.messages[0].content.includes("<draft>") && e.messages[0].content.includes(good.lead) && !e.messages[0].content.includes("כותרת")
      && e.output_config.format.schema === SCHEMA, "the copy edit gets the facts and the draft (not the title), and answers in the same schema");
    ok(f.opts && f.opts.timeout === 150000 && f.opts.maxRetries === 1, "a short timeout and one SDK retry for these calls");
    ok(FORBIDDEN_WORDS.every(w => SYSTEM.includes(w) && EDIT_SYSTEM.includes(w)) && SYSTEM.includes("טסלה MODEL Y") && SYSTEM.includes("ההצ'בק") && EDIT_SYSTEM.includes("נמכר ביותר"),
      "both prompts list every refused string and the Hebrew usage notes"); }
  for (const [what, b] of [["a number", {...good, lead: "נמסרו 24,162 רכבים, וטויוטה הובילה עם 76."}], ["a name", {...good, lead: "נמסרו 24,162 רכבים, וצ'רי הובילה עם 2,687."}],
    ["an item", {...good, faq: good.faq.slice(0, 2)}], ["the rules", {...good, tldr: ["א.", "ב.", "ג."], lead: "נמסרו 24,162 רכבים, וטויוטה הובילה עם 2,687 בגלל המחיר."}]]) {
    const strict = a => (/בגלל/.test(a.lead) ? "forbidden wording בגלל" : check(a));
    const f = fake([reply(JSON.stringify(good)), reply(JSON.stringify(b))]), r = await prose({facts, title: "כותרת", check: strict, env: {}, api: f});
    ok(r.draft && r.draft.lead === good.lead && r.draft.faq.length === 3 && /^edit: /.test(r.attempts[1].why) && r.why === "", `an edit that changes ${what}: the checked draft goes as it is (${r.attempts[1].why})`);
  }
  { const [r] = await run([reply(JSON.stringify(good)), apiErr(529, "Overloaded")]);
    ok(r.draft && r.draft.lead === good.lead && r.alert === "ok" && r.attempts[1].why === "edit: 529 server", "the copy edit fails at the API: the checked draft, and the alerts still close"); }
  { const [r, f] = await run([reply(JSON.stringify({...good, lead: "נמסרו 99 רכבים."})), reply(JSON.stringify(good)), reply(JSON.stringify(edited))]);
    ok(r.draft && f.calls.length === 3 && f.calls[1].messages[0].content.includes("unknown number 99") && r.attempts[0].why === "unknown number 99" && !r.attempts[0].draft,
      "a rejected draft: asked once more with the reason; the draft itself is kept only for the comparison run"); }
  { const [r, f] = await run([reply(JSON.stringify({...good, lead: "צ'רי הובילה עם 2,687 מסירות."})), reply(JSON.stringify(good))]);
    ok(r.draft && r.attempts[0].why === "count 2,687 next to צ'רי" && f.calls[1].messages[0].content.includes("the delivery count 2,687 stands by צ'רי, which is not the name it belongs to"),
      "a count by the wrong name: rejected, and the retry says which"); }
  { const [r, f] = await run([reply(JSON.stringify({...good, tldr: ["א."]})), reply(JSON.stringify({...good, tldr: ["א."]}))], {keep: true});
    ok(!r.draft && r.why === "bad tldr" && r.alert === "ok" && f.calls.length === 2 && f.calls[1].messages[0].content.includes("exactly 3 non-empty sentences") && r.attempts.length === 2 && r.attempts[1].draft.tldr.length === 1,
      "two rejected drafts: the template, no copy edit, and the API counts as answered (the alerts close)"); }
  { const [r, f] = await run([reply("", {stop_reason: "refusal", stop_details: {category: "general_harms"}, content: []}), reply(JSON.stringify(good))]);
    ok(!r.draft && r.why === "refusal general_harms" && f.calls.length === 1 && r.alert === "ok", "a refusal: no second call, the template writes it"); }
  { const [r, f] = await run([reply("{\"lead\":"), reply(JSON.stringify(good)), reply(JSON.stringify(edited))]);
    ok(r.draft && f.calls.length === 3 && f.calls[1].messages[0].content.includes("not a valid JSON object"), "broken JSON: asked once more"); }
  { const [r, f] = await run([reply("null"), reply("[1]")]);
    ok(!r.draft && r.why === "not JSON" && f.calls.length === 2, "JSON that is not an object: rejected"); }
  { const [r, f] = await run([reply(JSON.stringify(good)), reply(JSON.stringify(good))], {check: () => { throw new TypeError("x"); }});
    ok(!r.draft && r.why === "bad draft" && f.calls.length === 2, "a check that throws on an odd draft: rejected, never a crash"); }
  { const [r, f] = await run([apiErr(401, "invalid x-api-key")]);
    ok(!r.draft && r.alert === "key" && /^401 key/.test(r.why) && f.calls.length === 1, "401: ai:key, the template writes it"); }
  { const [r] = await run([apiErr(400, "Your credit balance is too low to access the Anthropic API.")]);
    ok(!r.draft && r.alert === "key", "the credit ran out: ai:key"); }
  { const [r, f] = await run([apiErr(529, "Overloaded")]);
    ok(!r.draft && r.alert === "mag" && r.why === "529 server" && f.calls.length === 1, "an overloaded API: ai:mag (quiet), the template writes it"); }
  { const [r] = await run([reply(JSON.stringify(good)), reply(JSON.stringify(edited))]);
    ok(r.usage.input === 20 && r.usage.output === 10 && !JSON.stringify(r.attempts).includes("10"), "token counts of both calls stay in usage, out of the attempts"); }
  // each delivery count by its own name, in the phrasings the trial drafts used, and the swaps the check is there for
  const fine = ["אחריהם נמסרו 2,765 רכבי הצ'בק (11%) ו-1,610 רכבי סדאן (7%).", "JAECOO הובילה עם 2,011 מסירות, ו-JAECOO 5 HEV היה הדגם המוביל, עם 879 מסירות.",
    "אחריה צ'רי עם 2,065 מסירות וטויוטה עם 2,687.", "ואחריו נמסרו 971 רכבי MG S9.", "נמסרו 18,442 רכבים מסוג פנאי-שטח.", "טויוטה RAV 4 עם 776 רכבים.",
    "נמסרו 24,162 רכבים, ירידה של כ-17%.", "באוגוסט נמסרו 1,500 רכבים בטורקיה ו-971 בישראל."];
  ok(fine.every(t => misplaced(facts, t) === null), "counts by their own names pass: before the name with רכבי, after it, two in one clause, a digit inside a name, no name, and a name inside a longer word");
  const swaps = [["טויוטה הובילה עם 2,065 מסירות, ואחריה צ'רי עם 2,687.", "2,065 next to טויוטה"], ["טסלה MODEL Y הובילה עם 2,011 מסירות.", "2,011 next to טסלה MODEL Y"],
    ["אחריה צ'רי עם 2,687 וטויוטה עם 2,065.", "2,687 next to צ'רי"], ["נמסרו 2,765 רכבי סדאן.", "2,765 next to סדאן"], ["JAECOO עם 879 מסירות.", "879 next to JAECOO"]];
  ok(swaps.every(([t, w]) => misplaced(facts, t) === w), "a count by another entry's name is caught, also a maker beside its own model's count");
  console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
}
