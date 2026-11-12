// Kit draft (marketing thread; Dudu approved 1.11.2026 21:16 UTC, monthly API credit package A5): the night before the weekly content kit
// (Thursday 10:22 Israel), Claude drafts the kit's texts from the same verified facts the kit uses, so the Thursday run reviews, renders and
// films instead of writing from nothing. A draft only: nothing here posts, queues or renders; the Thursday run reads every line, runs the
// full lint again on the finished kit and decides.
//   1. ideas.mjs (the factory's, from branch kit-factory) on this checkout: the week's verified facts (public data only: no Search Console,
//      no campaign snapshot, so no private number can reach the draft)
//   2. one request to claude-opus-5-5 (effort medium): the RUNBOOK as the cached instruction, rotation.json for the week's pillars, ideas,
//      and the last kit as the example of the format; it answers one JSON object (pain, picks, the facts it uses by idea and index, kit.json,
//      the reel script, caption bodies)
//   3. the draft folder: kit.json, facts.json (built here from ideas.json, never retyped by the model), reel.json, captions.json, draft.md
//   4. lint.mjs (the factory's) on the folder; the copy violations go back to the model, at most FIX_ROUNDS times; what is left is listed in
//      draft.md for the Thursday run
// Output: --out DIR (the workflow puts it on branch kit-draft-out, folder draft-<Thursday date>/). The repo is public: the draft holds only
// copy built from public data, never a token count or a cost.
// No key, KIT_DRAFT=off or an API error: no draft (the Thursday run writes as before); an API error tells the router ai:kitdraft (summary),
// or ai:key (day) when the key or the credit is the cause; a good run closes both. Only a crash of this script is red (Failure alert).
// Node 20, node: builtins and ./claude.mjs. Commands:
//   node kit-draft.mjs --factory DIR --repo DIR --catalog DIR --out DIR [--date YYYY-MM-DD]
//   node kit-draft.mjs --selftest     offline: a fake factory and a fake API
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as claude from "./claude.mjs";

export const MODEL = "claude-opus-5-5";
export const FIX_ROUNDS = 3;
// lint violations about the kit's shape (files the Thursday run makes: the kit markdown, the PNGs, the extension prompt) are not the draft's
const SHAPE_RULES = new Set(["extension-prompt"]);
const DRAFT_FILES = new Set(["kit.json", "facts.json", "reel.json", "captions.json", "draft.md"]);

const IO = { env: process.env, out: s => process.stdout.write(s + "\n"), claude, router: () => import("./alert.mjs"), tg: () => import("./tg-text.mjs"),
  run: (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...opt }) };
const J = s => { try { return JSON.parse(s); } catch { return null; } };
const readJ = f => { try { return J(fs.readFileSync(f, "utf8")); } catch { return null; } };
const ilDate = t => new Date(t).toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });

export function nextThursday(now = Date.now()) {
  for (let d = 1; d <= 7; d++) { const s = ilDate(now + d * 864e5); if (new Date(s + "T12:00:00Z").getUTCDay() === 4) return s; }
  return ilDate(now + 864e5);
}

// the week's slots, exactly as RUNBOOK step 3 reads rotation.json
export function slots(rot) {
  const o = rot.order, c = rot.cursor, reel = o[c % o.length];
  return { kit: rot.last_kit + 1, reel, carousel: o[(c + 1) % o.length], stories: reel === "Community" ? "Trust & Safety" : "Community",
    dealer: { pillar: "B2B utility", angle: rot.dealer_angles[rot.dealer_angle_cursor % rot.dealer_angles.length] },
    last: (rot.history || []).slice(-3) };
}

const PREFACE = `You draft the weekly content kit of לוחית (an Israeli app: car check by licence plate from the Ministry of Transport's open data). Your draft is reviewed line by line by the marketing thread the next morning, then rendered, filmed and linted again. Follow the RUNBOOK below (it wins over anything else here) and these iron rules:
- Golden rule: dealers, trade-in companies, importers and fleet managers are customers, never villains. No exposing, catching or "what the dealer won't tell you". The enemy is uncertainty and surprises.
- Only features live in Google Play production (the RUNBOOK and ideas say which version). No feature before it is live.
- Every number comes from a fact you cite (idea id and fact index). No other number anywhere, not even in a caption or a script line. Estimates say "(הערכה)"; settlements say "ייתכן".
- Demo plate only: 76-543-21 (7654321). Never 12-345-67 or 1234567, not even as an input hint.
- No winner, recommended, best or bargain wording. Never name or attack a competitor.
- Neutral Hebrew for the reader (no gendered imperative or present tense; plural forms like "בודקים", "מקלידים"); Dudu's own voice only in past or future first person.
- Hook-Story-Offer: the first line presses on the week's pain; the middle is a fact or a scenario; the end is one action: enter a licence plate in לוחית.
- Captions: only the body. The thread adds the link line, "לוחית זמינה להורדה ב-Google Play" and the format of each network; give the hashtags and the go/ link topic (letters and _ only).`;

const CONTRACT = `Answer with one JSON object and nothing else:
{"pain": "the week's pain point, a few Hebrew words", "pain_why": "one paragraph (English) on why it works on Israelis this week",
 "picks": {"reel": {"pillar", "idea", "title"}, "carousel": {...}, "stories": {...}, "dealer": {"pillar", "angle", "idea", "title"}},
 "facts": [{"idea": "<idea id>", "index": <index in that idea's facts>}],   (every fact any number in your copy rests on, nothing else)
 "kit": { kit.json in exactly the last kit's format (carousel, stories, dealer; same templates and fields), with "kit" and "date" },
 "reel": {"title", "pillar", "lines": [{"vo": "voice-over line", "screen": "on-screen text or empty", "visual": "what is shown (English)"}]},   (about 30 seconds: 6-9 lines)
 "captions": {"reel": {"body", "hashtags", "topic"}, "carousel": {...}, "dealer": {...}, "stories": {"topic"}},
 "notes": ["anything the reviewer must check, in English: a caution you followed, a version a feature needs, a doubt"]}`;

export function request({ runbook, rot, ideas, last, date }) {
  const s = slots(rot);
  const ctx = { thursday: date, kit_number: s.kit, slots: s, ideas: { generated: ideas.generated, recall_max_id: ideas.recall_max_id, ideas: ideas.ideas, warnings: ideas.warnings },
    last_kit_example: last };
  return { model: MODEL, max_tokens: 48000, output_config: { effort: "medium" },
    system: [{ type: "text", text: `${PREFACE}\n\n=== RUNBOOK.md ===\n${runbook}`, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: `Context (JSON):\n${JSON.stringify(ctx)}\n\nDraft kit ${s.kit} for Thursday ${date}. Do not repeat the pains of the last kits unless the data is new.\n\n${CONTRACT}` }] }] };
}

export function parse(text) {
  const t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const o = J(t) ?? J(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
  if (!o || typeof o !== "object") return { why: "the answer is not JSON" };
  for (const k of ["kit", "reel", "captions", "facts", "picks"]) if (!o[k]) return { why: `the answer has no ${k}` };
  if (!Array.isArray(o.facts)) return { why: "facts is not a list" };
  return { draft: o };
}

// facts.json from ideas.json by reference: the model never retypes a fact
export function factsFile(draft, ideas, kit) {
  const by = new Map(ideas.ideas.map(i => [i.id, i])), out = [], bad = [];
  for (const r of draft.facts) {
    const f = by.get(r.idea)?.facts?.[r.index];
    if (f) { if (!out.includes(f)) out.push(f); } else bad.push(`${r.idea}#${r.index}`);
  }
  return { file: { kit, repo_commit: ideas.repo?.commit || "", facts: out }, bad };
}

export function writeDraft(dir, draft, ideas, kit, date) {
  fs.mkdirSync(dir, { recursive: true });
  const { file, bad } = factsFile(draft, ideas, kit);
  const put = (n, v) => fs.writeFileSync(path.join(dir, n), typeof v === "string" ? v : JSON.stringify(v, null, 1) + "\n");
  put("kit.json", { ...draft.kit, kit, date });
  put("facts.json", file);
  put("reel.json", draft.reel);
  put("captions.json", draft.captions);
  return bad;
}

// the copy violations of the draft folder (lint --json); shape violations (the files Thursday makes) are left out
export function copyViolations(res) {
  return (res?.violations || []).filter(v => !SHAPE_RULES.has(v.rule) && (DRAFT_FILES.has(path.basename(String(v.file))) || v.file === "facts.json"));
}

function lint(factory, dir, repo) {
  let out = "";
  try { out = IO.run("node", [path.join(factory, "lint.mjs"), dir, "--repo", repo, "--json"]); }
  catch (e) { out = String(e.stdout || ""); }   // exit 1 = violations, with the JSON on stdout
  return J(out);
}

function md({ draft, date, kit, bad, left, rounds, model }) {
  const p = draft.picks || {}, line = k => p[k] ? `- ${k}: ${p[k].pillar || ""}${p[k].angle ? ` (${p[k].angle})` : ""}: ${p[k].title || ""} [${p[k].idea || ""}]` : "";
  return [`# טיוטת ערכה ${kit} ליום חמישי ${date}`, "",
    `Draft by ${model} the night before. Review every line; the Thursday run renders, films, lints the whole kit and decides.`, "",
    `## Pain`, draft.pain || "", "", draft.pain_why || "", "", `## Picks`, ...["reel", "carousel", "stories", "dealer"].map(line).filter(Boolean), "",
    `## Lint (copy only)`, left.length ? `${left.length} copy violations left after ${rounds} fix rounds:` : `Clean after ${rounds} fix round(s).`,
    ...left.map(v => `- ${v.rule} · ${v.file}${v.line ? ":" + v.line : ""}: ${v.en}${v.snippet ? ` (${v.snippet})` : ""}`),
    ...(bad.length ? ["", `Facts cited that are not in ideas.json (dropped): ${bad.join(", ")}`] : []), "",
    `## Notes`, ...(draft.notes || []).map(n => `- ${n}`), ""].join("\n");
}

async function tell(kind, why) {
  let router, tg; try { router = await IO.router(); tg = await IO.tg(); } catch { return; }
  if (kind === "key") await router.alert("day", "ai:key", tg.msg({ kind: "today", area: "bots", title: "מפתח ה-Claude API לא עובד או שהקרדיט נגמר",
    text: "טיוטת הערכה השבועית לא נכתבה, והערכה של יום חמישי תיכתב כרגיל.", what: "להדביק מחדש את המפתח או להחליט על הקרדיט", raw: why }));
  else if (kind === "fail") await router.alert("summary", "ai:kitdraft", tg.msg({ kind: "info", area: "marketing", title: "טיוטת הערכה השבועית לא נכתבה",
    text: "הערכה של יום חמישי תיכתב כרגיל, בלי טיוטה.", raw: why }));
  else await router.resolve(["ai:kitdraft", "ai:key"]);
}

export async function main(o) {
  const env = IO.env, say = IO.out, summary = t => { if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, t + "\n"); };
  const stop = t => { say(`::notice title=Kit draft::skipped: ${t}`); summary(`### Kit draft\n\nSkipped: ${t}.\n`); return 0; };
  if (env.KIT_DRAFT === "off") return stop("KIT_DRAFT=off");
  const F = o.factory, cf = n => path.join(F, n);
  for (const n of ["ideas.mjs", "lint.mjs", "RUNBOOK.md", "rotation.json"]) if (!fs.existsSync(cf(n))) return stop(`no ${n} in the factory snapshot`);
  const { api, why } = await IO.claude.client(env, { timeout: 15 * 60000 });
  if (!api) return stop(why);
  const rot = readJ(cf("rotation.json")), runbook = fs.readFileSync(cf("RUNBOOK.md"), "utf8"), date = o.date || nextThursday();
  // ideas: public data only, with the recall baseline of the last kit
  const since = (rot.history || []).at(-1)?.recall_max_id;
  const ia = [cf("ideas.mjs"), o.repo, "--out", path.join(o.out, "ideas.json"), ...(o.catalog ? ["--catalog", o.catalog] : []), ...(since ? ["--recall-since", String(since)] : [])];
  fs.mkdirSync(o.out, { recursive: true });
  IO.run("node", ia, { stdio: ["ignore", "ignore", "inherit"] });
  const ideas = readJ(path.join(o.out, "ideas.json"));
  if (!ideas?.ideas?.length) return stop("ideas.mjs gave no ideas");
  const lastDir = cf("examples/last-kit"), last = { kit: readJ(path.join(lastDir, "kit.json")), autopost: readJ(path.join(lastDir, "autopost.json")) };
  const req = request({ runbook, rot, ideas, last, date }), kit = slots(rot).kit, dir = path.join(o.out, `draft-${date}`);
  const msgs = req.messages;
  let draft = null, left = [], bad = [], rounds = 0;
  for (let round = 0; round <= FIX_ROUNDS; round++) {
    const r = await IO.claude.ask(api, { ...req, messages: msgs });
    if (r.error) { await tell(r.error.key ? "key" : "fail", r.error.why); say(`::warning title=Kit draft::the API failed (${r.error.why}): no draft this week`); return 0; }
    const a = IO.claude.answer(r.msg), p = a.text ? parse(a.text) : { why: a.why };
    if (!p.draft) {
      if (round === FIX_ROUNDS || !a.text) { await tell("fail", p.why); say(`::warning title=Kit draft::${p.why}: no draft this week`); return 0; }
      msgs.push({ role: "assistant", content: a.text }, { role: "user", content: `${p.why}. Answer again with the whole JSON object only.` });
      continue;
    }
    draft = p.draft; rounds = round;
    fs.rmSync(dir, { recursive: true, force: true });
    bad = writeDraft(dir, draft, ideas, kit, date);
    const res = lint(F, dir, o.repo);
    left = res ? copyViolations(res) : [{ rule: "lint", file: "-", en: "the lint gave no JSON" }];
    if (bad.length) left.push({ rule: "facts", file: "facts.json", en: `cited facts that do not exist: ${bad.join(", ")}` });
    if (!left.length || round === FIX_ROUNDS) break;
    msgs.push({ role: "assistant", content: a.text }, { role: "user", content: `The kit lint found these copy violations (file, rule, what, snippet):\n${left.map(v => `- ${v.file}${v.line ? ":" + v.line : ""} · ${v.rule}: ${v.en}${v.detail ? " · " + v.detail : ""}${v.snippet ? " · «" + v.snippet + "»" : ""}`).join("\n")}\nFix each one (do not just delete content the kit needs) and answer the whole JSON object again.` });
  }
  fs.writeFileSync(path.join(dir, "draft.md"), md({ draft, date, kit, bad, left, rounds, model: MODEL }));
  await tell("ok");
  say(`::notice title=Kit draft::kit ${kit} for ${date}: ${left.length ? left.length + " copy violations left" : "lint clean (copy)"} after ${rounds} fix round(s)`);
  summary(`### Kit draft\n\nKit ${kit} for Thursday ${date}: ${left.length ? left.length + " copy violations left" : "copy lint clean"}, ${rounds} fix round(s).\n`);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `wrote=1\ndir=draft-${date}\n`);
  return 0;
}

// ---------- selftest (offline) ----------
async function selftest() {
  let n = 0, bad = 0; const ok = (c, m) => { n++; if (!c) { bad++; console.log("FAIL " + m); } };
  const os = await import("node:os"), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kd-"));
  ok(nextThursday(Date.parse("2026-11-04T20:40:00Z")) === "2026-11-05", "Wednesday night -> the next day's Thursday");
  ok(nextThursday(Date.parse("2026-11-05T12:00:00Z")) === "2026-11-12", "on a Thursday -> the next week's");
  const rot = { order: ["Trust & Safety", "Efficiency/compare", "Community", "B2B utility"], cursor: 2, last_kit: 3, dealer_angles: ["a", "b", "c", "d"], dealer_angle_cursor: 3, history: [{ recall_max_id: 5 }] };
  const s = slots(rot);
  ok(s.kit === 4 && s.reel === "Community" && s.carousel === "B2B utility" && s.stories === "Trust & Safety" && s.dealer.angle === "d", "slots follow RUNBOOK step 3");
  ok(parse("```json\n{\"kit\":{},\"reel\":{},\"captions\":{},\"facts\":[],\"picks\":{}}\n```").draft, "a fenced JSON answer parses");
  ok(parse("no").why && parse('{"kit":{}}').why === "the answer has no reel", "a broken answer says why");
  const ideas = { repo: { commit: "abc" }, ideas: [{ id: "x", facts: [{ text: "f0", value: 1 }, { text: "f1", value: 2 }] }] };
  const fx = factsFile({ facts: [{ idea: "x", index: 1 }, { idea: "x", index: 1 }, { idea: "y", index: 0 }] }, ideas, 4);
  ok(fx.file.facts.length === 1 && fx.file.facts[0].text === "f1" && fx.bad[0] === "y#0" && fx.file.repo_commit === "abc", "facts come from ideas.json by reference, once each; a missing one is reported");
  ok(copyViolations({ violations: [{ rule: "extension-prompt", file: "." }, { rule: "banned", file: "/x/draft-1/captions.json" }, { rule: "banned", file: "src/kit.html" }] }).length === 1, "only the draft's own copy violations count");
  const r = request({ runbook: "RB", rot, ideas, last: {}, date: "2026-11-05" });
  ok(r.model === MODEL && r.output_config.effort === "medium" && r.system[0].cache_control && r.system[0].text.includes("RB") && !("temperature" in r), "one Opus request at medium effort, the RUNBOOK cached");
  // a whole run on a fake factory and a fake API: the first answer has a lint violation, the second is clean
  const F = path.join(tmp, "f"); fs.mkdirSync(path.join(F, "examples/last-kit"), { recursive: true });
  fs.writeFileSync(path.join(F, "RUNBOOK.md"), "rules"); fs.writeFileSync(path.join(F, "rotation.json"), JSON.stringify(rot));
  fs.writeFileSync(path.join(F, "ideas.mjs"), ""); fs.writeFileSync(path.join(F, "lint.mjs"), "");
  const answers = [{ kit: { carousel: {} }, reel: { lines: [] }, captions: { reel: { body: "מנצח" } }, facts: [{ idea: "x", index: 0 }], picks: {}, pain: "p" },
    { kit: { carousel: {} }, reel: { lines: [] }, captions: { reel: { body: "בודקים" } }, facts: [{ idea: "x", index: 0 }], picks: {}, pain: "p" }];
  const calls = [], told = [];
  IO.env = { ANTHROPIC_API_KEY: "k" }; IO.out = () => {};
  IO.claude = { ...claude, client: async e => e.ANTHROPIC_API_KEY ? { api: {}, why: "" } : { api: null, why: "no ANTHROPIC_API_KEY" }, ask: async (_, p) => { calls.push(p); return { msg: { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(answers[calls.length - 1]) }] } }; } };
  IO.router = async () => ({ alert: async (lv, k) => told.push(`${lv} ${k}`), resolve: async p => told.push("resolve " + p.join("+")) });
  IO.tg = async () => ({ msg: o => o.title });
  IO.run = (cmd, args) => {
    if (args[0].endsWith("ideas.mjs")) { fs.writeFileSync(args[args.indexOf("--out") + 1], JSON.stringify(ideas)); ok(args.includes("--recall-since") && !args.includes("--gsc") && !args.includes("--camp"), "ideas: the recall baseline, never a private file"); return ""; }
    const cap = fs.readFileSync(path.join(args[1], "captions.json"), "utf8");
    if (cap.includes("מנצח")) { const e = new Error("1"); e.stdout = JSON.stringify({ violations: [{ rule: "banned", file: "captions.json", line: 1, en: "winner wording", snippet: "מנצח" }] }); throw e; }
    return JSON.stringify({ violations: [] });
  };
  const out = path.join(tmp, "out");
  await main({ factory: F, repo: tmp, out, date: "2026-11-05" });
  const d = path.join(out, "draft-2026-11-05");
  ok(calls.length === 2 && /winner wording/.test(calls[1].messages.at(-1).content), "a lint violation goes back to the model once, then the draft is clean");
  ok(JSON.parse(fs.readFileSync(path.join(d, "kit.json"))).kit === 4 && JSON.parse(fs.readFileSync(path.join(d, "facts.json"))).facts[0].text === "f0", "kit.json and facts.json written");
  ok(/Clean after 1 fix round/.test(fs.readFileSync(path.join(d, "draft.md"), "utf8")), "draft.md says the copy lint is clean");
  ok(told.includes("resolve ai:kitdraft+ai:key"), "a good run closes ai:kitdraft and ai:key");
  // an API error: no draft, the router hears it, the run stays green
  told.length = 0; calls.length = 0;
  IO.claude.ask = async () => ({ error: { why: "402 billing", key: true } });
  ok(await main({ factory: F, repo: tmp, out: path.join(tmp, "o2"), date: "2026-11-05" }) === 0 && told[0] === "day ai:key" && !fs.existsSync(path.join(tmp, "o2", "draft-2026-11-05")), "a spent credit: ai:key (day), no draft, green");
  IO.claude.ask = async () => ({ error: { why: "529 server", key: false } }); told.length = 0;
  await main({ factory: F, repo: tmp, out: path.join(tmp, "o3"), date: "2026-11-05" });
  ok(told[0] === "summary ai:kitdraft", "any other API error: ai:kitdraft (summary)");
  IO.env = { KIT_DRAFT: "off", ANTHROPIC_API_KEY: "k" }; told.length = 0;
  ok(await main({ factory: F, repo: tmp, out: path.join(tmp, "o4") }) === 0 && !told.length, "KIT_DRAFT=off skips quietly");
  IO.env = {};
  ok(await main({ factory: F, repo: tmp, out: path.join(tmp, "o5") }) === 0 && !fs.existsSync(path.join(tmp, "o5")), "no key: skips, writes nothing");
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`selftest: ${n - bad}/${n} passed`); process.exit(bad ? 1 : 0);
}

const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
if (a.includes("--selftest")) await selftest();
else if (process.argv[1] && process.argv[1].endsWith("kit-draft.mjs")) {
  try { process.exitCode = await main({ factory: opt("--factory"), repo: opt("--repo") || ".", catalog: opt("--catalog"), out: opt("--out") || "kit-draft-out", date: opt("--date") }); }
  catch (e) { IO.out(`::error title=Kit draft::it stopped on its own error (${String(e && e.message || e).replace(/\d[\d,.\-]{3,}\d/g, "#").slice(0, 160)})`); process.exitCode = 1; }
}
