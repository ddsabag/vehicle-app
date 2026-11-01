// Claude API calls for the bots (the monthly API credit, Console workspace luchit-bots, repo secret ANTHROPIC_API_KEY; plan of 28.10.2026).
// One helper for every bot that uses it, so each gets the same fallback: no key, no SDK or an API error leaves the caller with no client or
// an {error} it reads (no call here throws), and the bot keeps doing what it did before (never a red run over it). Nothing here prints the
// key, a cost or a token count: the logs are public, and the Console's Cost page has the spend.
//   client(env, {timeout})       {api, why}: api is null when the key or the SDK is missing, and why says which; timeout: ms per request
//                                (the SDK's own is 10 minutes: a bot inside a short job sets less)
//   ask(api, params)             one messages.create: {msg} | {error}
//   batch(api, requests, opt)    submits a Message Batch and waits for it up to opt.minutes: {id, ended, results} (results once ended) | {error}
//   collect(api, id, opt)        the same wait for a batch an earlier run submitted: {ended, results} | {error}
//                                opt.cancel: at the deadline the batch is cancelled and what it finished is collected (the rest "canceled")
//                                results: Map custom_id -> {ok: true, msg} | {ok: false, why} (a batch's results come in any order;
//                                why is "errored <type>", "expired" or "canceled")
//   answer(msg)                  {text, why}: the reply's text, or why there is none (a refusal and its category, max_tokens, no text)
//   usage(msg)                   {input, output, cacheRead, cacheWrite} tokens of one reply, for a bot that keeps its own cap (never log it)
//   error: {why, key}            why: a short reason safe in a public log ("401 key", "429 rate", "network"); key: the key or the money is
//                                the cause (401, 403, 402 billing, or a 400 that says the credit balance is too low), so the caller raises ai:key, which
//                                needs Dudu (paste the key again, or decide about the cap); any other failure is the bot's own ai:<bot>
//                                (router families agreed with ops 28.10); reason(e) and keyTrouble(e) give the same for a caught error
// The workflow installs the SDK (npm install --no-save, the version in SDK); the app never loads it.
//   node claude.mjs --selftest   offline: the fallbacks, the error reasons, reading a reply, and a batch through a fake API
export const SDK = "@anthropic-ai/sdk@0.133.0";
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function client(env = process.env, { timeout } = {}) {
  if (!env.ANTHROPIC_API_KEY) return { api: null, why: "no ANTHROPIC_API_KEY" };
  let Anthropic;
  try { Anthropic = (await import("@anthropic-ai/sdk")).default; } catch { return { api: null, why: `the SDK is not installed (${SDK})` }; }
  return { api: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 3, ...(timeout > 0 ? { timeout } : {}) }), why: "" };
}

// an API message can carry a number (a token count, or a request's own text if it ever echoed one): long digit runs leave the log as "#"
const scrub = t => String(t).replace(/\d[\d,.\-]{3,}\d/g, "#");

export function reason(e) {
  const s = e && e.status, body = e && e.error && e.error.error, text = body && body.message ? ": " + scrub(body.message).slice(0, 120) : "";
  if (s === 401 || s === 403) return `${s} key${text}`;   // a wrong or revoked key, or a workspace without access
  if (s === 402) return `402 billing${text}`;   // the API's billing_error: the money, like a spent credit
  if (s === 429) return "429 rate";
  if (s >= 500) return `${s} server`;
  if (s) return `${s} ${(body && body.type) || "request"}${text}`;   // 400 also when the month's credit has run out
  return /timeout/i.test(String(e && (e.name + " " + e.message))) ? "timeout" : "network";
}

export function keyTrouble(e) {
  const s = e && e.status, m = String((e && e.error && e.error.error && e.error.error.message) || (e && e.message) || "");
  return s === 401 || s === 402 || s === 403 || (s === 400 && /credit balance/i.test(m));
}

export function answer(msg) {
  if (!msg) return { text: "", why: "no reply" };
  if (msg.stop_reason === "refusal") return { text: "", why: "refusal" + (msg.stop_details && msg.stop_details.category ? " " + msg.stop_details.category : "") };
  if (msg.stop_reason === "max_tokens") return { text: "", why: "max_tokens" };
  const text = (msg.content || []).filter(b => b.type === "text").map(b => b.text).join("");   // a reply can start with thinking blocks
  return text ? { text, why: "" } : { text: "", why: "no text" };
}

export const usage = msg => { const u = (msg && msg.usage) || {}; return { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 }; };
const fail = e => ({ error: { why: reason(e), key: keyTrouble(e) } });

export async function ask(api, params) {
  try { return { msg: await api.messages.create(params) }; } catch (e) { return fail(e); }
}

async function ended(api, id, minutes, every) {
  const until = Date.now() + minutes * 60000;
  for (;;) {
    if ((await api.messages.batches.retrieve(id)).processing_status === "ended") return true;
    if (Date.now() + every * 1000 > until) return false;
    await sleep(every * 1000);
  }
}
async function results(api, id) {
  const out = new Map();
  for await (const r of await api.messages.batches.results(id)) {
    const res = r.result || {}, err = res.error && (res.error.error || res.error);
    out.set(r.custom_id, res.type === "succeeded" ? { ok: true, msg: res.message } : { ok: false, why: res.type === "errored" ? `errored ${(err && err.type) || ""}`.trim() : String(res.type) });
  }
  return out;
}
async function finish(api, id, { minutes = 0, every = 30, cancel = false }) {
  if (await ended(api, id, minutes, every)) return { ended: true, results: await results(api, id) };
  if (!cancel) return { ended: false };
  await api.messages.batches.cancel(id);   // what is still running stops; the finished requests keep their results
  return await ended(api, id, 10, Math.min(every, 15)) ? { ended: true, results: await results(api, id) } : { ended: false };
}

export async function batch(api, requests, { minutes = 50, every = 30, cancel = false } = {}) {
  let id;
  try { id = (await api.messages.batches.create({ requests })).id; } catch (e) { return fail(e); }
  try { return { id, ...await finish(api, id, { minutes, every, cancel }) }; } catch (e) { return { id, ended: false, ...fail(e) }; }
}
export async function collect(api, id, { minutes = 0, every = 30, cancel = false } = {}) {
  try { return await finish(api, id, { minutes, every, cancel }); } catch (e) { return fail(e); }
}

if (process.argv[1] && process.argv[1].endsWith("claude.mjs") && process.argv.includes("--selftest")) {
  let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  ok((await client({})).api === null && (await client({})).why === "no ANTHROPIC_API_KEY", "no key: no client, and why says so");
  { const c = await client({ ANTHROPIC_API_KEY: "test" }); ok(c.api ? c.why === "" : /SDK is not installed/.test(c.why), "a key without the SDK installed: no client either (the bot keeps today's behaviour)"); }
  { const c = await client({ ANTHROPIC_API_KEY: "test" }, { timeout: 120000 }); ok(c.api ? c.api.timeout === 120000 : /SDK is not installed/.test(c.why), "a bot's own timeout per request"); }
  ok(reason({ status: 401 }) === "401 key" && reason({ status: 429 }) === "429 rate" && reason({ status: 529 }) === "529 server", "error reasons by status");
  ok(reason({ status: 400, error: { error: { type: "invalid_request_error", message: "Your credit balance is too low to access the API" } } }) === "400 invalid_request_error: Your credit balance is too low to access the API", "a 400 keeps its type and message (the month's credit ran out)");
  ok(reason({ status: 400, error: { error: { type: "invalid_request_error", message: "prompt is too long: 250,000 tokens; ref 12-345-67" } } }) === "400 invalid_request_error: prompt is too long: # tokens; ref #", "long numbers never reach the log");
  ok(reason({ name: "APIConnectionTimeoutError", message: "Request timed out." }) === "timeout" && reason(new Error("fetch failed")) === "network", "no status: timeout or network");
  ok(keyTrouble({ status: 401 }) && keyTrouble({ status: 402 }) && keyTrouble({ status: 403 }) && keyTrouble({ status: 400, error: { error: { type: "invalid_request_error", message: "Your credit balance is too low to access the API" } } })
    && reason({ status: 402, error: { error: { type: "billing_error", message: "x" } } }) === "402 billing: x", "the key or the money (402 billing too): ai:key");
  ok(!keyTrouble({ status: 400, error: { error: { type: "invalid_request_error", message: "max_tokens: too large" } } }) && !keyTrouble({ status: 429 }) && !keyTrouble({ status: 500 }) && !keyTrouble(new Error("fetch failed")), "anything else: the bot's own key");
  ok(answer({ stop_reason: "refusal", stop_details: { category: "general_harms" }, content: [] }).why === "refusal general_harms", "a refusal is no answer, with its category");
  ok(answer({ stop_reason: "max_tokens", content: [{ type: "text", text: "{\"a\":" }] }).why === "max_tokens", "a reply cut at max_tokens is no answer");
  ok(answer({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "שלום" }] }).text === "שלום", "the text after a thinking block");
  ok(answer({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }] }).why === "no text" && answer(null).why === "no reply", "no text, no reply");
  // a fake API: the batch ends on the third look; one request succeeds, one errors, one expires
  const looks = { n: 0 }, sent = [];
  const fake = { messages: { batches: {
    create: async ({ requests }) => { sent.push(...requests); return { id: "msgbatch_1", processing_status: "in_progress" }; },
    retrieve: async id => ({ id, processing_status: ++looks.n >= 3 ? "ended" : "in_progress" }),
    results: async () => (async function* () {
      yield { custom_id: "b", result: { type: "errored", error: { type: "error", error: { type: "invalid_request_error", message: "x" } } } };
      yield { custom_id: "a", result: { type: "succeeded", message: { stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] } } };
      yield { custom_id: "c", result: { type: "expired" } };
    })(),
  } } };
  const reqs = ["a", "b", "c"].map(custom_id => ({ custom_id, params: { model: "m", max_tokens: 10, messages: [{ role: "user", content: "x" }] } }));
  const first = await batch(fake, reqs, { minutes: 0, every: 0.01 });
  ok(sent.length === 3 && first.id === "msgbatch_1" && first.ended === false && !first.results, "not ended within the wait: the id comes back for the next run");
  const later = await collect(fake, first.id, { minutes: 1, every: 0.01 });
  ok(later.ended && later.results.size === 3 && later.results.get("a").ok && answer(later.results.get("a").msg).text === "{}", "collected later, keyed by custom_id");
  ok(later.results.get("b").ok === false && later.results.get("b").why === "errored invalid_request_error" && later.results.get("c").why === "expired", "an errored and an expired request say why");
  const boom = st => async () => { const e = new Error("boom"); e.status = st; if (st === 400) e.error = { error: { type: "invalid_request_error", message: "Your credit balance is too low" } }; throw e; };
  ok((await ask({ messages: { create: async p => ({ stop_reason: "end_turn", content: [{ type: "text", text: p.messages[0].content }], usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 5 } }) } }, { messages: [{ role: "user", content: "x" }] })).msg.content[0].text === "x", "ask: one call, the reply back");
  { const r = await ask({ messages: { create: boom(529) } }, {}); ok(!r.msg && r.error.why === "529 server" && r.error.key === false, "ask: an API error is an {error}, not a throw"); }
  { const r = await ask({ messages: { create: boom(400) } }, {}); ok(r.error.key === true && /^400 invalid_request_error: Your credit balance/.test(r.error.why), "ask: the credit ran out is the key's problem (ai:key)"); }
  { const r = await batch({ messages: { batches: { create: boom(401) } } }, reqs); ok(!r.id && r.error.why === "401 key" && r.error.key === true, "batch: a refused create is an {error}"); }
  { const r = await collect({ messages: { batches: { retrieve: boom(500) } } }, "msgbatch_1"); ok(r.error && r.error.why === "500 server", "collect: an error while waiting is an {error}"); }
  { const st = { cancelled: false };
    const slow = { messages: { batches: { create: async () => ({ id: "msgbatch_2" }), retrieve: async id => ({ id, processing_status: st.cancelled ? "ended" : "in_progress" }), cancel: async () => { st.cancelled = true; },
      results: async () => (async function* () { yield { custom_id: "a", result: { type: "succeeded", message: { stop_reason: "end_turn", content: [{ type: "text", text: "x" }] } } }; yield { custom_id: "b", result: { type: "canceled" } }; })() } } };
    const r = await batch(slow, reqs.slice(0, 2), { minutes: 0, every: 0.01, cancel: true });
    ok(st.cancelled && r.ended && r.results.get("a").ok && r.results.get("b").why === "canceled", "cancel at the deadline: the finished requests come back, the rest are canceled"); }
  ok(JSON.stringify(usage({ usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 5 } })) === JSON.stringify({ input: 7, output: 2, cacheRead: 5, cacheWrite: 0 }) && usage(null).input === 0, "usage of one reply");
  console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
}
