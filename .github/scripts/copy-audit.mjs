// Weekly Hebrew copy audit (product thread; monthly API credit, Dudu 1.11.2026 21:16 "נלך על 2 החבילות"). Once a week one Claude call
// (Sonnet 5.5, structured output) reads every user-visible Hebrew text piece of the app and the site (index.html serves both), privacy.html,
// 404.html, the Play store listing and the current release notes, and flags what a user would read wrong:
//   mismatch   the same thing named or explained two different ways (app vs site, a screen vs the store listing, two screens)
//   promise    a promise the app no longer keeps, or a claim stronger than the data allows
//   certainty  a statement about data that may be incomplete said as a fact, where "ייתכן"/"לפי" belongs
//   gender     a form that speaks to one gender (the house style is neutral: plural or infinitive)
//   golden     a dealer, importer, maker or garage described as a villain (they are customers, never villains)
//   spelling   a Hebrew spelling or grammar mistake
// Machine check: a finding is kept only when its quote is found, as written, on the line it names in that file (so every point is tied to a
// line); a quote that looks like a licence plate is dropped. It suggests only: nothing here edits a file.
// Skip: when the text pieces are the same as at the last good run (a hash on the branch copy-audit), no call is sent.
// The output copy-audit.json goes to the branch copy-audit (public: it quotes public copy only). Findings go through the router as one quiet
// summary item copy:<YYYY-MM-DD> (owner: product); nothing found = no message. Fallback (claude.mjs): no key, no SDK, an API error or no valid
// answer leaves ok:false and why, and the run stays green; a failed call raises ai:copy (summary), the key or the credit ai:key (day); a good
// call closes both. The log is public: no cost, no token count.
//   node copy-audit.mjs              env: OUT (dir, default "out"), PREV (last copy-audit.json, optional), ROOT (repo, default "."), DRY=1, FORCE=1
//   node copy-audit.mjs --selftest   offline, through a fake API
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { client, ask, answer } from "./claude.mjs";

export const MODEL = "claude-sonnet-5-5", PROMPT_V = 1, MAX_FINDINGS = 30;
export const KINDS = ["mismatch", "promise", "certainty", "gender", "golden", "spelling"];
export const FILES = ["index.html", "privacy.html", "404.html", ".github/store-listing/title.txt", ".github/store-listing/short-description.txt",
  ".github/store-listing/full-description.txt", "android/release-notes.txt"];
const HEB = /[֐-׿]/;
const PLATE = /\b\d{2,3}-\d{2,3}-\d{2,3}\b|\b\d{7,8}\b/;

// the Hebrew text pieces of one file, by line: code and markup stay out, so the call reads the words only
export function pieces(src) {
  const out = [];
  String(src).split("\n").forEach((l, i) => {
    if (!HEB.test(l)) return;
    const parts = (l.match(/[^"`<>{}=;()[\]]*[֐-׿][^"`<>{}=;()[\]]*/g) || []).map(s => s.replace(/\$$/, "").replace(/\s+/g, " ").trim()).filter(s => s.length > 1);
    if (parts.length) out.push({ line: i + 1, text: [...new Set(parts)].join(" | ") });
  });
  return out;
}
export function corpus(root = ".") {
  const files = [];
  for (const f of FILES) { let src; try { src = fs.readFileSync(path.join(root, f), "utf8"); } catch { continue; } files.push({ file: f, src, pieces: pieces(src) }); }
  return files;
}
export const hash = files => crypto.createHash("sha256").update(PROMPT_V + JSON.stringify(files.map(f => [f.file, f.pieces]))).digest("hex").slice(0, 16);

export const SYSTEM = [
  "You review the Hebrew wording of לוחית (luchit.app), a free Israeli app and website that checks a car by its licence plate from the Ministry of Transport's open data (recalls, ownership history, the yearly test, specs) and alerts after purchase. The same page serves the Android app and the website.",
  "You get every user-visible Hebrew text piece, as file:line followed by the pieces on that line (separated by |). Code is left out, so a piece can be a fragment of a sentence built in code; judge only what a user would read.",
  "Report only real problems a user would notice, of these kinds:",
  "- mismatch: the same thing named or explained in two different ways (a screen vs another screen, the app vs the store listing). Quote one of the two and name the other in why.",
  "- promise: a promise the app does not keep or a claim stronger than the data allows (e.g. 'all recalls', 'always', 'guaranteed').",
  "- certainty: a statement about data that may be incomplete or late, said as a sure fact, where 'ייתכן' or 'לפי משרד התחבורה' belongs.",
  "- gender: a form that addresses one gender (masculine or feminine singular imperative or adjective toward the user). The house style is neutral: plural ('בדקו') or infinitive ('לבדוק'). Plural imperative is fine.",
  "- golden: a dealer, importer, maker, garage or seller described as hiding, cheating or to be feared. They are customers of the app, never villains; neutral facts are fine.",
  "- spelling: a Hebrew spelling or grammar mistake, or a word missing or doubled.",
  "Do not report: style preferences, a shorter way to say a correct thing, English technical words, fragments that are fine once code fills them, or anything you are not sure a native Hebrew reader would see as wrong.",
  "For each finding give: file and line exactly as given, quote = the exact text as it appears in that line (copy it, 2 to 80 characters, no '|'), kind, why (one short Hebrew sentence), fix (the corrected Hebrew text, or empty).",
  `At most ${MAX_FINDINGS} findings, most important first. An empty list is a good answer.`,
].join("\n");
export const SCHEMA = { type: "object", additionalProperties: false, required: ["findings"], properties: { findings: { type: "array", items: { type: "object", additionalProperties: false,
  required: ["file", "line", "quote", "kind", "why", "fix"], properties: { file: { type: "string" }, line: { type: "integer" }, quote: { type: "string" }, kind: { type: "string", enum: KINDS }, why: { type: "string" }, fix: { type: "string" } } } } } };
export const prompt = files => files.map(f => [`== ${f.file} ==`, ...f.pieces.map(p => `${f.file}:${p.line}: ${p.text}`)].join("\n")).join("\n\n");
export const params = (files, effort = "medium") => ({ model: MODEL, max_tokens: 12000, output_config: { effort, format: { type: "json_schema", schema: SCHEMA } },
  system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: prompt(files) }] });

const clean = (s, n) => String(s ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, n);
export function parse(text) { try { const o = JSON.parse(String(text || "")); return o && Array.isArray(o.findings) ? o : null; } catch { return null; } }
// a finding holds only when its quote is on the line it names, in that file, as written
export function check(o, files) {
  const by = new Map(files.map(f => [f.file, f.src.split("\n")])), keep = [], dropped = [];
  for (const x of o.findings.slice(0, MAX_FINDINGS * 2)) {
    const f = { file: clean(x.file, 80), line: Number(x.line) | 0, quote: String(x.quote ?? "").trim(), kind: KINDS.includes(x.kind) ? x.kind : "", why: clean(x.why, 200), fix: clean(x.fix, 200) };
    const lines = by.get(f.file), at = lines && lines[f.line - 1];
    const bad = !lines ? "file" : at == null ? "line" : !f.kind ? "kind" : f.quote.length < 2 || f.quote.length > 80 || f.quote.includes("|") ? "quote" : !at.includes(f.quote) ? "not on that line"
      : PLATE.test(f.quote + " " + f.fix) ? "plate-like" : !f.why ? "why" : "";
    if (bad) dropped.push(bad); else if (keep.length < MAX_FINDINGS && !keep.some(k => k.file === f.file && k.line === f.line && k.quote === f.quote)) keep.push(f);
  }
  return { findings: keep, dropped };
}

async function tell(router, err, env) {
  if (!router) return;
  let t = { tag: () => "", todo: () => "", folded: () => "" };
  try { t = await import("./tg-text.mjs"); } catch {}
  const text = err.key
    ? [t.tag("today", "bots"), "מפתח ה-Claude API לא עובד או שהקרדיט החודשי נגמר, ולכן בדיקת הנוסח השבועית לא רצה.", t.todo("לבדוק ב-Console של Anthropic שהמפתח פעיל ושנשאר קרדיט, או להדביק מחדש את ANTHROPIC_API_KEY ב-GitHub")].join("\n") + t.folded(err.why)
    : [t.tag("info", "bots"), "בדיקת הנוסח השבועית לא קיבלה הפעם תשובה מ-Claude. שרשור המוצר יבדוק בפעם הבאה.", t.todo()].join("\n") + t.folded(err.why);
  try { await router.alert(err.key ? "day" : "summary", err.key ? "ai:key" : "ai:copy", text, env.RUN_URL || "", { today: err.key ? "loud" : "silent", legacy: () => false }); } catch {}
}
async function settle(router) { if (!router) return; try { await router.resolve(["ai:copy"]); await router.resolve(["ai:key"]); } catch {} }

const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const KIND_HE = { mismatch: "לא אחיד", promise: "הבטחה", certainty: "ודאות", gender: "פנייה במגדר", golden: "כלל הזהב", spelling: "כתיב" };
export function findingsText(rep, link = "") {
  const show = rep.findings.slice(0, 8).map(f => `• <b>${KIND_HE[f.kind]}</b> ${esc(f.file)}:${f.line} «${esc(f.quote)}»: ${esc(f.why)}${f.fix ? ` ← ${esc(f.fix)}` : ""}`);
  return ["<b>📝 לידיעה · אפליקציה</b>", `בדיקת הנוסח השבועית מצאה ${rep.findings.length === 1 ? "נקודה אחת" : rep.findings.length + " נקודות"} בנוסח של האפליקציה והאתר:`, ...show,
    rep.findings.length > 8 ? `ועוד ${rep.findings.length - 8} בקובץ copy-audit.json בענף copy-audit.` : "", "👌 לא צריך לעשות כלום: שרשור המוצר יתקן מה שנכון."].filter(Boolean).join("\n");
}

export async function run({ env = process.env, api, router, log = console.log, now = new Date() } = {}) {
  const out = env.OUT || "out", files = corpus(env.ROOT || ".");
  let prev = null; try { prev = JSON.parse(fs.readFileSync(env.PREV || "", "utf8")); } catch {}
  const rep = { v: 1, when: now.toISOString(), model: MODEL, prompt: PROMPT_V, hash: hash(files), ok: false, why: "", skipped: false, findings: [], dropped: 0, pieces: files.reduce((n, f) => n + f.pieces.length, 0) };
  const done = () => { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, "copy-audit.json"), JSON.stringify(rep, null, 1) + "\n");
    log(rep.ok ? `copy audit ok: ${rep.findings.length} finding(s), ${rep.dropped} not tied to their line dropped` : rep.skipped ? "copy audit skipped: the texts did not change since the last good run" : `copy audit skipped: ${rep.why}`); return rep; };
  if (!files.length || !rep.pieces) { rep.why = "no files"; return done(); }
  if (env.DRY === "1") { rep.why = "dry run"; return done(); }
  if (prev && prev.ok && prev.hash === rep.hash && env.FORCE !== "1") { Object.assign(rep, { ok: true, skipped: true, findings: prev.findings || [], when: prev.when }); return done(); }
  if (router === undefined) router = await import("./alert.mjs").catch(() => null);
  if (api === undefined) { const c = await client(env, { timeout: 10 * 60000 }); api = c.api; if (!api) { rep.why = c.why; if (!/ANTHROPIC_API_KEY/.test(c.why)) await tell(router, { why: c.why, key: false }, env); return done(); } }
  const r = await ask(api, params(files));
  if (r.error) { rep.why = r.error.why; await tell(router, r.error, env); return done(); }
  const a = answer(r.msg), o = parse(a.text);
  if (!o) { rep.why = a.why || "no valid JSON"; await tell(router, { why: rep.why, key: false }, env); return done(); }
  const c = check(o, files);
  Object.assign(rep, { ok: true, findings: c.findings, dropped: c.dropped.length });
  await settle(router);
  if (router && rep.findings.length) { try { await router.alert("summary", "copy:" + rep.when.slice(0, 10), findingsText(rep), env.RUN_URL || "", { today: "silent", legacy: () => false }); } catch {} }
  return done();
}

if (process.argv[1] && process.argv[1].endsWith("copy-audit.mjs")) {
  if (!process.argv.includes("--selftest")) await run();
  else {
    const os = await import("node:os");
    let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copy-"));
    const root = path.join(tmp, "repo"); fs.mkdirSync(path.join(root, ".github/store-listing"), { recursive: true });
    fs.writeFileSync(path.join(root, "index.html"), ['<div class="t">בדוק את הרכב</div>', 'const a = "הבדיקה תמצא את כל הריקולים", b = `נבדק ${n} פעמים`;', "const x = 1;", '<p>הסוחר מסתיר ממך מידע</p>'].join("\n"));
    fs.writeFileSync(path.join(root, ".github/store-listing/short-description.txt"), "בדיקת רכב לפי מספר רישוי\n");
    const files = corpus(root);
    ok(files.length === 2 && files[0].pieces.length === 3 && files[0].pieces[0].text === "בדוק את הרכב" && !/const|class/.test(prompt(files)), "the Hebrew pieces by line, without code or markup");
    ok(files[0].pieces[1].text === "הבדיקה תמצא את כל הריקולים | נבדק | פעמים" && files[0].pieces[1].line === 2, "the pieces of one line (around code too), the line number kept");
    const json = o => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(o) }] });
    const F = (file, line, quote, kind = "gender", fix = "") => ({ file, line, quote, kind, why: "סיבה", fix });
    const four = { findings: [F("index.html", 1, "בדוק את הרכב", "gender", "בדקו את הרכב"), F("index.html", 2, "את כל הריקולים", "promise"), F("index.html", 1, "הסוחר מסתיר", "golden"),
      F("index.html", 4, "הסוחר מסתיר ממך", "golden"), F("index.html", 4, "הסוחר מסתיר ממך", "golden"), F("x.html", 1, "abc"), F("index.html", 1, "בדוק", "nope"), F("index.html", 1, "בדוק", "spelling", "12-345-67")] };
    const fake = (replies, sent = []) => ({ messages: { create: async p => { sent.push(JSON.parse(JSON.stringify(p))); const r = replies.shift(); if (r instanceof Error) throw r; return r; } } });
    const calls = [], router = { alert: async (lv, key, text) => { calls.push(["alert", lv, key, text]); return { delivered: true }; }, resolve: async p => { calls.push(["resolve", p[0]]); return 0; } };
    const quiet = () => {}, now = new Date("2026-11-09T05:41:00Z");
    let sent = [];
    let r = await run({ env: { OUT: path.join(tmp, "1"), ROOT: root }, api: fake([json(four)], sent), router, log: quiet, now });
    ok(r.ok && r.findings.length === 3 && r.dropped === 4, "kept only when the quote is on the named line of a known file, with a known kind; a duplicate is dropped too");
    ok(r.findings.every(f => f.kind) && r.findings.some(f => f.kind === "golden" && f.line === 4) && !r.findings.some(f => f.line === 1 && f.kind === "golden"), "a quote from another line does not count");
    ok(!JSON.stringify(r.findings).includes("12-345-67"), "a plate-like text never reaches the file or the message");
    ok(sent[0].model === MODEL && sent[0].output_config.format.type === "json_schema" && sent[0].output_config.effort === "medium" && sent[0].system[0].cache_control, "Sonnet 5.5, structured output, medium effort, cached rules");
    ok(calls.some(c => c[0] === "resolve" && c[1] === "ai:copy") && calls.some(c => c[0] === "alert" && c[1] === "summary" && c[2] === "copy:2026-11-09" && /בדקו את הרכב/.test(c[3]) && /index\.html:1/.test(c[3])), "one quiet copy:<date> item with each point's file:line and fix; a good call closes ai:copy");
    fs.writeFileSync(path.join(tmp, "prev.json"), JSON.stringify(r));
    calls.length = 0; sent = [];
    r = await run({ env: { OUT: path.join(tmp, "2"), ROOT: root, PREV: path.join(tmp, "prev.json") }, api: fake([json(four)], sent), router, log: quiet, now });
    ok(r.ok && r.skipped && sent.length === 0 && calls.length === 0 && r.findings.length === 3, "the same texts as the last good run: no call, no message");
    r = await run({ env: { OUT: path.join(tmp, "3"), ROOT: root, PREV: path.join(tmp, "prev.json"), FORCE: "1" }, api: fake([json({ findings: [] })], sent), router, log: quiet, now });
    ok(r.ok && !r.skipped && sent.length === 1 && !calls.some(c => c[0] === "alert"), "FORCE sends anyway; nothing found = no message");
    calls.length = 0;
    r = await run({ env: { OUT: path.join(tmp, "4"), ROOT: root }, api: fake([{ stop_reason: "end_turn", content: [{ type: "text", text: "sorry" }] }]), router, log: quiet, now });
    ok(!r.ok && r.why === "no valid JSON" && calls.some(c => c[2] === "ai:copy" && c[1] === "summary"), "no valid answer: ai:copy quietly");
    calls.length = 0;
    r = await run({ env: { OUT: path.join(tmp, "5"), ROOT: root }, api: fake([Object.assign(new Error("x"), { status: 400, error: { error: { type: "invalid_request_error", message: "Your credit balance is too low" } } })]), router, log: quiet, now });
    ok(!r.ok && calls.some(c => c[2] === "ai:key" && c[1] === "day"), "the credit ran out: ai:key");
    calls.length = 0;
    r = await run({ env: { OUT: path.join(tmp, "6"), ROOT: root, ANTHROPIC_API_KEY: "" }, router, log: quiet, now });
    ok(!r.ok && /ANTHROPIC_API_KEY/.test(r.why) && calls.length === 0, "no key: switched off on purpose, nothing raised");
    ok((await run({ env: { OUT: path.join(tmp, "7"), ROOT: root, DRY: "1" }, router, log: quiet, now })).why === "dry run", "dry run: no call");
    const lines = []; await run({ env: { OUT: path.join(tmp, "8"), ROOT: root }, api: fake([json(four)]), router, log: l => lines.push(l), now });
    ok(lines.length === 1 && !/\$|token|usd/i.test(lines[0]) && JSON.parse(fs.readFileSync(path.join(tmp, "8", "copy-audit.json"), "utf8")).findings.length === 3, "one log line, no cost or token count; copy-audit.json written");
    const real = corpus("."); ok(real.length >= 5 && real[0].file === "index.html" && real[0].pieces.length > 500 && prompt(real).length < 160000, "the real repo: every file read, the prompt within its size");
    console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
  }
}
