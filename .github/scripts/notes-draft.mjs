// Release-notes drafter (product thread; monthly API credit, Dudu 1.11.2026 21:16 "נלך על 2 החבילות"). When a release-* branch is pushed and
// android/release-notes.txt does not yet carry that branch's APP_VERSION, one Claude call (Sonnet 5.5, structured output) turns the branch's
// commits since main into a Hebrew draft of the Google Play release notes, plus suggested lines for the store's full description. It only
// drafts: nothing here edits the release branch. The draft goes to the branch release-drafts (notes-<version>.txt, the exact file to copy)
// and through the router as one quiet item notes:<version> (owner: product), which edits it before "שחרר".
// Machine check (the same rules Ship tail applies, parseNotes of play-alpha.mjs, plus the house rules): "# <version>" then bullets that start
// with "• ", at most 500 characters, Hebrew, no internal names (threads, bots, branches, files, tools), no plate-like number, no Latin word
// except the few a user knows (Android, Google Play, PDF, WhatsApp). A draft that breaks a rule goes back once with what it broke.
// Fallback (claude.mjs): no key, no SDK, an API error or no draft that passes leaves ok:false and why, and the run stays green; the thread
// writes the notes by hand as before. A failed call raises ai:notes (summary), the key or the credit ai:key (day); a good call closes both.
// The log is public: no cost, no token count.
//   node notes-draft.mjs             env: OUT (dir), ROOT (repo, default "."), BASE (default origin/main), DRY=1, FORCE=1 (draft even when written)
//   node notes-draft.mjs --selftest  offline, through a fake API
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { client, ask, answer } from "./claude.mjs";
import { parseNotes, NOTES_MAX } from "./play-alpha.mjs";

export const MODEL = "claude-sonnet-5-5", TRIES = 2, LOG_MAX = 14000;
const HEB = /[֐-׿]/, PLATE = /\b\d{2,3}-\d{2,3}-\d{2,3}\b|\b\d{7,8}\b/;
const LATIN_OK = new Set(["android", "google", "play", "pdf", "whatsapp", "iphone"]);
// words that belong to how the app is built, never to a user's notes
const INTERNAL = /שרשור|בוט|ענף|גרסת בדיקה|קומיט|סלפטסט|thread|branch|commit|guardian|worker|selftest|lint|\.mjs|\.yml|\.json|\.html|ga4|router|next|main|claude|probe/i;

export const version = html => (/const APP_VERSION = "([^"]+)"/.exec(html) || [])[1] || "";
export function commits(root, base) {
  let raw = "";
  try { raw = execFileSync("git", ["-C", root, "log", "--no-merges", "--format=%s%n%b%x00", `${base}..HEAD`], { encoding: "utf8", maxBuffer: 1 << 24 }); } catch { return ""; }
  return raw.split("\0").map(c => c.split("\n").filter(l => !/^(Co-Authored-By|Claude-Session|Signed-off-by):/i.test(l.trim())).join("\n").trim()).filter(Boolean)
    .join("\n---\n").replace(/\b\d{2,3}-\d{2,3}-\d{2,3}\b/g, "#").slice(0, LOG_MAX);
}

export const SYSTEM = [
  "You write the Google Play release notes, in Hebrew, for לוחית: a free Israeli app that checks a car by its licence plate from the Ministry of Transport's open data and alerts after purchase.",
  "You get the developers' commit messages since the last release (English, technical). Turn what a user will notice into short Hebrew bullets.",
  "Rules:",
  `- At most ${NOTES_MAX} characters in all, 4 to 9 bullets, each under 90 characters, most noticeable first. Merge small fixes into one bullet such as 'תיקונים ושיפורים קטנים'.`,
  "- The user's language: what they see or can now do. Never internal names: no threads, bots, branches, files, tests, tools, analytics, servers, code words.",
  "- Neutral Hebrew forms (no masculine or feminine address to the user). Calm and factual, no hype, no exclamation marks.",
  "- Dealers, importers, makers and garages are never villains.",
  "- No English words except Android, Google Play, PDF, WhatsApp. No numbers that look like a licence plate.",
  "- Changes the user cannot see (bots, tests, internal checks, analytics, the website's tooling) are left out.",
  "Also suggest up to 4 lines for the store's full description that name a NEW user-visible feature (empty when none), and list in left_out what you left out, in short English.",
].join("\n");
export const SCHEMA = { type: "object", additionalProperties: false, required: ["bullets", "store_lines", "left_out"], properties: {
  bullets: { type: "array", items: { type: "string" } }, store_lines: { type: "array", items: { type: "string" } }, left_out: { type: "array", items: { type: "string" } } } };
export const prompt = ({ ver, log, prevNotes, description }) => [`Version: ${ver}`, "", "== Commits since the last release ==", log || "(none)", "",
  "== The last release notes (for the tone and length) ==", prevNotes || "(none)", "", "== The store's full description today ==", (description || "").slice(0, 4000)].join("\n");

const latin = t => (String(t).match(/[A-Za-z]+/g) || []).filter(w => !LATIN_OK.has(w.toLowerCase()));
// the file text, and what is wrong with it ([] = it passes)
export function build(o, ver) {
  const bullets = (o.bullets || []).map(b => String(b).replace(/^[•\-*\s]+/, "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const file = `# ${ver}\n` + bullets.map(b => "• " + b).join("\n") + "\n";
  const errs = [], p = parseNotes(file, ver);
  if (!p.ok) errs.push(p.code === "long" ? `too long: ${p.n} characters, at most ${NOTES_MAX}` : `format: ${p.code}`);
  if (bullets.length < 1 || bullets.length > 10) errs.push(`${bullets.length} bullets, 1 to 10 allowed`);
  bullets.forEach((b, i) => {
    if (!HEB.test(b)) errs.push(`bullet ${i + 1} is not Hebrew`);
    if (INTERNAL.test(b)) errs.push(`bullet ${i + 1} names something internal: ${(INTERNAL.exec(b) || [""])[0]}`);
    if (latin(b).length) errs.push(`bullet ${i + 1} has English words: ${latin(b).join(", ")}`);
    if (PLATE.test(b)) errs.push(`bullet ${i + 1} has a plate-like number`);
    if (b.includes("!")) errs.push(`bullet ${i + 1} has an exclamation mark`);
  });
  const store = (o.store_lines || []).map(s => String(s).replace(/\s+/g, " ").trim()).filter(s => s && HEB.test(s) && !INTERNAL.test(s) && !PLATE.test(s) && !latin(s).length).slice(0, 4);
  return { file, bullets, store, errs, n: p.n || 0 };
}

async function tell(router, err, env) {
  if (!router) return;
  let t = { tag: () => "", todo: () => "", folded: () => "" };
  try { t = await import("./tg-text.mjs"); } catch {}
  const text = err.key
    ? [t.tag("today", "bots"), "מפתח ה-Claude API לא עובד או שהקרדיט החודשי נגמר, ולכן טיוטת הערות השחרור לא נכתבה.", t.todo("לבדוק ב-Console של Anthropic שהמפתח פעיל ושנשאר קרדיט, או להדביק מחדש את ANTHROPIC_API_KEY ב-GitHub")].join("\n") + t.folded(err.why)
    : [t.tag("info", "bots"), "טיוטת הערות השחרור לא נכתבה הפעם. שרשור המוצר יכתוב אותן בעצמו, כמו קודם.", t.todo()].join("\n") + t.folded(err.why);
  try { await router.alert(err.key ? "day" : "summary", err.key ? "ai:key" : "ai:notes", text, env.RUN_URL || "", { today: err.key ? "loud" : "silent", legacy: () => false }); } catch {}
}
const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const draftText = rep => ["<b>📝 לידיעה · חנות Google Play</b>", `טיוטה להערות השחרור של ${esc(rep.version)} (${rep.n} תווים), לבדיקה לפני "שחרר":`,
  ...rep.bullets.map(b => "• " + esc(b)), rep.store.length ? "שורות מוצעות לתיאור בחנות:\n" + rep.store.map(s => "◦ " + esc(s)).join("\n") : "",
  "👌 לא צריך לעשות כלום: שרשור המוצר יעבור על הטיוטה."].filter(Boolean).join("\n");

export async function run({ env = process.env, api, router, log = console.log, now = new Date() } = {}) {
  const out = env.OUT || "out", root = env.ROOT || ".";
  const read = f => { try { return fs.readFileSync(path.join(root, f), "utf8"); } catch { return ""; } };
  const ver = version(read("index.html")), notes = read("android/release-notes.txt");
  const rep = { v: 1, when: now.toISOString(), model: MODEL, version: ver, ok: false, why: "", skipped: false, n: 0, bullets: [], store: [], left_out: [], file: "", tries: 0 };
  const done = () => { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, "notes-draft.json"), JSON.stringify(rep, null, 1) + "\n");
    if (rep.ok) fs.writeFileSync(path.join(out, `notes-${ver}.txt`), rep.file);
    log(rep.ok ? `notes draft ok: ${rep.bullets.length} bullet(s), ${rep.tries} call(s)` : `notes draft skipped: ${rep.why}`); return rep; };
  if (!ver) { rep.why = "no APP_VERSION"; return done(); }
  if (parseNotes(notes, ver).ok && env.FORCE !== "1") { rep.skipped = true; rep.why = "the notes for this version are already written"; return done(); }
  const log0 = commits(root, env.BASE || "origin/main");
  if (!log0) { rep.why = "no commits since main"; return done(); }
  if (env.DRY === "1") { rep.why = "dry run"; return done(); }
  if (router === undefined) router = await import("./alert.mjs").catch(() => null);
  if (api === undefined) { const c = await client(env, { timeout: 5 * 60000 }); api = c.api; if (!api) { rep.why = c.why; if (!/ANTHROPIC_API_KEY/.test(c.why)) await tell(router, { why: c.why, key: false }, env); return done(); } }
  let prevNotes = ""; try { prevNotes = execFileSync("git", ["-C", root, "show", `${env.BASE || "origin/main"}:android/release-notes.txt`], { encoding: "utf8" }); } catch {}
  const messages = [{ role: "user", content: prompt({ ver, log: log0, prevNotes: prevNotes.split("\n").filter(l => !l.startsWith("#")).join("\n"), description: read(".github/store-listing/full-description.txt") }) }];
  let b = null;
  for (let i = 0; i < TRIES; i++) {
    rep.tries = i + 1;
    const r = await ask(api, { model: MODEL, max_tokens: 3000, output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } }, system: SYSTEM, messages });
    if (r.error) { rep.why = r.error.why; await tell(router, r.error, env); return done(); }
    const a = answer(r.msg); let o = null; try { o = JSON.parse(a.text); } catch {}
    if (!o) { rep.why = a.why || "no valid JSON"; continue; }
    b = build(o, ver); rep.left_out = (o.left_out || []).map(s => String(s).slice(0, 120)).slice(0, 20);
    if (!b.errs.length) break;
    rep.why = b.errs.slice(0, 3).join("; ");
    messages.push({ role: "assistant", content: a.text }, { role: "user", content: "That draft breaks these rules, fix them and answer again: " + b.errs.join("; ") });
  }
  if (!b || b.errs.length) { await tell(router, { why: rep.why || "no draft", key: false }, env); return done(); }
  Object.assign(rep, { ok: true, why: "", n: b.file.length - `# ${ver}\n`.length - 1, bullets: b.bullets, store: b.store, file: b.file });
  if (router) { try { await router.resolve(["ai:notes"]); await router.resolve(["ai:key"]); await router.alert("summary", "notes:" + ver, draftText(rep), env.RUN_URL || "", { today: "silent", legacy: () => false }); } catch {} }
  return done();
}

if (process.argv[1] && process.argv[1].endsWith("notes-draft.mjs")) {
  if (!process.argv.includes("--selftest")) await run();
  else {
    const os = await import("node:os");
    let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "notes-")), root = path.join(tmp, "repo");
    const g = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });
    fs.mkdirSync(path.join(root, "android"), { recursive: true });
    fs.writeFileSync(path.join(root, "index.html"), 'const APP_VERSION = "1.38.3";\n');
    fs.writeFileSync(path.join(root, "android/release-notes.txt"), "# 1.38.3\n• שורה קודמת\n");
    execFileSync("git", ["init", "-q", "-b", "main", root]); g("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"); g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
    g("branch", "base");
    fs.writeFileSync(path.join(root, "index.html"), 'const APP_VERSION = "1.39";\n');
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "Car page: the recall card folds its explanation (plate 12-345-67 in a test)\n\nCo-Authored-By: x\nClaude-Session: y");
    const l = commits(root, "base");
    ok(/recall card folds/.test(l) && !/Co-Authored|Claude-Session|12-345-67/.test(l), "the commits since main, without attribution lines or a plate");
    ok(version('x\nconst APP_VERSION = "1.39";') === "1.39", "APP_VERSION read from index.html");
    const good = { bullets: ["הסבר קצר לכל ריקול, בלחיצה על \"מה זה אומר?\"", "תיקונים ושיפורים קטנים"], store_lines: ["הסבר פשוט לכל ריקול", "uses Claude"], left_out: ["bots"] };
    ok(!build(good, "1.39").errs.length && build(good, "1.39").file === "# 1.39\n• הסבר קצר לכל ריקול, בלחיצה על \"מה זה אומר?\"\n• תיקונים ושיפורים קטנים\n" && build(good, "1.39").store.length === 1, "a good draft: the exact file, the store line in English dropped");
    const errs = build({ bullets: ["שיפור בבוט הריקולים", "New Recall screen", "הרכב 12-345-67 נבדק", "מעולה!", "ש".repeat(520)] }, "1.39").errs.join(" | ");
    ok(/too long/.test(errs) && /internal/.test(errs) && /English/.test(errs) && /plate/.test(errs) && /exclamation/.test(errs) && /not Hebrew/.test(errs), "every rule: length, internal words, English, plates, exclamation, Hebrew");
    const json = o => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(o) }] });
    const fake = (replies, sent = []) => ({ messages: { create: async p => { sent.push(JSON.parse(JSON.stringify(p))); const r = replies.shift(); if (r instanceof Error) throw r; return r; } } });
    const calls = [], router = { alert: async (lv, key, text) => { calls.push(["alert", lv, key, text]); }, resolve: async p => { calls.push(["resolve", p[0]]); } };
    const quiet = () => {}, env = n => ({ OUT: path.join(tmp, String(n)), ROOT: root, BASE: "base" });
    let sent = [];
    let r = await run({ env: env(1), api: fake([json({ bullets: ["שיפור בבוט"] }), json(good)], sent), router, log: quiet });
    ok(r.ok && r.tries === 2 && sent.length === 2 && /internal/.test(sent[1].messages.at(-1).content) && sent[1].messages.length === 3, "a draft that breaks a rule goes back once with what it broke");
    ok(sent[0].model === MODEL && sent[0].output_config.format.type === "json_schema" && /recall card folds/.test(sent[0].messages[0].content) && /שורה קודמת/.test(sent[0].messages[0].content), "Sonnet 5.5, structured output; the commits and the last notes in the prompt");
    ok(fs.readFileSync(path.join(tmp, "1", "notes-1.39.txt"), "utf8") === build(good, "1.39").file && calls.some(c => c[1] === "summary" && c[2] === "notes:1.39" && /מה זה אומר/.test(c[3])), "the file to copy, and one quiet notes:<version> item with the draft");
    calls.length = 0;
    r = await run({ env: env(2), api: fake([json({ bullets: ["שיפור בבוט"] }), json({ bullets: ["New"] })]), router, log: quiet });
    ok(!r.ok && calls.some(c => c[2] === "ai:notes" && c[1] === "summary") && !fs.existsSync(path.join(tmp, "2", "notes-1.39.txt")), "no draft that passes after two tries: no file, ai:notes quietly");
    calls.length = 0;
    r = await run({ env: env(3), api: fake([Object.assign(new Error("x"), { status: 401 })]), router, log: quiet });
    ok(!r.ok && calls.some(c => c[2] === "ai:key" && c[1] === "day"), "a refused key: ai:key");
    fs.writeFileSync(path.join(root, "android/release-notes.txt"), "# 1.39\n• כבר נכתב\n");
    sent = [];
    r = await run({ env: env(4), api: fake([json(good)], sent), router, log: quiet });
    ok(r.skipped && sent.length === 0, "notes already written for this version: no call");
    r = await run({ env: { ...env(5), FORCE: "1", DRY: "1" }, router, log: quiet });
    ok(!r.ok && r.why === "dry run", "FORCE drafts anyway; dry run: no call");
    r = await run({ env: { ...env(6), FORCE: "1", ANTHROPIC_API_KEY: "" }, router, log: quiet });
    ok(!r.ok && /ANTHROPIC_API_KEY/.test(r.why), "no key: switched off on purpose");
    const lines = []; fs.writeFileSync(path.join(root, "android/release-notes.txt"), "# 1.38.3\n• x\n");
    await run({ env: env(7), api: fake([json(good)]), router, log: x => lines.push(x) });
    ok(lines.length === 1 && !/\$|token|usd/i.test(lines[0]), "one log line, no cost or token count");
    console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
  }
}
